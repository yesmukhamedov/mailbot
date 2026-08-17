// Готовые настройки провайдеров, чтобы подключение ящика сводилось к адресу и паролю,
// а не к выяснению портов. Лимиты — консервативные значения из публичной документации
// провайдеров; они нужны рассылке, чтобы притормаживать до того, как провайдер начнёт
// отбивать письма.

const PRESETS = {
  gmail: {
    type: 'smtp-imap',
    label: 'Gmail / Google Workspace',
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    limits: { perDay: 500, perMinute: 20 },
    help:
      'Нужен пароль приложения: включите двухэтапную проверку, затем\n' +
      '  https://myaccount.google.com/apppasswords — 16 символов без пробелов.\n' +
      '  Обычный пароль от аккаунта не подойдёт.',
  },

  yandex: {
    type: 'smtp-imap',
    label: 'Яндекс.Почта',
    smtp: { host: 'smtp.yandex.ru', port: 465, secure: true },
    imap: { host: 'imap.yandex.ru', port: 993, secure: true },
    limits: { perDay: 500, perMinute: 20 },
    help:
      'Нужен пароль приложения: https://id.yandex.ru/security/app-passwords\n' +
      '  В настройках почты включите доступ по IMAP.',
  },

  mailru: {
    type: 'smtp-imap',
    label: 'Mail.ru',
    smtp: { host: 'smtp.mail.ru', port: 465, secure: true },
    imap: { host: 'imap.mail.ru', port: 993, secure: true },
    limits: { perDay: 500, perMinute: 20 },
    help: 'Нужен пароль для внешнего приложения: https://account.mail.ru/user/2-step-auth/passwords',
  },

  icloud: {
    type: 'smtp-imap',
    label: 'iCloud Mail',
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    limits: { perDay: 500, perMinute: 20 },
    help: 'Нужен пароль приложения: https://account.apple.com → «Вход и безопасность».',
  },

  // Microsoft-ящики идут через браузер: у рабочих тенантов SMTP/IMAP закрыт basic-аутентификацией
  // и требует admin consent, у личных outlook.com пароли приложений отключены с сентября 2024.
  outlook: {
    type: 'outlook-web',
    label: 'Microsoft 365 (рабочая/учебная почта)',
    mailUrl: 'https://outlook.office.com/mail/',
    limits: { perDay: 10000, perMinute: 30 },
    help: 'Пароль не нужен: вход выполняется руками один раз через `mailbot login <ящик>`.',
  },

  'outlook-personal': {
    type: 'outlook-web',
    label: 'Outlook.com / Hotmail / Live (личная почта)',
    mailUrl: 'https://outlook.live.com/mail/',
    limits: { perDay: 300, perMinute: 30 },
    help: 'Пароль не нужен: вход выполняется руками один раз через `mailbot login <ящик>`.',
  },

  custom: {
    type: 'smtp-imap',
    label: 'Другой провайдер (хосты укажете сами)',
    limits: { perDay: 500, perMinute: 20 },
    help: 'Укажите хосты и порты SMTP/IMAP вручную в accounts.json.',
  },
};

// Значения по умолчанию, если провайдер не дал своих.
const DEFAULT_LIMITS = { perDay: 200, perMinute: 10 };

function getPreset(name) {
  if (!name) return null;
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(
      `Неизвестный провайдер «${name}». Доступны: ${Object.keys(PRESETS).join(', ')}`
    );
  }
  return preset;
}

function listPresets() {
  return Object.entries(PRESETS).map(([name, p]) => ({ name, label: p.label, type: p.type }));
}

module.exports = { PRESETS, DEFAULT_LIMITS, getPreset, listPresets };
