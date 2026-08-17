// Чтение и запись accounts.json + разрешение секретов из окружения.
//
// Пароли в accounts.json не хранятся: там лежит только имя переменной окружения (passEnv),
// а сам пароль — в .env. Так конфиг остаётся безопасным даже при случайном коммите.

const fs = require('fs');
const path = require('path');
const { getPreset, DEFAULT_LIMITS } = require('./presets');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.MAILBOT_CONFIG || path.join(ROOT, 'accounts.json');

// .env читаем один раз при загрузке модуля; process.loadEnvFile есть с Node 20.6.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* .env не обязателен */
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { defaultAccount: null, accounts: {} };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`Не разобрать ${CONFIG_PATH}: ${e.message}`);
  }
  if (!raw.accounts || typeof raw.accounts !== 'object') raw.accounts = {};
  return raw;
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// Разворачивает запись аккаунта: подмешивает пресет, подставляет пароль из окружения,
// приводит пути к абсолютным. Настройки самого аккаунта всегда важнее пресета.
function resolveAccount(name, entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Ящик «${name}»: запись должна быть объектом`);
  }
  const preset = entry.preset ? getPreset(entry.preset) : null;
  const type = entry.type || (preset && preset.type);
  if (!type) {
    throw new Error(`Ящик «${name}»: не указан ни type, ни preset`);
  }

  const acc = {
    name,
    type,
    preset: entry.preset || null,
    address: entry.address || '',
    limits: { ...DEFAULT_LIMITS, ...(preset && preset.limits), ...entry.limits },
  };

  if (type === 'smtp-imap') {
    acc.smtp = { ...(preset && preset.smtp), ...entry.smtp };
    acc.imap = { ...(preset && preset.imap), ...entry.imap };
    if (!acc.smtp.host) throw new Error(`Ящик «${name}»: не указан smtp.host`);

    acc.user = entry.user || entry.address;
    acc.passEnv = entry.passEnv || null;
    acc.pass = acc.passEnv ? process.env[acc.passEnv] : undefined;
    // Отсутствие пароля не считаем фатальным здесь: `mailbot account list` должен
    // показывать ящик и без секрета, а ругаться будут команды, которым он нужен.
  } else if (type === 'outlook-web') {
    acc.mailUrl = entry.mailUrl || (preset && preset.mailUrl) || 'https://outlook.office.com/mail/';
    const profile = entry.profile || path.join('profiles', name);
    acc.profile = path.isAbsolute(profile) ? profile : path.join(ROOT, profile);
  } else {
    throw new Error(`Ящик «${name}»: неизвестный тип транспорта «${type}»`);
  }

  return acc;
}

function getAccount(name) {
  const cfg = readConfig();
  const entry = cfg.accounts[name];
  if (!entry) {
    const known = Object.keys(cfg.accounts);
    throw new Error(
      `Ящик «${name}» не настроен.` +
        (known.length
          ? ` Настроены: ${known.join(', ')}`
          : ' Ни одного ящика ещё нет — начните с `mailbot account add`.')
    );
  }
  return resolveAccount(name, entry);
}

function listAccounts() {
  const cfg = readConfig();
  return Object.entries(cfg.accounts).map(([name, entry]) => {
    try {
      return resolveAccount(name, entry);
    } catch (e) {
      return { name, broken: e.message };
    }
  });
}

// Разбирает --from: имя, список через запятую, «all», либо ящик по умолчанию.
function selectAccounts(spec) {
  const cfg = readConfig();
  const names = Object.keys(cfg.accounts);
  if (!names.length) {
    throw new Error('Ни одного ящика не настроено. Начните с `mailbot account add`.');
  }

  if (spec === 'all') return names.map(getAccount);

  if (spec) {
    return spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(getAccount);
  }

  const fallback = cfg.defaultAccount || (names.length === 1 ? names[0] : null);
  if (!fallback) {
    throw new Error(
      `Ящик не указан и нет ящика по умолчанию. Добавьте --from <имя> (есть: ${names.join(', ')}) ` +
        'или задайте defaultAccount в accounts.json.'
    );
  }
  return [getAccount(fallback)];
}

module.exports = {
  ROOT,
  CONFIG_PATH,
  readConfig,
  writeConfig,
  resolveAccount,
  getAccount,
  listAccounts,
  selectAccounts,
};
