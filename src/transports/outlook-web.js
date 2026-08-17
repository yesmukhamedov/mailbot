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
      attachments: false, // точка расширения
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

  async send(msg, { dryRun = false, screenshot = null } = {}) {
    if (!this.page) await this.open();
    const m = normalizeOutgoing(msg);

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

    if (screenshot) await this.page.screenshot({ path: screenshot });

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
    await this.page.waitForTimeout(4000);
    return { id: null, accepted: [...m.to, ...m.cc, ...m.bcc], rejected: [] };
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
