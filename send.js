// Фоновая отправка письма:
//   node send.js --to a@b.com --subject "Тема" --body "Текст" [--dry-run]
// --dry-run заполняет письмо и делает скриншот draft.png, но НЕ отправляет.
const { open, gotoMail, mailUrl, SCREENSHOT } = require('./lib');

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
}
const DRY = process.argv.includes('--dry-run');
const to = arg('to');
const subject = arg('subject');
const body = arg('body');

if (!to) {
  console.log(JSON.stringify({ error: 'NO_RECIPIENT' }));
  process.exit(2);
}

(async () => {
  const { ctx, page } = await open({ headless: true });
  try {
    if (!(await gotoMail(page))) {
      console.log(JSON.stringify({ error: 'NOT_SIGNED_IN', url: page.url() }));
      process.exitCode = 2;
      return;
    }

    const url =
      mailUrl(page, 'deeplink/compose?to=') +
      encodeURIComponent(to) +
      '&subject=' +
      encodeURIComponent(subject) +
      '&body=' +
      encodeURIComponent(body);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Ждём поле текста письма (локаль интерфейса может быть любой).
    const bodyBox = page.locator('[role="textbox"][aria-label], div[contenteditable="true"]').last();
    await bodyBox.waitFor({ state: 'visible', timeout: 45000 });
    await page.waitForTimeout(3000);

    const filled = await page.evaluate(() => {
      const t = document.body.innerText.replace(/\s+/g, ' ');
      return t.slice(0, 400);
    });

    await page.screenshot({ path: SCREENSHOT });

    if (DRY) {
      console.log(JSON.stringify({ status: 'DRAFT_READY', screenshot: SCREENSHOT, preview: filled }));
      return;
    }

    const sendBtn = page
      .locator('button[aria-label*="Send" i], button[aria-label*="Отправить" i], button:has-text("Отправить"), button:has-text("Send")')
      .first();
    if (await sendBtn.count()) {
      await sendBtn.click();
    } else {
      await bodyBox.click();
      await page.keyboard.press('Control+Enter');
    }

    await page.waitForTimeout(6000);
    console.log(JSON.stringify({ status: 'SENT', to, subject }));
  } finally {
    await ctx.close();
  }
})();
