// Нормализованная модель письма — общий язык для всех транспортов.
//
// Исходящее: { to[], cc[], bcc[], subject, text }
// Входящее:  { id, from, to[], subject, date, snippet, text, unread, folder, account }

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

function normalizeOutgoing(msg = {}) {
  const out = {
    to: addressList(msg.to),
    cc: addressList(msg.cc),
    bcc: addressList(msg.bcc),
    subject: msg.subject == null ? '' : String(msg.subject),
    text: msg.text == null ? '' : String(msg.text),
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

module.exports = { addressList, isValidAddress, normalizeOutgoing, summarize, formatDate };
