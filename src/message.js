// Нормализованная модель письма — общий язык для всех транспортов.
//
// Исходящее: { to[], cc[], bcc[], subject, text, attachments[] }
// Входящее:  { id, from, to[], subject, date, snippet, text, unread, folder, account }

const fs = require('node:fs');
const path = require('node:path');

// Адреса приходят и строкой «a@b, c@d», и массивом. Приводим к массиву без пустых значений.
function addressList(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[,;]/);
  return items.map((s) => String(s).trim()).filter(Boolean);
}

// Проверка нужна до отправки: на сотне адресов одна опечатка иначе всплывёт в середине рассылки.
const ADDRESS_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function isValidAddress(addr) {
  return ADDRESS_RE.test(String(addr).trim());
}

// Практический потолок вложений: Exchange Online и Gmail режут письмо на 25 МБ,
// причём считают уже закодированный размер — base64 добавляет примерно треть.
// Отсюда порог по исходным байтам, а не по 25 МБ.
const ATTACHMENT_LIMIT_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_SAFE_BYTES = Math.floor(ATTACHMENT_LIMIT_BYTES / 1.37);

// Вложения приходят строкой «путь1,путь2» из командной строки или массивом из кода.
// Разбираем и проверяем здесь, а не в транспорте: отсутствующий файл должен всплыть
// до открытия сессии и до того, как письмо частично уйдёт.
function attachmentList(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[,;]/);
  return items
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    .filter(Boolean)
    .map((item) => {
      // Список может прийти уже разобранным: команда проверяет файлы и считает размер
      // до подключения к ящику, а транспорт нормализует то же письмо ещё раз.
      if (typeof item === 'object' && item.path) return item;
      const file = path.resolve(String(item));
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        throw new Error(`Файл вложения не найден: ${item}`);
      }
      if (!stat.isFile()) throw new Error(`Вложение не является файлом: ${item}`);
      return { path: file, name: path.basename(file), size: stat.size };
    });
}

function attachmentsSize(list) {
  return (list || []).reduce((sum, a) => sum + a.size, 0);
}

function normalizeOutgoing(msg = {}) {
  const out = {
    to: addressList(msg.to),
    cc: addressList(msg.cc),
    bcc: addressList(msg.bcc),
    subject: msg.subject == null ? '' : String(msg.subject),
    text: msg.text == null ? '' : String(msg.text),
    attachments: attachmentList(msg.attachments),
  };

  if (!out.to.length && !out.cc.length && !out.bcc.length) {
    throw new Error('Не указан ни один получатель');
  }

  const bad = [...out.to, ...out.cc, ...out.bcc].filter((a) => !isValidAddress(a));
  if (bad.length) {
    throw new Error(`Неверные адреса: ${bad.join(', ')}`);
  }

  return out;
}

// Дата приходит из IMAP в ISO, а из веб-Outlook — строкой интерфейса («Пт, 12:48»),
// которую Date разобрать не может. Показываем как есть, а не роняем вывод.
function formatDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString().slice(0, 16).replace('T', ' ');
}

// Короткая однострочная сводка для человекочитаемого вывода.
function summarize(m) {
  const flag = m.unread ? '•' : ' ';
  const date = formatDate(m.date).padEnd(16);
  return `${flag} ${date}  ${(m.from || '').slice(0, 32).padEnd(32)}  ${m.subject || '(без темы)'}`;
}

module.exports = {
  addressList,
  isValidAddress,
  attachmentList,
  attachmentsSize,
  normalizeOutgoing,
  summarize,
  formatDate,
  ATTACHMENT_LIMIT_BYTES,
  ATTACHMENT_SAFE_BYTES,
};
