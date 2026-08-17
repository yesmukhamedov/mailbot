const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCsv, detectDelimiter } = require('../src/csv');
const { parseFrontMatter, render, renderMessage, usedVariables } = require('../src/template');
const { parseArgs, parseSince } = require('../src/args');
const { addressList, isValidAddress, normalizeOutgoing } = require('../src/message');
const { pickEmailColumn, loadSent, appendJournal, journalPathFor } = require('../src/campaign');
const { resolveAccount } = require('../src/config');

test('CSV: кавычки, запятые и переводы строк внутри полей', () => {
  const rows = parseCsv('email,name\n"a@b.kz","Иванов, И.И."\nc@d.kz,"Пётр\nСидоров"');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].name, 'Иванов, И.И.');
  assert.strictEqual(rows[1].name, 'Пётр\nСидоров');
});

test('CSV: удвоенная кавычка — это экранирование', () => {
  const rows = parseCsv('email,note\na@b.kz,"он сказал ""да"""');
  assert.strictEqual(rows[0].note, 'он сказал "да"');
});

test('CSV: Excel в русской локали пишет через точку с запятой', () => {
  assert.strictEqual(detectDelimiter('email;name;org'), ';');
  const rows = parseCsv('email;name\na@b.kz;Иван');
  assert.strictEqual(rows[0].name, 'Иван');
});

test('CSV: BOM от Excel не попадает в имя первой колонки', () => {
  const rows = parseCsv('﻿email,name\na@b.kz,Иван');
  assert.deepStrictEqual(Object.keys(rows[0]), ['email', 'name']);
});

test('CSV: разделитель внутри кавычек не считается за разделитель', () => {
  assert.strictEqual(detectDelimiter('"фамилия, имя",email'), ',');
});

test('Шаблон: front-matter отделяется от тела', () => {
  const { meta, body } = parseFrontMatter('---\nsubject: Привет, {{имя}}\n---\nТекст письма');
  assert.strictEqual(meta.subject, 'Привет, {{имя}}');
  assert.strictEqual(body, 'Текст письма');
});

test('Шаблон: подстановка значений', () => {
  const { text, missing } = render('Здравствуйте, {{имя}}!', { имя: 'Иван' });
  assert.strictEqual(text, 'Здравствуйте, Иван!');
  assert.deepStrictEqual(missing, []);
});

test('Шаблон: пустая переменная не превращается в пустоту молча', () => {
  const { text, missing } = render('Здравствуйте, {{имя}}!', { имя: '  ' });
  assert.deepStrictEqual(missing, ['имя']);
  assert.strictEqual(text, 'Здравствуйте, {{имя}}!', 'подстановка остаётся видимой');
});

test('Шаблон: тема и тело рендерятся вместе', () => {
  const src = '---\nsubject: Приглашение для {{орг}}\n---\nЗдравствуйте, {{имя}}!';
  const r = renderMessage(src, { орг: 'Университет', имя: 'Иван' });
  assert.strictEqual(r.subject, 'Приглашение для Университет');
  assert.strictEqual(r.text, 'Здравствуйте, Иван!');
  assert.deepStrictEqual(r.missing, []);
});

test('Шаблон: список используемых переменных', () => {
  assert.deepStrictEqual(usedVariables('{{a}} и {{ b }} и снова {{a}}'), ['a', 'b']);
});

test('Аргументы: значения, флаги и --ключ=значение', () => {
  const { positional, opts } = parseArgs(
    ['send', '--to', 'a@b.kz', '--dry-run', '--subject=Тема'],
    { booleans: ['dryRun'] }
  );
  assert.deepStrictEqual(positional, ['send']);
  assert.strictEqual(opts.to, 'a@b.kz');
  assert.strictEqual(opts.dryRun, true);
  assert.strictEqual(opts.subject, 'Тема');
});

test('Аргументы: булев флаг не съедает следующий параметр', () => {
  const { opts } = parseArgs(['--dry-run', '--to', 'a@b.kz'], { booleans: ['dryRun'] });
  assert.strictEqual(opts.dryRun, true);
  assert.strictEqual(opts.to, 'a@b.kz');
});

test('Аргументы: --since понимает относительные интервалы', () => {
  const d = parseSince('7d');
  const days = (Date.now() - d.getTime()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, `ожидалось ~7 дней, вышло ${days}`);
  assert.throws(() => parseSince('позавчера'), /Не разобрать/);
});

