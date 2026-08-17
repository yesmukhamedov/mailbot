// Фоновое чтение почты: node read.js [сколько писем] [папка]
// папка: inbox (по умолчанию), sentitems, drafts, archive, junkemail
const { open, gotoMail, mailUrl } = require('./lib');

const LIMIT = parseInt(process.argv[2] || '10', 10);
const FOLDER = process.argv[3] || 'inbox';

(async () => {
  const { ctx, page } = await open({ headless: true });
  try {
    if (!(await gotoMail(page))) {
      console.log(JSON.stringify({ error: 'NOT_SIGNED_IN', url: page.url() }));
      process.exitCode = 2;
      return;
    }
    if (FOLDER !== 'inbox') {
      await page.goto(mailUrl(page, FOLDER), {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await page.waitForSelector('[role="option"]', { timeout: 45000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);
    const items = await page.evaluate((limit) => {
      const out = [];
      for (const el of document.querySelectorAll('[role="option"]')) {
        const label = el.getAttribute('aria-label') || el.innerText.replace(/\s+/g, ' ').trim();
        if (!label) continue;
        out.push({
          unread: /непрочит|unread/i.test(el.getAttribute('aria-label') || '') || undefined,
          text: label,
        });
        if (out.length >= limit) break;
      }
      return out;
    }, LIMIT);
    console.log(JSON.stringify({ count: items.length, items }, null, 2));
  } finally {
    await ctx.close();
  }
})();
