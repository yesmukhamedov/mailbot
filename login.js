// Совместимость с первой версией: node login.js
// Новый способ: mailbot login <имя ящика>
const { spawnSync } = require('child_process');
const path = require('path');
const { readConfig } = require('./src/config');

const cfg = readConfig();
const name = process.argv[2] || cfg.defaultAccount || Object.keys(cfg.accounts)[0];
if (!name) {
  console.error('Ящиков не настроено. Начните с `mailbot account add`.');
  process.exit(1);
}

const res = spawnSync(
  process.execPath,
  [path.join(__dirname, 'bin', 'mailbot.js'), 'login', name],
  { stdio: 'inherit' }
);
process.exit(res.status === null ? 1 : res.status);