test('Адреса: разбор списка и проверка', () => {
  assert.deepStrictEqual(addressList('a@b.kz, c@d.kz'), ['a@b.kz', 'c@d.kz']);
  assert.ok(isValidAddress('a@b.kz'));
  assert.ok(!isValidAddress('не адрес'));
  assert.ok(!isValidAddress('a@b'));
});

test('Письмо: без получателя и с битым адресом не собирается', () => {
  assert.throws(() => normalizeOutgoing({ subject: 'x' }), /получател/);
  assert.throws(() => normalizeOutgoing({ to: 'кривой', subject: 'x' }), /Неверные адреса/);
});

test('Рассылка: колонка с адресом ищется по разным названиям', () => {
  assert.strictEqual(pickEmailColumn(['Имя', 'email']), 'email');
  assert.strictEqual(pickEmailColumn(['Имя', 'Почта']), 'Почта');
  assert.strictEqual(pickEmailColumn(['Имя', 'E-Mail адрес']), 'E-Mail адрес');
  assert.strictEqual(pickEmailColumn(['Имя', 'Телефон']), null);
});

test('Рассылка: журнал даёт список уже отправленных, битые строки не роняют чтение', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbot-'));
  const journal = path.join(dir, 'j.jsonl');
  appendJournal(journal, { email: 'a@b.kz', status: 'sent' });
  appendJournal(journal, { email: 'c@d.kz', status: 'failed' });
  fs.appendFileSync(journal, '{битый json\n');
  appendJournal(journal, { email: 'E@F.KZ', status: 'sent' });

  const sent = loadSent(journal);
  assert.ok(sent.has('a@b.kz'), 'отправленный попал в список');
  assert.ok(!sent.has('c@d.kz'), 'неудачная отправка не считается доставленной');
  assert.ok(sent.has('e@f.kz'), 'регистр адреса не важен');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Рассылка: имя журнала стабильно между запусками — иначе --resume не сработает', () => {
  const a = journalPathFor('/root', 'lists/people.csv', 'letters/invite.md');
  const b = journalPathFor('/root', 'lists/people.csv', 'letters/invite.md');
  assert.strictEqual(a, b);
  assert.match(a, /invite--people\.jsonl$/);
});

test('Конфигурация: пресет подмешивается, но запись аккаунта важнее', () => {
  const acc = resolveAccount('gmail', {
    preset: 'gmail',
    address: 'me@gmail.com',
    smtp: { port: 587, secure: false },
  });
  assert.strictEqual(acc.type, 'smtp-imap');
  assert.strictEqual(acc.smtp.host, 'smtp.gmail.com', 'хост из пресета');
  assert.strictEqual(acc.smtp.port, 587, 'порт переопределён аккаунтом');
  assert.strictEqual(acc.imap.host, 'imap.gmail.com');
  assert.strictEqual(acc.limits.perDay, 500);
});

test('Конфигурация: пароль берётся из окружения, а не из файла', () => {
  process.env.MAILBOT_TEST_PASS = 'секрет';
  const acc = resolveAccount('t', {
    preset: 'gmail',
    address: 'me@gmail.com',
    passEnv: 'MAILBOT_TEST_PASS',
  });
  assert.strictEqual(acc.pass, 'секрет');
  delete process.env.MAILBOT_TEST_PASS;
});

test('Конфигурация: браузерный ящик получает свой профиль и адрес почты', () => {
  const acc = resolveAccount('personal', { preset: 'outlook-personal', address: 'me@outlook.com' });
  assert.strictEqual(acc.type, 'outlook-web');
  assert.strictEqual(acc.mailUrl, 'https://outlook.live.com/mail/');
  assert.match(acc.profile, /profiles[\\/]personal$/);
});

test('Конфигурация: понятные ошибки вместо падения', () => {
  assert.throws(() => resolveAccount('x', { address: 'a@b.kz' }), /не указан ни type, ни preset/);
  assert.throws(() => resolveAccount('x', { preset: 'нетакого' }), /Неизвестный провайдер/);
});

