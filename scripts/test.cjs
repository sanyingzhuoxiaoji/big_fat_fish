'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = path.join(root, '.local', 'tmp');
fs.mkdirSync(temp, { recursive: true });
const files = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', ...(files.length ? files : ['tests/*.test.cjs'])], {
  cwd: root, stdio: 'inherit', env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp }
});
if (result.error) { console.error(result.error.message); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
