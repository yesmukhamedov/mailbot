// Шаблон письма: заголовок в front-matter + тело с подстановками {{переменная}}.
//
//   ---
//   subject: Приглашение для {{имя}}
//   ---
//   Здравствуйте, {{имя}}!
//
// Пропущенные переменные не заменяем молча на пустоту: в рассылке это даёт письма вида
// «Здравствуйте, !». Собираем их список и отдаём наверх, чтобы --dry-run показал проблему
// до отправки, а не после.

const VAR_RE = /\{\{\s*([^}\s][^}]*?)\s*\}\}/g;

// Разбираем только плоские «ключ: значение» — полноценный YAML тут не нужен.
function parseFrontMatter(source) {
  const text = source.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf(':');
    if (at === -1) continue;
    const key = trimmed.slice(0, at).trim();
    let value = trimmed.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

// Подставляет значения; возвращает результат и список незаполненных переменных.
function render(template, vars = {}) {
  const missing = new Set();
  const text = String(template).replace(VAR_RE, (whole, name) => {
    const key = name.trim();
    const value = vars[key];
    if (value == null || String(value).trim() === '') {
      missing.add(key);
      return whole; // оставляем как есть, чтобы проблема была видна глазами
    }
    return String(value);
  });
  return { text, missing: [...missing] };
}

// Готовит письмо для одного получателя.
function renderMessage(source, vars) {
  const { meta, body } = parseFrontMatter(source);
  const subject = render(meta.subject || '', vars);
  const text = render(body.trim(), vars);
  return {
    subject: subject.text,
    text: text.text,
    missing: [...new Set([...subject.missing, ...text.missing])],
    meta,
  };
}

// Какие переменные вообще использует шаблон — для проверки колонок CSV.
function usedVariables(source) {
  const found = new Set();
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(source))) found.add(m[1].trim());
  return [...found];
}

module.exports = { parseFrontMatter, render, renderMessage, usedVariables };
