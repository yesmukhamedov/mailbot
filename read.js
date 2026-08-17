// Совместимость с первой версией: node read.js [сколько] [папка]
// Новый способ: mailbot read --limit N --folder inbox [--from ящик]
const { spawnSync } = require('child_process');
const path = require('path');

const limit = process.argv[2] || '10';
const folder = process.argv[3] || 'inbox';

const res = spawnSync(
  process.execPath,
  [path.join(__dirname, 'bin', 'mailbot.js'), 'read', '--limit', limit, '--folder', folder],
  { stdio: 'inherit' }
);
process.exit(res.status === null ? 1 : res.status);
