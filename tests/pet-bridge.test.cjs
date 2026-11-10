const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../../便签/task-store.cjs');
const { createPetBridge } = require('../../便签/pet-bridge.cjs');

function setup(t, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'sticky-note-data.json');
  if (seed) fs.writeFileSync(filePath, JSON.stringify(seed));
  const store = new TaskStore({ filePath });
  const bridge = createPetBridge({ store, dataDir: dir });
  t.after(() => bridge.close());
  return { dir, filePath, store, bridge };
}

function req(port, token, method, p, body) {
  return fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

function sseConnect(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/events',
      headers: { authorization: `Bearer ${token}` }
    }, (res) => {
      let buf = '';
      const waiters = [];
      const queue = []; // 已到达但尚未被 next() 消费的事件（快照可能在 await 恢复前到达）
      const deliver = (ev) => {
        const waiter = waiters.shift();
        if (waiter) waiter(ev); else queue.push(ev);
      };
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data = line.slice(6);
          }
          deliver(ev);
        }
      });
      resolve({
        next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
        close: () => req.destroy()
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('bridge handshake, auth and state endpoints', async (t) => {
  const { bridge } = setup(t, { version: 1, title: '我的便签', themeColor: '#123456', items: [{ id: 'old', text: '原任务', status: 'todo', createdAt: '2026-01-01T00:00:00Z' }] });
  const { port, token } = await bridge.start();

  const noAuth = await req(port, null, 'GET', '/v1/state');
  assert.equal(noAuth.status, 401);
  assert.ok((await noAuth.json()).error);

  const badAuth = await req(port, 'wrong', 'GET', '/v1/state');
  assert.equal(badAuth.status, 401);

  const state = await req(port, token, 'GET', '/v1/state');
  assert.equal(state.status, 200);
  const snap = await state.json();
  assert.equal(typeof snap.revision, 'number');
  assert.equal(snap.data.title, '我的便签');
  assert.equal(snap.data.items[0].text, '原任务');

  const missing = await req(port, token, 'GET', '/v1/nope');
  assert.equal(missing.status, 404);

  // 握手文件与契约一致，close 后只清理自己的这一份
  const descriptorPath = path.join(path.dirname(''), ''); // placeholder, real check below
  assert.ok(bridge.running);
  assert.equal(typeof port, 'number');
  assert.match(token, /^[0-9a-f]{64}$/);
});

test('create/patch round-trip: validation, 404, revision conflict, reminder reset', async (t) => {
  const { dir, filePath, store, bridge } = setup(t);
  const { port, token } = await bridge.start();

  const bad = await req(port, token, 'POST', '/v1/tasks', { text: '   ' });
  assert.equal(bad.status, 400);

  const badField = await req(port, token, 'POST', '/v1/tasks', { text: 'x', status: 'done' });
  assert.equal(badField.status, 200); // create 只挑白名单字段，多余字段忽略
  const badFieldBody = await badField.json();
  assert.equal(badFieldBody.item.status, 'todo');

  const created = await req(port, token, 'POST', '/v1/tasks', { text: '外部新任务', remindAt: '2030-01-01T00:00:00+08:00', images: ['data:image/png;base64,AAAA'] });
  assert.equal(created.status, 200);
  const { item, snapshot } = await created.json();
  assert.equal(item.text, '外部新任务');
  assert.equal(item.status, 'todo');
  assert.equal(item.reminded, false);
  assert.equal(typeof snapshot.revision, 'number');
  assert.ok(Array.isArray(snapshot.data.items));

  // 落盘校验：revision 持久化、任务和图片都在文件里
  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(saved.revision, snapshot.revision);
  assert.equal(saved.items.find((x) => x.id === item.id).images[0], 'data:image/png;base64,AAAA');

  const notFound = await req(port, token, 'PATCH', '/v1/tasks/ghost', { text: 'x' });
  assert.equal(notFound.status, 404);

  const badPatch = await req(port, token, 'PATCH', `/v1/tasks/${item.id}`, { title: '越权字段' });
  assert.equal(badPatch.status, 400);

  const stale = await req(port, token, 'PATCH', `/v1/tasks/${item.id}`, { revision: snapshot.revision - 1, text: 'x' });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.ok(conflict.error);
  assert.equal(conflict.snapshot.revision, snapshot.revision);

  // remindAt 变更重置 reminded 并保留其他任务
  store.update(item.id, { reminded: true });
  const rearm = await req(port, token, 'PATCH', `/v1/tasks/${item.id}`, { remindAt: '2030-02-01T12:00:00+08:00' });
  assert.equal(rearm.status, 200);
  const rearmBody = await rearm.json();
  assert.equal(rearmBody.item.reminded, false);
  assert.equal(store.snapshot().data.items.find((x) => x.id === item.id).reminded, false);

  const malformed = await req(port, token, 'PATCH', `/v1/tasks/${item.id}`, { remindAt: '不是时间' });
  assert.equal(malformed.status, 400);
});

test('SSE: snapshot on connect, state on change, reminder event, descriptor cleanup', async (t) => {
  const { dir, store, bridge } = setup(t);
  const { port, token } = await bridge.start();

  const sse = await sseConnect(port, token);
  const first = await sse.next();
  assert.equal(first.event, 'snapshot');
  const firstSnap = JSON.parse(first.data);
  assert.equal(typeof firstSnap.revision, 'number');

  const created = await req(port, token, 'POST', '/v1/tasks', { text: '推送这条' });
  const { item } = await created.json();
  const second = await sse.next();
  assert.equal(second.event, 'state');
  const stateSnap = JSON.parse(second.data);
  assert.equal(stateSnap.revision, firstSnap.revision + 1);
  assert.ok(stateSnap.data.items.some((x) => x.id === item.id && x.text === '推送这条'));

  bridge.emitReminder({ ...item, reminded: true });
  const third = await sse.next();
  assert.equal(third.event, 'reminder');
  assert.equal(JSON.parse(third.data).item.id, item.id);
  sse.close();

  // 握手文件在运行期存在且字段齐全
  const descriptor = JSON.parse(fs.readFileSync(path.join(dir, 'pet-bridge.json'), 'utf8'));
  assert.equal(descriptor.version, 1);
  assert.equal(descriptor.port, port);
  assert.equal(descriptor.token, token);
  assert.equal(descriptor.pid, process.pid);

  bridge.close();
  assert.equal(fs.existsSync(path.join(dir, 'pet-bridge.json')), false);
  assert.equal(bridge.running, false);
});
