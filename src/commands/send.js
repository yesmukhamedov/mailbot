// mailbot send — точечная отправка одного письма с выбранного ящика.

const path = require('path');
const { selectAccounts, ROOT } = require('../config');
const { withTransport } = require('../transports');

async function run(_positional, opts) {
  const accounts = selectAccounts(opts.from);
  if (accounts.length > 1) {
    throw new Error('Отправлять можно только с одного ящика — уберите список в --from');
  }
  const account = accounts[0];

  if (!opts.to) throw new Error('Укажите получателя: --to адрес[,адрес]');
  if (!opts.subject) throw new Error('Укажите тему: --subject "..."');

  const msg = {
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    text: opts.body || '',
  };

  const dryRun = Boolean(opts.dryRun);
  const screenshot =
    account.type === 'outlook-web'
      ? opts.screenshot || path.join(ROOT, 'draft.png')
      : null;

  const result = await withTransport(account, (t) => t.send(msg, { dryRun, screenshot }));

  const out = {
    status: dryRun ? 'DRAFT_READY' : 'SENT',
    account: account.name,
    from: account.address,
    to: msg.to,
    subject: msg.subject,
  };
  if (result.id) out.id = result.id;
  if (result.rejected && result.rejected.length) out.rejected = result.rejected;
  if (dryRun && screenshot) out.screenshot = screenshot;
  if (dryRun && result.preview) out.preview = result.preview;

  console.log(JSON.stringify(out, null, 2));
}

module.exports = { run };
