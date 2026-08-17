#!/usr/bin/env node
// Единая точка входа: mailbot <команда> [опции]

const { parseArgs } = require('../src/args');

const COMMANDS = {
  account: () => require('../src/commands/account'),
  login: () => require('../src/commands/login'),
  doctor: () => require('../src/commands/doctor'),
  send: () => require('../src/commands/send'),
  read: () => require('../src/commands/read'),
  campaign: () => require('../src/commands/campaign'),
};

// Флаги без значения — иначе «--dry-run --to x» съело бы --to как значение.
const BOOLEANS = [
  'dryRun',
  'resume',
  'noResume',
  'unread',
  'full',
  'table',
  'help',
  'version',
];

const USAGE = `mailbot — почта из терминала: несколько ящиков, рассылка, анализ входящих

Настройка
  mailbot account add                     мастер подключения ящика
  mailbot account add --preset gmail --address me@gmail.com [--name gmail]
  mailbot account list                    список настроенных ящиков
  mailbot account default <имя>           ящик по умолчанию
  mailbot account remove <имя>
  mailbot login <имя>                     разовый вход для ящиков Microsoft
  mailbot doctor [--from имя] [--json]    проверить, что всё работает

Отправка
  mailbot send --from work --to a@b.kz,c@d.kz --subject "Тема" --body "Текст" [--dry-run]

Чтение
  mailbot read [--from имя|all] [--folder inbox|sent|drafts|junk|archive]
               [--limit 20] [--since 7d] [--unread] [--full]
               [--table | --json файл.json]

Рассылка
  mailbot campaign --from gmail --list people.csv --template letter.md
                   [--dry-run] [--limit N] [--rate 20] [--no-resume]

Ящик выбирается флагом --from; без него берётся ящик по умолчанию.
`;

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log(require('../package.json').version);
    return;
  }

  const load = COMMANDS[command];
  if (!load) {
    console.error(`Неизвестная команда «${command}».\n`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const { positional, opts } = parseArgs(argv.slice(1), { booleans: BOOLEANS });
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  await load().run(positional, opts);
}

main().catch((err) => {
  console.error(`Ошибка: ${err.message}`);
  if (process.env.MAILBOT_DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
