// Минимальный разбор CSV по RFC 4180: кавычки, запятые и переводы строк внутри полей,
// удвоенные кавычки как экранирование. Отдельная зависимость ради этого не нужна.
//
// Разделитель определяем сами: Excel в русской локали выгружает через «;», а не «,»,
// и без этого список получателей молча читается как одна колонка.

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  let inQuotes = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

// Возвращает массив строк, каждая — массив полей.
function parseRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // перевод строки обработаем на \n; одиночный \r игнорируем
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Читает CSV с заголовком в первой строке и отдаёт массив объектов.
function parseCsv(text, { delimiter } = {}) {
  const clean = text.replace(/^﻿/, ''); // BOM от Excel
  if (!clean.trim()) return [];

  const delim = delimiter || detectDelimiter(clean);
  const rows = parseRows(clean, delim).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) return [];

  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    header.forEach((key, i) => {
      if (key) obj[key] = (cells[i] || '').trim();
    });
    return obj;
  });
}

module.exports = { parseCsv, parseRows, detectDelimiter };
