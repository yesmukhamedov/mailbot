// mailbot send — точечная отправка одного письма с выбранного ящика.

const fs = require('node:fs');
const path = require('path');
const { selectAccounts, ROOT } = require('../config');
const { withTransport } = require('../transports');
const { attachmentList, attachmentsSize, ATTACHMENT_SAFE_BYTES } = require('../message');

async function run(_positional, opts) {
  const accounts = selectAccounts(opts.from);
  if (accounts.length > 1) {
    throw new Error('Отправлять можно только с одного ящика — уберите список в --from');
  }
  const account = accounts[0];

  if (!opts.to) throw new Error('Укажите получателя: --to адрес[,адрес]');
  if (!opts.subject) throw new Error('Укажите тему: --subject "..."');

  // Длинное письмо неудобно передавать одной строкой в командной строке — Windows
  // ломает переводы строк. --body-file читает тело из файла как есть.
  let text = opts.body || '';
  if (opts.bodyFile) text = fs.readFileSync(path.resolve(opts.bodyFile), 'utf8');

  const attachments = attachmentList(opts.attach);
  const total = attachmentsSize(attachments);
  if (total > ATTACHMENT_SAFE_BYTES) {
    console.error(
      `Внимание: вложений на ${(total / 1048576).toFixed(1)} МБ. После кодирования это ` +
        'выйдет за лимит письма в 25 МБ — провайдер, скорее всего, отклонит отправку.'
    );
  }

  const msg = {
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    text,
    attachments,
  };

  const dryRun = Boolean(opts.dryRun);
  const screenshot =
    account.type === 'outlook-web'
      ? opts.screenshot || path.join(ROOT, 'draft.png')
      : null;

  // Веб-Outlook умеет вместо копии файла положить в письмо ссылку на OneDrive —
  // единственный способ отправить больше 25 МБ одним письмом.
  const attachMode = opts.onedrive ? 'onedrive' : 'copy';

  const result = await withTransport(account, (t) =>
    t.send(msg, { dryRun, screenshot, attachMode })
  );

  const out = {
    status: dryRun ? 'DRAFT_READY' : 'SENT',
    account: account.name,
    from: account.address,
    to: msg.to,
    subject: msg.subject,
  };
  if (attachments.length) {
    out.attachments = attachments.map((a) => `${a.name} (${(a.size / 1048576).toFixed(1)} МБ)`);
  }
  if (result.id) out.id = result.id;
  if (result.rejected && result.rejected.length) out.rejected = result.rejected;
  if (dryRun && screenshot) out.screenshot = screenshot;
  if (dryRun && result.preview) out.preview = result.preview;

  console.log(JSON.stringify(out, null, 2));
}

module.exports = { run };
