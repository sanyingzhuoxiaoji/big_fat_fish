const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { ChatService } = require('../src/services/chat.cjs');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-chat-storage-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('corrupt saved conversation is reported instead of silently discarded', t => {
  const file = path.join(fixture(t), 'chat.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new ChatService({ filePath: file }), /会话|读取|JSON/);
});
test('failed conversation write is not reported as persisted success', t => {
  const file = path.join(fixture(t), 'chat.json');
  const chat = new ChatService({ filePath: file });
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => chat.clear(), /会话|保存|EISDIR|EPERM/);
});
test('provider error inside a successful HTTP SSE response is surfaced', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"error":{"message":"上游服务暂时不可用"}}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const chat = new ChatService({ filePath: path.join(fixture(t), 'chat.json') });
  await assert.rejects(chat.send({ text: '你好', config: { apiBaseUrl: `http://127.0.0.1:${server.address().port}`, model: 'test', apiKey: 'test-key' } }), /上游服务暂时不可用/);
});
