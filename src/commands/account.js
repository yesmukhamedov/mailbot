// mailbot account list | add | remove | default — настройка ящиков после клонирования.
//
// add работает и мастером (вопросы в терминале), и полностью флагами. Неинтерактивный
// режим нужен, чтобы настройку мог выполнить скрипт или агент, а не только человек.

const readline = require('readline');
const { readConfig, writeConfig, listAccounts, CONFIG_PATH } = require('../config');
const { PRESETS, listPresets, getPreset } = require('../presets');

function printList() {
  const accounts = listAccounts();
  if (!accounts.length) {
    console.log('Ящиков пока нет. Добавьте первый: mailbot account add');
    return;
  }
  const cfg = readConfig();
  console.log(`Настроено в ${CONFIG_PATH}:\n`);
  for (const a of accounts) {
    if (a.broken) {
      console.log(`  ${a.name.padEnd(12)} ОШИБКА: ${a.broken}`);
      continue;
    }
    const mark = cfg.defaultAccount === a.name ? '*' : ' ';
    const secret =
      a.type === 'smtp-imap'
        ? a.pass
          ? `пароль из ${a.passEnv}`
          : `НЕТ ПАРОЛЯ (${a.passEnv || 'passEnv не задан'})`
        : `профиль ${a.profile}`;
    console.log(`${mark} ${a.name.padEnd(12)} ${a.type.padEnd(12)} ${a.address.padEnd(32)} ${secret}`);
  }
  console.log('\n* — ящик по умолчанию (используется, если не указан --from)');
}

function ask(rl, question, fallback = '') {
  return new Promise((resolve) => {
    rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `, (answer) => {
      resolve(answer.trim() || fallback);
    });
  });
}

async function addInteractive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Доступные провайдеры:\n');
    for (const p of listPresets()) {
      console.log(`  ${p.name.padEnd(18)} ${p.label}`);
    }
    console.log('');

    const preset = await ask(rl, 'Провайдер', 'gmail');
    const def = getPreset(preset);
    const address = await ask(rl, 'Адрес почты');
    if (!address) throw new Error('Адрес обязателен');
    const name = await ask(rl, 'Короткое имя ящика', preset);

    const entry = { type: def.type, preset, address };

    if (def.type === 'smtp-imap') {
      console.log(`\n${def.help}\n`);
      const envName = `MAILBOT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASS`;
      entry.passEnv = await ask(rl, 'Имя переменной окружения для пароля', envName);
      console.log(
        `\nДобавьте в .env строку:\n  ${entry.passEnv}=<пароль приложения>\n` +
          'Пароль в accounts.json не сохраняется.'
      );
    } else {
      entry.profile = `profiles/${name}`;
      console.log(`\n${def.help}`);
      console.log(`Дальше выполните: mailbot login ${name}`);
    }

    save(name, entry);
    return name;
  } finally {
    rl.close();
  }
}

function addFromFlags(opts) {
  const preset = opts.preset || null;
  const def = preset ? getPreset(preset) : null;
  const type = opts.type || (def && def.type);
  if (!type) throw new Error('Укажите --preset или --type');
  if (!opts.address) throw new Error('Укажите --address');

  const name = opts.name || preset || opts.address.split('@')[0];
  const entry = { type, address: opts.address };
  if (preset) entry.preset = preset;

  if (type === 'smtp-imap') {
    entry.passEnv =
      opts.passEnv || `MAILBOT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PASS`;
    if (opts.smtpHost) entry.smtp = { host: opts.smtpHost, port: Number(opts.smtpPort) || 465 };
    if (opts.imapHost) entry.imap = { host: opts.imapHost, port: Number(opts.imapPort) || 993 };
  } else {
    entry.profile = opts.profile || `profiles/${name}`;
    if (opts.mailUrl) entry.mailUrl = opts.mailUrl;
  }

  save(name, entry);
  return name;
}

function save(name, entry) {
  const cfg = readConfig();
  cfg.accounts[name] = entry;
  if (!cfg.defaultAccount) cfg.defaultAccount = name;
  writeConfig(cfg);
  console.log(`\nЯщик «${name}» записан в ${CONFIG_PATH}`);
}

async function run(positional, opts) {
  const action = positional[0] || 'list';

  if (action === 'list') return printList();

  if (action === 'add') {
    const name = opts.address || opts.preset ? addFromFlags(opts) : await addInteractive();
    console.log(`Проверить: mailbot doctor --from ${name}`);
    return;
  }

  if (action === 'remove') {
    const name = positional[1];
    if (!name) throw new Error('Укажите имя ящика: mailbot account remove <имя>');
    const cfg = readConfig();
    if (!cfg.accounts[name]) throw new Error(`Ящик «${name}» не найден`);
    delete cfg.accounts[name];
    if (cfg.defaultAccount === name) cfg.defaultAccount = Object.keys(cfg.accounts)[0] || null;
    writeConfig(cfg);
    console.log(`Ящик «${name}» удалён из конфигурации (профиль и .env не тронуты)`);
    return;
  }

  if (action === 'default') {
    const name = positional[1];
    if (!name) throw new Error('Укажите имя ящика: mailbot account default <имя>');
    const cfg = readConfig();
    if (!cfg.accounts[name]) throw new Error(`Ящик «${name}» не найден`);
    cfg.defaultAccount = name;
    writeConfig(cfg);
    console.log(`Ящик по умолчанию: ${name}`);
    return;
  }

  throw new Error(`Неизвестное действие «${action}». Доступны: list, add, remove, default`);
}

module.exports = { run, PRESETS };
