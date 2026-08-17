// mailbot doctor — проверяет каждый ящик и говорит, что реально работает.
//
// Существует потому, что поломки тут приходят снаружи и молча: провайдер меняет домен,
// протухает сессия, истекает пароль приложения. Лучше узнать это одной командой,
// чем посреди рассылки.

const { selectAccounts, listAccounts } = require('../config');
const { createTransport } = require('../transports');

async function probe(account) {
  const result = { name: account.name, type: account.type, address: account.address };
  const transport = createTransport(account);
  result.capabilities = transport.capabilities();

  const started = Date.now();
  try {
    await transport.open();
    result.ok = true;

    if (result.capabilities.list) {
      try {
        const items = await transport.list({ limit: 1 });
        result.readCheck = `ОК, писем видно: ${items.length}`;
      } catch (e) {
        result.readCheck = `чтение не удалось: ${e.message}`;
      }
    } else {
      result.readCheck = 'чтение не поддерживается';
    }
  } catch (e) {
    result.ok = false;
    result.error = e.message;
  } finally {
    await transport.close().catch(() => {});
  }

  result.ms = Date.now() - started;
  return result;
}

async function run(_positional, opts) {
  const accounts = opts.from ? selectAccounts(opts.from) : listAccounts().filter((a) => !a.broken);

  if (!accounts.length) {
    console.log('Ящиков не настроено. Начните с `mailbot account add`.');
    return;
  }

  const results = [];
  for (const account of accounts) {
    process.stderr.write(`Проверяю «${account.name}»…\n`);
    results.push(await probe(account));
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log('');
  for (const r of results) {
    const mark = r.ok ? 'OK ' : 'СБОЙ';
    console.log(`[${mark}] ${r.name} — ${r.type}, ${r.address} (${(r.ms / 1000).toFixed(1)} с)`);
    if (r.ok) {
      const caps = Object.entries(r.capabilities)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ');
      console.log(`        умеет: ${caps}`);
      console.log(`        чтение: ${r.readCheck}`);
    } else {
      console.log(`        ${r.error}`);
    }
  }

  const broken = results.filter((r) => !r.ok);
  if (broken.length) process.exitCode = 1;
}

module.exports = { run, probe };
