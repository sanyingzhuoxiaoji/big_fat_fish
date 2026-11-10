const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppService } = require('../src/app-service.cjs');

test('installed-note tasks can bind focus but public mutation requests cannot change the note data', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-readonly-'));
  const noteDataDir = path.join(dir, 'notes');
  fs.mkdirSync(noteDataDir);
  const file = path.join(noteDataDir, 'sticky-note-data.json');
  const original = JSON.stringify({ title: '用户便签', theme: 'yellow', items: [{ id: 'local-a', text: '只在便签里修改', status: 'todo' }] });
  fs.writeFileSync(file, original);
  const service = createAppService({ dataDir: path.join(dir, 'fish'), noteDataDir });
  t.after(() => { service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await service.init();
  assert.equal(service.state().notes.items[0]?.text, '只在便签里修改');
  await assert.rejects(service.handle('createTask', { text: '禁止写入' }), /未知操作|只读/);
  await assert.rejects(service.handle('updateTask', { id: 'local-a', patch: { text: '禁止改字', status: 'done' } }), /未知操作|只读/);
  const focus = await service.handle('startFocus', { taskId: 'local-a', workMinutes: 1 });
  assert.equal(focus.taskId, 'local-a');
  assert.equal(focus.text, '只在便签里修改');
  assert.equal(focus.phase, 'work');
  await service.handle('stopFocus');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
