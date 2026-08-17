// Рассылка по списку: рендер шаблона на каждого получателя, ограничение темпа,
// журнал отправки и дозапуск.
//
// Журнал — не украшение. На сотнях адресов обрыв посреди рассылки без него означает
// либо недоотправку, либо повторные письма тем же людям. Поэтому пишем строку сразу
// после каждой отправки, а не в конце: падение процесса не должно стирать историю.

const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./csv');
const { renderMessage, usedVariables, parseFrontMatter } = require('./template');
const { isValidAddress } = require('./message');

// Как может называться колонка с адресом в выгрузке из Excel или Google Forms.
const EMAIL_KEYS = ['email', 'e-mail', 'mail', 'почта', 'адрес', 'эл. почта', 'e_mail'];

function pickEmailColumn(headers) {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const key of EMAIL_KEYS) {
    const at = lower.indexOf(key);
    if (at !== -1) return headers[at];
  }
  // запасной вариант: колонка, в названии которой есть «mail» или «почт»
  const fuzzy = headers.find((h) => /mail|почт/i.test(h));
  return fuzzy || null;
}

// Имя журнала выводим из имён шаблона и списка, а не из времени запуска:
// иначе --resume не нашёл бы предыдущий прогон.
function journalPathFor(root, listPath, templatePath) {
  const base = (p) => path.basename(p).replace(/\.[^.]+$/, '');
  return path.join(root, 'campaigns', `${base(templatePath)}--${base(listPath)}.jsonl`);
}

// Кому уже уходило — читаем журнал прошлых прогонов.
function loadSent(journalPath) {
  const sent = new Map();
  if (!fs.existsSync(journalPath)) return sent;
  for (const line of fs.readFileSync(journalPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.email && rec.status === 'sent') sent.set(rec.email.toLowerCase(), rec);
    } catch {
      /* битую строку журнала пропускаем, она не должна ронять рассылку */
    }
  }
  return sent;
}

function appendJournal(journalPath, record) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.appendFileSync(journalPath, JSON.stringify(record) + '\n', 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Готовит список писем: читает CSV и шаблон, проверяет адреса и переменные.
// Ничего не отправляет — это позволяет --dry-run показать все проблемы разом.
function prepare({ listFile, templateFile }) {
  const rows = parseCsv(fs.readFileSync(listFile, 'utf8'));
  if (!rows.length) throw new Error(`Список ${listFile} пуст`);

  const headers = Object.keys(rows[0]);
  const emailCol = pickEmailColumn(headers);
  if (!emailCol) {
    throw new Error(
      `В списке нет колонки с адресом. Колонки: ${headers.join(', ')}. ` +
        `Назовите одну из них «email» или «почта».`
    );
  }

  const source = fs.readFileSync(templateFile, 'utf8');
  const { meta } = parseFrontMatter(source);
  if (!meta.subject) {
    throw new Error(`В шаблоне ${templateFile} не задана тема: добавьте «subject:» в front-matter`);
  }

  const needed = usedVariables(source);
  const unknown = needed.filter((v) => !headers.includes(v));

  const items = rows.map((row, i) => {
    const email = (row[emailCol] || '').trim();
    const rendered = renderMessage(source, row);
    const problems = [];
    if (!email) problems.push('нет адреса');
    else if (!isValidAddress(email)) problems.push(`неверный адрес «${email}»`);
    if (rendered.missing.length) problems.push(`нет значений: ${rendered.missing.join(', ')}`);
    return { line: i + 2, email, row, ...rendered, problems };
  });

  return { items, headers, emailCol, needed, unknown };
}

// Прогон рассылки. transport уже открыт вызывающей стороной — так одна сессия
// браузера или SMTP обслуживает всю пачку.
async function run({
  transport,
  account,
  items,
  journalPath,
  resume = true,
  perMinute,
  limit = Infinity,
  onProgress = () => {},
}) {
  const rate = perMinute || (account.limits && account.limits.perMinute) || 10;
  const gap = Math.ceil(60000 / rate);
  const sent = resume ? loadSent(journalPath) : new Map();

  const stats = { sent: 0, failed: 0, skipped: 0, invalid: 0 };
  let processed = 0;

  for (const item of items) {
    if (processed >= limit) break;

    if (item.problems.length) {
      stats.invalid++;
      onProgress({ item, status: 'invalid', reason: item.problems.join('; ') });
      continue;
    }
    if (sent.has(item.email.toLowerCase())) {
      stats.skipped++;
      onProgress({ item, status: 'skipped' });
      continue;
    }

    if (processed > 0) await sleep(gap);
    processed++;

    try {
      const res = await transport.send({
        to: [item.email],
        subject: item.subject,
        text: item.text,
      });
      stats.sent++;
      appendJournal(journalPath, {
        email: item.email,
        status: 'sent',
        id: res.id || null,
        account: account.name,
        subject: item.subject,
        ts: new Date().toISOString(),
      });
      onProgress({ item, status: 'sent' });
    } catch (e) {
      stats.failed++;
      appendJournal(journalPath, {
        email: item.email,
        status: 'failed',
        error: e.message,
        account: account.name,
        ts: new Date().toISOString(),
      });
      onProgress({ item, status: 'failed', reason: e.message });
    }
  }

  return stats;
}

module.exports = { prepare, run, pickEmailColumn, journalPathFor, loadSent, appendJournal };
