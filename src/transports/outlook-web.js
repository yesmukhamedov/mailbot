// Транспорт через веб-интерфейс Outlook под управлением Playwright.
//
// Нужен там, где протоколы закрыты: у тенантов Microsoft 365 basic-аутентификация для IMAP
// отключена с 2022 года, а OAuth требует согласия администратора; у личных outlook.com пароли
// приложений отключены с сентября 2024. Браузер остаётся единственным путём.
//
// Медленнее SMTP на порядок, поэтому сессия открывается один раз на всю пачку писем,
// а не на каждое письмо, как было в первой версии.

const { chromium } = require('playwright-core');
const { normalizeOutgoing } = require('../message');

// Microsoft постепенно переводит веб-Outlook с outlook.office.com на outlook.cloud.microsoft,
// причём редирект срабатывает не всегда. Считаем почтой любой из известных доменов.
const MAIL_HOST_RE =
  /^https:\/\/outlook\.(office\.com|cloud\.microsoft|office365\.com|live\.com)\/mail/;

// Служебные подписи из разметки списка, которые не относятся к содержимому письма.
const NOISE = [
  /^свернуто$/i,
  /^развернуто$/i,
  /^collapsed$/i,
  /^expanded$/i,
  /^есть вложения$/i,
  /^has attachments$/i,
  /^беседы не выбраны$/i,
  /^no conversations selected$/i,
  /^непрочитанное$/i,
  /^unread$/i,
  /^\d+$/,
];

// Дата в списке выглядит как «12:48», «Пт, 12:48», «16.08.2026», «Mon 12:48».
const DATE_RE = /^(?:[^\s,]{2,4},?\s*)?(?:\d{1,2}[.:/]\d{2}(?:[.:/]\d{2,4})?)$/;

