const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalNoteReader } = require('../src/services/local-note-reader.cjs');

function waitForState(reader, predicate) {
  if (predicate(reader.snapshot())) return Promise.resolve(reader.snapshot());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reader.off('state', changed); reject(new Error('未收到预期的便签变化')); }, 5000);
    function changed(state) {
      if (!predicate(state)) return;
      clearTimeout(timeout);
      reader.off('state', changed);
      resolve(state);
    }
    reader.on('state', changed);
  });
}

function fixture(t, items, onReminder) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-local-notes-'));
  const file = path.join(dir, 'sticky-note-data.json');
  const data = { version: 1, title: '本机便签', theme: 'yellow', items };
  fs.writeFileSync(file, JSON.stringify(data));
  const reader = new LocalNoteReader({ dataDir: dir, onReminder });
  t.after(() => { reader.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { reader, file, data };
}

test('reads installed legacy data without a bridge and observes external changes without writing', async t => {
  const { reader, file, data } = fixture(t, [{ id: 'a', text: '已有本机任务', status: 'todo', images: ['private-image'] }]);
  const original = fs.readFileSync(file, 'utf8');
  await reader.connect();
  assert.equal(reader.snapshot().connected, true);
  assert.equal(reader.snapshot().items[0].text, '已有本机任务');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  data.items[0].status = 'done';
  data.items.push({ id: 'b', text: '便签中新建的任务', status: 'todo' });
  fs.writeFileSync(file, JSON.stringify(data));
  const updated = await waitForState(reader, state => state.items.find(item => item.id === 'a')?.status === 'done' && state.items.some(item => item.id === 'b'));
  assert.equal(updated.items.find(item => item.id === 'b').text, '便签中新建的任务');
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(data));
});

test('an incomplete external save retains the last valid tasks and recovers on the next save', async t => {
  const { reader, file, data } = fixture(t, [{ id: 'a', text: '不能丢失的任务', status: 'todo' }]);
  await reader.connect();
  fs.writeFileSync(file, '{"items":');
  const interrupted = await waitForState(reader, state => Boolean(state.error));
  assert.equal(interrupted.items[0].text, '不能丢失的任务');
  data.items[0].text = '保存完成后的任务';
  fs.writeFileSync(file, JSON.stringify(data));
  const recovered = await waitForState(reader, state => !state.error && state.items[0]?.text === '保存完成后的任务');
  assert.equal(recovered.connected, true);
});

test('only a newly observed reminded transition presents a reminder, never a startup replay', async t => {
  const reminders = [];
  const { reader, file, data } = fixture(t, [{ id: 'a', text: '已有提醒', status: 'todo', remindAt: '2030-01-01T10:00:00+08:00', reminded: true }], item => reminders.push(item.id));
  await reader.connect();
  assert.deepEqual(reminders, []);
  data.items[0].reminded = false;
  fs.writeFileSync(file, JSON.stringify(data));
  await waitForState(reader, state => state.items[0]?.reminded === false);
  data.items[0].reminded = true;
  fs.writeFileSync(file, JSON.stringify(data));
  await waitForState(reader, state => state.items[0]?.reminded === true);
  assert.deepEqual(reminders, ['a']);
  data.theme = 'blue';
  fs.writeFileSync(file, JSON.stringify(data));
  await reader.connect();
  assert.deepEqual(reminders, ['a']);
});