test('Домен веб-Outlook: новый cloud.microsoft распознаётся как почта', () => {
  const { MAIL_HOST_RE } = require('../src/transports/outlook-web');
  assert.ok(MAIL_HOST_RE.test('https://outlook.cloud.microsoft/mail/'));
  assert.ok(MAIL_HOST_RE.test('https://outlook.office.com/mail/inbox'));
  assert.ok(MAIL_HOST_RE.test('https://outlook.live.com/mail/0/'));
  assert.ok(!MAIL_HOST_RE.test('https://login.microsoftonline.com/'));
});

// --- Разбор строки списка веб-Outlook ---
// Разметка не даёт полей напрямую, поэтому разбор эвристический — и потому нуждается
// в тестах: сюда попадали и глифы иконок, и инициалы аватара вместо имени.
function outlookRow(parts, label = '') {
  const OutlookWeb = require('../src/transports/outlook-web');
  const t = new OutlookWeb({ name: 'work', type: 'outlook-web' });
  return t.toMessage({ parts, label }, 'inbox', 0);
}

test('Outlook: отправитель, тема и дата разделяются', () => {
  const m = outlookRow([
    'Tolganay T. Chinibayeva; Nazym Kozhayeva',
    'Актуализированная информация по справочнику',
    'Пт, 12:48',
    'Здравствуйте! на кафедре КИ…',
  ]);
  assert.strictEqual(m.from, 'Tolganay T. Chinibayeva; Nazym Kozhayeva');
  assert.strictEqual(m.subject, 'Актуализированная информация по справочнику');
  assert.strictEqual(m.date, 'Пт, 12:48');
  assert.match(m.snippet, /^Здравствуйте/);
});

test('Outlook: инициалы аватара не принимаются за отправителя', () => {
  const m = outlookRow(['MA', 'Mariam Akhmet', 'Организационное объявление', '12:14', 'Добрый день!']);
  assert.strictEqual(m.from, 'Mariam Akhmet');
  assert.strictEqual(m.subject, 'Организационное объявление');
});

test('Outlook: служебные подписи разметки отбрасываются', () => {
  const m = outlookRow(['Свернуто', 'Есть вложения', 'Иван Петров', 'Тема', '10:02', 'Текст']);
  assert.strictEqual(m.from, 'Иван Петров');
  assert.strictEqual(m.subject, 'Тема');
});

test('Outlook: непрочитанное определяется по aria-label', () => {
  const m = outlookRow(['Иван', 'Тема', '10:02', 'Текст'], 'Непрочитанное Иван Тема');
  assert.strictEqual(m.unread, true);
});

test('Outlook: разные форматы даты распознаются как разделитель', () => {
  for (const d of ['12:48', 'Пт, 12:48', '16.08.2026', 'Mon 09:05']) {
    const m = outlookRow(['Иван', 'Тема', d, 'Текст']);
    assert.strictEqual(m.date, d, `дата «${d}» должна распознаваться`);
    assert.strictEqual(m.subject, 'Тема');
  }
});

test('Outlook: пробелы в теме кодируются как %20, а не как плюс', () => {
  const { composeQuery } = require('../src/transports/outlook-web');
  const q = composeQuery({ to: ['a@b.kz'], cc: [], bcc: [], subject: 'Тема с пробелами', text: 'Текст' });
  assert.ok(!q.includes('+'), 'плюс попал бы прямо в тему письма');
  assert.ok(q.includes('%20'), 'пробел должен быть %20');
  assert.strictEqual(decodeURIComponent(q.split('subject=')[1].split('&')[0]), 'Тема с пробелами');
});

test('Outlook: пустые копия и скрытая копия не попадают в ссылку', () => {
  const { composeQuery } = require('../src/transports/outlook-web');
  const q = composeQuery({ to: ['a@b.kz'], cc: [], bcc: [], subject: 'Т', text: 'x' });
  assert.ok(!q.includes('cc='), 'пустой cc не нужен');
  assert.ok(!q.includes('bcc='));
});

test('Сводка: нераспознанная дата веб-Outlook не роняет вывод', () => {
  const { summarize, formatDate } = require('../src/message');
  assert.strictEqual(formatDate('Пт, 12:48'), 'Пт, 12:48');
  assert.strictEqual(formatDate('2026-08-17T05:20:53.174Z'), '2026-08-17 05:20');
  assert.doesNotThrow(() => summarize({ date: 'Пт, 12:48', from: 'Иван', subject: 'Тема' }));
});
