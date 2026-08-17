// Разбор аргументов командной строки: --ключ значение, --флаг, позиционные.
// Отдельная библиотека ради этого не нужна.

function parseArgs(argv, { booleans = [] } = {}) {
  const positional = [];
  const opts = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    let key = token.slice(2);
    let value;

    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }

    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    if (value !== undefined) {
      opts[camel] = value;
    } else if (booleans.includes(camel) || booleans.includes(key)) {
      opts[camel] = true;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[camel] = true;
      } else {
        opts[camel] = next;
        i++;
      }
    }
  }

  return { positional, opts };
}

// «7d», «24h», «30m» → Date в прошлом. Для --since.
function parseSince(value) {
  if (!value || value === true) return null;
  const m = /^(\d+)\s*([dhm])$/i.exec(String(value).trim());
  if (m) {
    const n = parseInt(m[1], 10);
    const ms = { d: 86400000, h: 3600000, m: 60000 }[m[2].toLowerCase()];
    return new Date(Date.now() - n * ms);
  }
  const date = new Date(value);
  if (isNaN(date)) throw new Error(`Не разобрать --since «${value}». Ожидается 7d, 24h или дата.`);
  return date;
}

module.exports = { parseArgs, parseSince };
