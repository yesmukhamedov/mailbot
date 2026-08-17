// mailbot login <ящик> — разовый вход для браузерных ящиков.
// Откроется видимое окно Chrome; логин, пароль и второй фактор вводит пользователь.

const { getAccount } = require('../config');
const { createTransport } = require('../transports');

async function run(positional, opts) {
  const name = positional[0] || opts.from;
  if (!name) throw new Error('Укажите ящик: mailbot login <имя>');

  const account = getAccount(name);
  if (account.type !== 'outlook-web') {
    throw new Error(
      `Ящику «${name}» вход через браузер не нужен: транспорт ${account.type} ` +
        'использует пароль приложения из .env.'
    );
  }

  const transport = createTransport(account);
  console.log(`Открываю окно Chrome для «${name}» (${account.address}).`);
  console.log('Войдите в почту и отметьте «Остаться в системе». Окно закроется само.');

  const ok = await transport.login();
  if (ok) {
    console.log(`\nВход выполнен, сессия сохранена в ${account.profile}`);
    console.log(`Проверить: mailbot doctor --from ${name}`);
  } else {
    console.log('\nВход не завершён за отведённое время.');
    process.exitCode = 1;
  }
}

module.exports = { run };
