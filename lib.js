const path = require('path');
const { chromium } = require('playwright-core');

// Локальные настройки берём из .env рядом со скриптами (файл не коммитится).
// process.loadEnvFile появился в Node 20.6, поэтому оборачиваем в try.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* .env не обязателен — работают значения по умолчанию */
}

// Профиль Chrome с сессией. По умолчанию — папка profile/ рядом со скриптами.
const PROFILE = process.env.MAILBOT_PROFILE || path.join(__dirname, 'profile');
const MAIL_URL = process.env.MAILBOT_MAIL_URL || 'https://outlook.office.com/mail/';
// Куда send.js кладёт скриншот черновика.
const SCREENSHOT = process.env.MAILBOT_SCREENSHOT || path.join(__dirname, 'draft.png');

async function open({ headless = true } = {}) {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

// Считает, что почта открыта, когда в списке появились письма или кнопка «Создать».
// Во время входа страница часто редиректит, поэтому любые ошибки evaluate = «ещё не вошли».
async function isSignedIn(page) {
  try {
    if (page.isClosed() || !page.url().includes('outlook.office.com/mail')) return false;
    return await page.evaluate(
      () =>
        document.querySelectorAll('[role="option"]').length > 0 ||
        !!document.querySelector('[aria-label*="New mail" i],[aria-label*="Создать" i]')
    );
  } catch {
    return false;
  }
}

async function gotoMail(page) {
  await page.goto(MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 40; i++) {
    if (await isSignedIn(page)) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

module.exports = { open, isSignedIn, gotoMail, PROFILE, MAIL_URL, SCREENSHOT };
