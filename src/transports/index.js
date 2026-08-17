// Фабрика транспортов. Команды работают только через этот слой и не знают,
// что под ящиком — SMTP или браузер.

const SmtpImapTransport = require('./smtp-imap');
const OutlookWebTransport = require('./outlook-web');

const TRANSPORTS = {
  'smtp-imap': SmtpImapTransport,
  'outlook-web': OutlookWebTransport,
};

function createTransport(account) {
  const Klass = TRANSPORTS[account.type];
  if (!Klass) {
    throw new Error(
      `Неизвестный транспорт «${account.type}». Доступны: ${Object.keys(TRANSPORTS).join(', ')}`
    );
  }
  return new Klass(account);
}

// Открыть транспорт, что-то сделать и гарантированно закрыть — браузер иначе
// останется висеть процессом, а IMAP-сессия займёт слот у провайдера.
async function withTransport(account, fn) {
  const transport = createTransport(account);
  try {
    await transport.open();
    return await fn(transport);
  } finally {
    await transport.close().catch(() => {});
  }
}

module.exports = { createTransport, withTransport, TRANSPORTS };
