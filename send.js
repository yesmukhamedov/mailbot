// Совместимость с первой версией:
//   node send.js --to a@b.com --subject "Тема" --body "Текст" [--dry-run]
// Новый способ: mailbot send --to ... --subject ... --body ... [--from ящик]
const { spawnSync } = require('child_process');
const path = require('path');

const res = spawnSync(
  process.execPath,
  [path.join(__dirname, 'bin', 'mailbot.js'), 'send', ...process.argv.slice(2)],
  { stdio: 'inherit' }
);
process.exit(res.status === null ? 1 : res.status);
