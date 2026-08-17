// mailbot read — выгрузка писем в структурированном виде.
//
// Основной потребитель — анализ: JSON с разделёнными полями отправителя, темы, даты и текста,
// а не склеенная строка из разметки, как отдавала первая версия.

const fs = require('fs');
const { selectAccounts } = require('../config');
const { withTransport } = require('../transports');
const { parseSince } = require('../args');
const { summarize } = require('../message');

async function run(_positional, opts) {
  const accounts = selectAccounts(opts.from);

  const listOpts = {
    folder: opts.folder || 'inbox',
    limit: Number(opts.limit) || 20,
    unread: Boolean(opts.unread),
    from: typeof opts.sender === 'string' ? opts.sender : undefined,
    search: typeof opts.search === 'string' ? opts.search : undefined,
    since: parseSince(opts.since),
    full: Boolean(opts.full),
  };

  const messages = [];
  const errors = [];

  for (const account of accounts) {
    try {
      const items = await withTransport(account, (t) => {
        if (!t.capabilities().list) {
          throw new Error(`транспорт ${account.type} не умеет читать`);
        }
        return t.list(listOpts);
      });
      messages.push(...items);
    } catch (e) {
      // Один недоступный ящик не должен обнулять выгрузку из остальных.
      errors.push({ account: account.name, error: e.message });
    }
  }

  const payload = {
    count: messages.length,
    accounts: accounts.map((a) => a.name),
    folder: listOpts.folder,
    items: messages,
  };
  if (errors.length) payload.errors = errors;

  const json = JSON.stringify(payload, null, 2);

  if (typeof opts.json === 'string') {
    fs.writeFileSync(opts.json, json, 'utf8');
    console.log(`Записано ${messages.length} писем в ${opts.json}`);
  } else if (opts.table) {
    for (const m of messages) console.log(summarize(m));
    for (const e of errors) console.error(`! ${e.account}: ${e.error}`);
  } else {
    console.log(json);
  }

  if (errors.length && !messages.length) process.exitCode = 2;
}

module.exports = { run };
