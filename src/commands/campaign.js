// mailbot campaign — рассылка по списку из CSV.

const path = require('path');
const { selectAccounts, ROOT } = require('../config');
const { withTransport } = require('../transports');
const { prepare, run: runCampaign, journalPathFor, loadSent } = require('../campaign');

async function run(_positional, opts) {
  if (!opts.list) throw new Error('Укажите список получателей: --list people.csv');
  if (!opts.template) throw new Error('Укажите шаблон письма: --template letter.md');

  const accounts = selectAccounts(opts.from);
  if (accounts.length > 1) {
    throw new Error('Рассылать можно только с одного ящика — уберите список в --from');
  }
  const account = accounts[0];

  const { items, headers, emailCol, unknown } = prepare({
    listFile: opts.list,
    templateFile: opts.template,
  });

  const journalPath = opts.journal || journalPathFor(ROOT, opts.list, opts.template);
  const resume = opts.resume !== false && !opts.noResume;
  const alreadySent = resume ? loadSent(journalPath) : new Map();

  const bad = items.filter((i) => i.problems.length);
  const ready = items.filter(
    (i) => !i.problems.length && !alreadySent.has(i.email.toLowerCase())
  );
  const limit = Number(opts.limit) || Infinity;
  const perMinute = Number(opts.rate) || account.limits.perMinute;

  // Сводка до отправки — чтобы проблемы были видны заранее, а не на 200-м письме.
  console.log(`Ящик:        ${account.name} (${account.address}, ${account.type})`);
  console.log(`Список:      ${opts.list} — ${items.length} строк, адрес в колонке «${emailCol}»`);
  console.log(`Колонки:     ${headers.join(', ')}`);
  if (unknown.length) {
    console.log(`ВНИМАНИЕ:    в шаблоне есть переменные без колонок: ${unknown.join(', ')}`);
  }
  console.log(`Журнал:      ${journalPath}`);
  if (alreadySent.size) console.log(`Уже отправлено ранее: ${alreadySent.size}`);
  if (bad.length) console.log(`С проблемами: ${bad.length} (будут пропущены)`);
  console.log(`К отправке:  ${Math.min(ready.length, limit)}`);
  console.log(`Темп:        не более ${perMinute} писем в минуту`);

  const perDay = account.limits.perDay;
  if (ready.length > perDay) {
    console.log(
      `ВНИМАНИЕ:    получателей больше суточного лимита ящика (${perDay}). ` +
        `Разбейте на дни: --limit ${perDay}, затем завтра тот же запуск с --resume.`
    );
  }

  for (const b of bad.slice(0, 10)) {
    console.log(`  строка ${b.line}: ${b.problems.join('; ')}`);
  }
  if (bad.length > 10) console.log(`  …и ещё ${bad.length - 10}`);

  if (opts.dryRun) {
    console.log('\n--- Пример письма (первый готовый получатель) ---');
    const sample = ready[0];
    if (!sample) {
      console.log('Готовых получателей нет.');
      return;
    }
    console.log(`Кому:  ${sample.email}`);
    console.log(`Тема:  ${sample.subject}`);
    console.log(`\n${sample.text}`);
    console.log('\n--- Ничего не отправлено (--dry-run) ---');
    return;
  }

  if (!ready.length) {
    console.log('\nОтправлять некому.');
    return;
  }

  console.log('');
  const started = Date.now();
  const stats = await withTransport(account, (transport) =>
    runCampaign({
      transport,
      account,
      items,
      journalPath,
      resume,
      perMinute,
      limit,
      onProgress: ({ item, status, reason }) => {
        if (status === 'sent') console.log(`  → ${item.email}`);
        else if (status === 'failed') console.log(`  ! ${item.email}: ${reason}`);
        else if (status === 'invalid') console.log(`  ~ строка ${item.line}: ${reason}`);
      },
    })
  );

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(
    `\nОтправлено: ${stats.sent}, ошибок: ${stats.failed}, ` +
      `пропущено ранее отправленных: ${stats.skipped}, с проблемами: ${stats.invalid} (${mins} мин)`
  );
  console.log(`Журнал: ${journalPath}`);
  if (stats.failed) process.exitCode = 1;
}

module.exports = { run };