// Строка запроса для deeplink-компоуза.
//
// Собираем вручную: URLSearchParams кодирует пробел как «+» по правилам веб-формы,
// а Outlook такую ссылку понимает буквально — плюсы попадают прямо в тему письма.
// encodeURIComponent даёт %20, который разбирается правильно.
function composeQuery(m) {
  return [
    ['to', m.to.join(';')],
    ['cc', m.cc.join(';')],
    ['bcc', m.bcc.join(';')],
    ['subject', m.subject],
    ['body', m.text],
  ]
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

class OutlookWebTransport {
  constructor(account) {
    this.account = account;
    this.ctx = null;
    this.page = null;
  }

  capabilities() {
    return {
      send: true,
      list: true,
      fetch: false, // полное тело требует открытия каждого письма — пока не реализовано
      search: false,
      html: false, // точка расширения
      attachments: true,
    };
  }

  async launch({ headless = true } = {}) {
    this.ctx = await chromium.launchPersistentContext(this.account.profile, {
      channel: 'chrome',
      headless,
      viewport: { width: 1440, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    this.page = this.ctx.pages()[0] || (await this.ctx.newPage());
    return this.page;
  }

  // Считает, что почта открыта, когда в списке появились письма или кнопка «Создать».
  // Во время входа страница часто редиректит, поэтому любые ошибки evaluate = «ещё не вошли».
  async isSignedIn() {
    try {
      if (!this.page || this.page.isClosed() || !MAIL_HOST_RE.test(this.page.url())) return false;
      return await this.page.evaluate(
        () =>
          document.querySelectorAll('[role="option"]').length > 0 ||
          !!document.querySelector('[aria-label*="New mail" i],[aria-label*="Создать" i]')
      );
    } catch {
      return false;
    }
  }

  async open() {
    if (!this.page) await this.launch({ headless: true });
    await this.page.goto(this.account.mailUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    for (let i = 0; i < 40; i++) {
      if (await this.isSignedIn()) return this;
      await this.page.waitForTimeout(1500);
    }
    const url = this.page.url();
    await this.close();
    const err = new Error(
      `Ящик «${this.account.name}»: сессия истекла или входа не было. ` +
        `Выполните \`mailbot login ${this.account.name}\`. Последний адрес: ${url}`
    );
    err.code = 'NOT_SIGNED_IN';
    throw err;
  }

  // Строит адрес внутри почты на том домене, куда нас в итоге пустили,
  // иначе переход на другой домен снова ловит редирект.
  mailUrl(suffix) {
    let origin;
    try {
      origin = new URL(this.page.url()).origin;
    } catch {
      origin = new URL(this.account.mailUrl).origin;
    }
    return origin + '/mail/' + suffix;
  }

  // Разовый вход руками: видимое окно, пароль вводит пользователь, сессия остаётся в профиле.
  async login({ timeoutMs = 12 * 60 * 1000 } = {}) {
    await this.launch({ headless: false });
    await this.page.goto(this.account.mailUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isSignedIn()) {
        await this.page.waitForTimeout(4000); // дать докатиться записи профиля на диск
        await this.close();
        return true;
      }
      await this.page.waitForTimeout(2000);
    }
    await this.close();
    return false;
  }

  // Прикрепление файлов к открытому черновику.
  //
  // Два пути, потому что разметка компоуза непостоянна: обычно в ней есть скрытый
  // input[type=file], в который файл кладётся напрямую; если его нет, открываем меню
  // «Вложить файл → Обзор на этом компьютере» и перехватываем системный диалог.
  // На больших файлах веб-Outlook перебивает вложение вопросом «Как вы хотите
  // поделиться этими файлами?» и до ответа держит модальное окно, которое перехватывает
  // клик по «Отправить». Отвечаем сами: копией — вложение как есть, ссылкой — файл
  // уезжает в OneDrive, и лимит письма перестаёт действовать.
  async resolveShareDialog(mode) {
    const dialog = this.page.locator('[role="dialog"]').filter({
      hasText: /поделиться этими файлами|share these files|Вложить как копию|Attach as a copy/i,
    });
    if (!(await dialog.count())) return null;

    const choice =
      mode === 'onedrive'
        ? /как ссылками на OneDrive|OneDrive links|Upload and share/i
        : /Вложить как копию|Attach as a copy|Attach a copy/i;
    const option = dialog.first().locator('button, [role="menuitem"], [role="button"]').filter({
      hasText: choice,
    });
    await option.first().click({ timeout: 30000 });
    await dialog.first().waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {});
    return mode;
  }

  // В компоузе веб-Outlook несколько input[type=file], и первый из них —
  // инлайновая вставка картинки: у него accept ограничен изображениями, и PDF
  // туда не проходит («Файлы не были вставлены, так как не относятся
  // к поддерживаемым типам изображений»). Берём первый input, который принимает
  // произвольный файл, а не картинку.
  async pickFileInput() {
    const inputs = this.page.locator('input[type="file"]');
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const el = inputs.nth(i);
      const accept = (await el.getAttribute('accept')) || '';
      if (!/image|\.png|\.jpe?g|\.gif|\.bmp|\.dib|\.jfif/i.test(accept)) return el;
    }
    return null;
  }

  async attachFiles(files, { timeoutMs = 5 * 60 * 1000, mode = 'copy' } = {}) {
    const paths = files.map((f) => f.path);
    const input = await this.pickFileInput();

    if (input) {
      await input.setInputFiles(paths);
    } else {
      const attachBtn = this.page
        .locator(
          'button[aria-label*="Attach" i], button[aria-label*="Вложить" i], ' +
            'button[aria-label*="Прикрепить" i], button:has-text("Attach"), ' +
            'button:has-text("Вложить")'
        )
        .first();
      await attachBtn.waitFor({ state: 'visible', timeout: 30000 });
      await attachBtn.click();
      const browse = this.page
        .locator(
          '[role="menuitem"]:has-text("computer"), [role="menuitem"]:has-text("компьютер"), ' +
            '[role="menuitem"]:has-text("устройств"), [role="menuitem"]:has-text("device")'
        )
        .first();
      const [chooser] = await Promise.all([
        this.page.waitForEvent('filechooser', { timeout: 60000 }),
        browse.click(),
      ]);
      await chooser.setFiles(paths);
    }

    // Вопрос про способ вложения появляется не сразу и не всегда — ждём его недолго
    // и идём дальше, если файлы вложились без вопросов.
    for (let i = 0; i < 15; i++) {
      if (await this.resolveShareDialog(mode)) break;
      await this.page.waitForTimeout(1000);
    }

    // Отправлять можно только после того, как файл долит на сервер. Признак загрузки —
    // индикатор прогресса; признак готовности — имя файла в разметке письма.
    //
    // Имя в плитке вложения Outlook усекает посередине («FULL_DISSER…14.pdf»), поэтому
    // сверяем не всё имя, а его начало — этого хватает, чтобы отличить наши файлы.
    // Отказ Outlook вложить файл виден баннером, и в этом баннере перечислены
    // те же имена файлов. Если искать имена по всему innerText, баннер об отказе
    // сам себя и подтвердит — проверка пройдёт на тексте, который говорит, что
    // файлы отвергнуты. Поэтому: сначала ловим баннер и падаем, потом ищем имена
    // в разметке, вычтя из неё текст всех алертов.
    const rejected = await this.attachmentRejection();
    if (rejected) {
      throw new Error(
        'Веб-Outlook отказался вложить файлы: ' + rejected + ' ' +
          'Похоже, файлы ушли в поле вставки изображения, а не во вложения. ' +
          'Проверьте pickFileInput() — разметка компоуза могла измениться.'
      );
    }

    const marks = files.map((f) => f.name.slice(0, 10));
    try {
      await this.page.waitForFunction(
        (names) => {
          // Индикатор загрузки Fluent UI не всегда объявляет role="progressbar" —
          // у плитки вложения это полоска с классом ProgressBar. Ищем оба вида.
          const busy = document.querySelector(
            'progress, [role="progressbar"], [class*="ProgressBar"], [class*="progressBar"]'
          );
          let text = document.body.innerText;
          for (const a of document.querySelectorAll(
            '[role="alert"], [class*="MessageBar"], [class*="messageBar"]'
          )) {
            if (a.innerText) text = text.split(a.innerText).join(' ');
          }
          return !busy && names.every((n) => text.includes(n));
        },
        marks,
        { timeout: timeoutMs, polling: 2000 }
      );
    } catch {
      const late = await this.attachmentRejection();
      throw new Error(
        late
          ? 'Веб-Outlook отказался вложить файлы: ' + late
          : 'Вложения не догрузились в веб-Outlook за отведённое время. ' +
            'Повторите с --dry-run, чтобы увидеть состояние черновика на скриншоте.'
      );
    }
    await this.page.waitForTimeout(2000);
  }

  // Текст баннера об отказе вложить файл, если он есть на странице.
  async attachmentRejection() {
    return this.page.evaluate(() => {
      const re =
        /не были вставлены|не относятся к поддерживаемым|were not inserted|not a supported|isn't supported|too large|слишком велик/i;
      for (const a of document.querySelectorAll(
        '[role="alert"], [class*="MessageBar"], [class*="messageBar"]'
      )) {
        const t = (a.innerText || '').trim();
        if (t && re.test(t)) return t.replace(/\s+/g, ' ').slice(0, 300);
      }
      return null;
    });
  }

  async send(msg, { dryRun = false, screenshot = null, attachMode = 'copy' } = {}) {
    if (!this.page) await this.open();
    const m = normalizeOutgoing(msg);

    // Сколько черновиков с этой темой и этим адресатом лежало ДО того, как мы начали.
    // Без этой мерки резервный путь через «Черновики» неотличим от дубля: черновик,
    // оставшийся от предыдущего --dry-run, выглядит точно как недоотправленное письмо,
    // и программа отправляет его вдогонку уже ушедшему. Считаем заранее и потом
    // отправляем из папки только то, что появилось при этом запуске.
    const draftBaseline =
      dryRun || !m.subject
        ? 0
        : await this.countDrafts(
            m.subject.replace(/\s+/g, ' ').trim().slice(0, 40),
            m.to[0]
          );

    await this.page.goto(this.mailUrl('deeplink/compose?' + composeQuery(m)), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Ждём поле текста письма (локаль интерфейса может быть любой).
    const bodyBox = this.page
      .locator('[role="textbox"][aria-label], div[contenteditable="true"]')
      .last();
    await bodyBox.waitFor({ state: 'visible', timeout: 45000 });
    await this.page.waitForTimeout(2500);

    // Текст письма едет в адресе deeplink-компоуза, а длину адреса ограничивают и
    // браузер, и сам Outlook. На длинном письме обрезка не видна — уходит хвост.
    // Сверяем по числу непробельных символов: перевод строки в разметке может стать
    // и <br>, и новым абзацем, а сами символы теряться не должны.
    const dense = (s) => s.replace(/\s+/g, '').length;
    const got = dense(await bodyBox.innerText());
    if (dense(m.text) && got < dense(m.text) * 0.98) {
      throw new Error(
        `Текст письма дошёл до черновика не целиком (${got} из ${dense(m.text)} значащих ` +
          'символов) — адрес deeplink обрезан. Сократите письмо или отправьте по SMTP.'
      );
    }

    if (m.attachments.length) await this.attachFiles(m.attachments, { mode: attachMode });

    if (screenshot) await this.page.screenshot({ path: screenshot, fullPage: true });

    if (dryRun) {
      const preview = await this.page.evaluate(() =>
        document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)
      );
      return { id: null, dryRun: true, preview };
    }

    const sendBtn = this.page
      .locator(
        'button[aria-label*="Send" i], button[aria-label*="Отправить" i], ' +
          'button:has-text("Отправить"), button:has-text("Send")'
      )
      .first();
    if (await sendBtn.count()) {
      await sendBtn.click();
    } else {
      await bodyBox.click();
      await this.page.keyboard.press('Control+Enter');
    }
    // Нажатие само по себе ничего не гарантирует: если вложение ещё не долито или
    // выскочило очередное модальное окно, письмо тихо остаётся черновиком. Признак
    // настоящей отправки — форма письма закрылась и получатель со страницы исчез.
    //
    // Ищем на странице тему письма, а не саму форму: после отправки Outlook оставляет
    // список писем, где есть и поле поиска, и области с contenteditable, так что по
    // форме отличить одно от другого нельзя.
    const mark = (m.subject || m.text).replace(/\s+/g, ' ').trim().slice(0, 40);
    let closed = false;
    for (let i = 0; i < (m.attachments.length ? 60 : 10); i++) {
      await this.page.waitForTimeout(2000);
      closed = await this.page
        .evaluate((s) => !s || !document.body.innerText.replace(/\s+/g, ' ').includes(s), mark)
        .catch(() => false);
      if (closed) break;
      // Второй диалог о способе вложения после нажатия «Отправить» — отвечаем и жмём снова.
      if (await this.resolveShareDialog(attachMode)) {
        await sendBtn.click({ timeout: 15000 }).catch(() => {});
      }
    }
    // Закрытая форма — ещё не отправка: письмо с вложениями окно deeplink-компоуза
    // отправлять отказывается, кнопка нажимается, ошибки нет, а письмо тихо остаётся
    // черновиком. Поэтому решает не форма, а папка «Черновики»: если письмо там —
    // отправляем его оттуда (так оно уходит), если его там нет — значит, уже ушло.
    const outcome = await this.sendSavedDraft(mark, m.to[0], { baseline: draftBaseline });
    closed = outcome === 'sent' || (outcome === 'none' && closed);

    if (!closed) {
      if (screenshot) await this.page.screenshot({ path: screenshot, fullPage: true });
      throw new Error(
        'Веб-Outlook не отправил письмо ни из формы, ни из папки «Черновики» — ' +
          'оно осталось черновиком. Посмотрите снимок и отправьте его вручную.'
      );
    }
    return {
      id: null,
      accepted: [...m.to, ...m.cc, ...m.bcc],
      rejected: [],
      attachments: m.attachments.map((a) => a.name),
    };
  }

  // Ищет письмо в «Черновиках» и, если оно там, отправляет его из списка.
  // Возвращает 'none' — черновика нет (письмо ушло из формы), 'sent' — черновик после
  // нажатия из папки пропал, 'stuck' — остался лежать.
  //
  // Строка черновика в списке начинается с адреса получателя, поэтому ищем по паре
  // «получатель + тема»: письмо той же темы, но другому адресату, под руку не попадёт.
  // ⚠ Два черновика одному адресату с одной темой (например, от прошлой неудачной
  // попытки) всё же неразличимы — уйдёт верхний.
  // Считает черновики с этой темой и этим адресатом, ничего не отправляя.
  async countDrafts(mark, recipient) {
    if (!mark) return 0;
    await this.page.goto(this.mailUrl('drafts'), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await this.page.waitForSelector('[role="option"]', { timeout: 45000 }).catch(() => {});
    await this.page.waitForTimeout(3000);
    let rows = this.page.locator('[role="option"]').filter({ hasText: mark });
    if (recipient) rows = rows.filter({ hasText: recipient });
    return rows.count();
  }

  async sendSavedDraft(mark, recipient, { timeoutMs = 3 * 60 * 1000, baseline = 0 } = {}) {
    if (!mark) return 'none';
    await this.page.waitForTimeout(3000); // дать автосохранению записать черновик
    await this.page.goto(this.mailUrl('drafts'), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await this.page.waitForSelector('[role="option"]', { timeout: 45000 }).catch(() => {});
    await this.page.waitForTimeout(4000);

    const matching = () => {
      let rows = this.page.locator('[role="option"]').filter({ hasText: mark });
      if (recipient) rows = rows.filter({ hasText: recipient });
      return rows;
    };

    const before = await matching().count();
    if (!before) return 'none';
    // Черновиков не больше, чем было до запуска, — значит нашего среди них нет:
    // письмо ушло из формы, а лежит здесь чужое (например, от прошлого --dry-run).
    // Отправить его означало бы послать адресату второй экземпляр.
    if (before <= baseline) return 'none';
    // Раньше здесь молча отправлялся верхний черновик. Но двойник от прошлой неудачной
    // попытки неотличим от нужного письма и может оказаться без вложений — отправить его
    // означает потратить единственную попытку на дефектное письмо. Поэтому на двусмысленности
    // останавливаемся: пусть человек удалит лишние черновики и повторит.
    if (before > 1) {
      throw new Error(
        `В папке «Черновики» ${before} писем с этой темой для ${recipient}. ` +
          'Какое из них отправлять — неразличимо, и одно может быть без вложений. ' +
          'Удалите лишние черновики и повторите отправку.'
      );
    }
    await matching().first().click();
    await this.page.waitForTimeout(8000);

    const sendBtn = this.page
      .locator('button[aria-label*="Отправить" i], button[aria-label*="Send" i]')
      .first();
    if (!(await sendBtn.count())) return 'stuck';
    await sendBtn.click({ timeout: 30000 });

    // Считаем строки, а не факт их наличия: от прошлых попыток в папке могут лежать
    // двойники, и тогда признак отправки — что их стало на одну меньше.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(3000);
      if ((await matching().count()) < before) return 'sent';
    }
    return 'stuck';
  }

  async list(opts = {}) {
    if (!this.page) await this.open();
    const limit = opts.limit || 20;
    const folder = String(opts.folder || 'inbox').toLowerCase();

    if (folder !== 'inbox') {
      await this.page.goto(this.mailUrl(folder), {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.page.waitForSelector('[role="option"]', { timeout: 45000 }).catch(() => {});
    }
    await this.page.waitForTimeout(2000);

    const rows = await this.page.evaluate((max) => {
      // Собираем текст листовых узлов строки по порядку — так поля не склеиваются
      // в одну строку, как это делает aria-label.
      //
      // Иконки Fluent UI вставлены символами из области частного использования
      // (U+E000–U+F8FF): для DOM это текстовые узлы, для человека — картинки.
      // Без их отсева между полями оказывается мусор, и разбор съезжает.
      // Сравниваем по кодам, чтобы не держать нечитаемые литералы в исходнике.
      const isGlyphOrInvisible = (cp) =>
        (cp >= 0xe000 && cp <= 0xf8ff) || cp === 0xfeff || (cp >= 0x200b && cp <= 0x200d);

      const clean = (s) => {
        let out = '';
        for (const ch of s) {
          if (!isGlyphOrInvisible(ch.codePointAt(0))) out += ch;
        }
        return out.replace(/\s+/g, ' ').trim();
      };

      const leafTexts = (root) => {
        const out = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const t = clean(node.nodeValue);
          if (t) out.push(t);
        }
        return out;
      };
      const items = [];
      for (const el of document.querySelectorAll('[role="option"]')) {
        items.push({ parts: leafTexts(el), label: el.getAttribute('aria-label') || '' });
        if (items.length >= max) break;
      }
      return items;
    }, limit);

    return rows.map((row, i) => this.toMessage(row, folder, i));
  }

  // Разметка списка Outlook не даёт полей напрямую, поэтому разбираем по порядку:
  // отправитель, тема, дата, начало текста. Дату узнаём по формату — она же разделитель.
  toMessage(row, folder, index) {
    const parts = row.parts.filter((p) => !NOISE.some((re) => re.test(p)));

    // У контактов без фото Outlook рисует кружок с инициалами, и они попадают в текст
    // первым фрагментом. Отличаем их от настоящего отправителя: две-три заглавные буквы
    // подряд, за которыми идёт ещё один непустой фрагмент.
    if (parts.length > 1 && /^[A-ZА-ЯЁ]{1,3}$/.test(parts[0])) parts.shift();

    const dateAt = parts.findIndex((p) => DATE_RE.test(p));

    let from = '';
    let subject = '';
    let snippet = '';

    if (dateAt > 0) {
      from = parts[0];
      subject = parts.slice(1, dateAt).join(' ');
      snippet = parts.slice(dateAt + 1).join(' ');
    } else {
      from = parts[0] || '';
      subject = parts.slice(1, 2).join(' ');
      snippet = parts.slice(2).join(' ');
    }

    return {
      id: `${folder}:${index}`,
      account: this.account.name,
      folder,
      from,
      subject,
      date: dateAt > 0 ? parts[dateAt] : null, // локальный формат интерфейса, не ISO
      snippet: snippet.slice(0, 300),
      unread: /непрочит|unread/i.test(row.label) || undefined,
      raw: row.label,
    };
  }

  async fetch() {
    throw new Error(
      'Полное тело письма для веб-Outlook пока не реализовано — используйте snippet из list()'
    );
  }

  async close() {
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
      this.page = null;
    }
  }
}

module.exports = OutlookWebTransport;
module.exports.MAIL_HOST_RE = MAIL_HOST_RE;
module.exports.DATE_RE = DATE_RE;
module.exports.composeQuery = composeQuery;
