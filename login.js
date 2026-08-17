// Разовый вход: открывает видимое окно Chrome, ждёт пока пользователь войдёт в почту,
// сохраняет сессию в профиле (см. MAILBOT_PROFILE в lib.js) и закрывается.
const { open, isSignedIn, MAIL_URL } = require('./lib');

(async () => {
  const { ctx, page } = await open({ headless: false });
  await page.goto(MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('WAITING_FOR_LOGIN');

  const deadline = Date.now() + 12 * 60 * 1000; // 12 минут на вход
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) {
      const who = await page
        .evaluate(() => {
          const el = document.querySelector('[aria-label*="@"]');
          return el ? el.getAttribute('aria-label') : '';
        })
        .catch(() => '');
      // eslint-disable-next-line no-console
      console.log('LOGGED_IN', who);
      await page.waitForTimeout(4000); // дать докатиться записи профиля на диск
      await ctx.close();
      process.exit(0);
    }
    await page.waitForTimeout(2000);
  }

  console.log('TIMEOUT_NOT_LOGGED_IN');
  await ctx.close();
  process.exit(1);
})();
