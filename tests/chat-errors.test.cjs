const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatService } = require('../src/services/chat.cjs');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-chat-err-'));
  return { dir, file: path.join(dir, 'chat.json') };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function sseServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta) => res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n');
      await handler({ req, res, emit, requests, count: requests.length });
    });
  });
  return { server, requests };
}

const CONFIG = (port) => ({ apiBaseUrl: `http://127.0.0.1:${port}/v4`, model: 'test', apiKey: 'dummy-not-a-real-key' });
const TASK_TOOL = [{ type: 'function', function: { name: 'create_task', description: '创建任务', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }];

test('并发发送被拒绝且结束后 busy 复位可继续发送', async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let hold = false;
  const { server } = sseServer(async ({ res, emit, count }) => {
    if (count === 1 && hold) await delay(120);
    emit({ content: '好' });
    res.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const chat = new ChatService({ filePath: file });

  hold = true;
  const first = chat.send({ text: '第一条', config: CONFIG(port), onEvent: () => {} });
  assert.equal(chat.busy, true);
  await assert.rejects(() => chat.send({ text: '第二条', config: CONFIG(port) }), /正在进行/);
  assert.equal(await first, '好');
  assert.equal(chat.busy, false);
  hold = false;
  assert.equal(await chat.send({ text: '第三条', config: CONFIG(port), onEvent: () => {} }), '好');
});

test('HTTP 失败真实反馈并复位 busy，未产生的用户消息回滚', async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '配额不足' } }));
    });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const chat = new ChatService({ filePath: file });
  const events = [];

  await assert.rejects(
    () => chat.send({ text: '你好', config: CONFIG(port), onEvent: (e) => events.push(e) }),
    /配额不足/,
  );
  assert.equal(chat.busy, false);
  assert.deepEqual(chat.messages(), []);
  assert.ok(events.some((e) => e.type === 'error' && /配额不足/.test(e.message)));
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  assert.ok(!raw.includes('你好'));
});

test('工具失败进入下一轮上下文与 tool 事件，不伪造成功', async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { server, requests } = sseServer(async ({ res, emit, count }) => {
    if (count === 1) {
      emit({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'create_task', arguments: '{"text":"写周报"}' } }] });
    } else {
      emit({ content: '便签服务没连上，这条没保存成。' });
    }
    res.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const chat = new ChatService({ filePath: file });
  const events = [];
  let calls = 0;

  const result = await chat.send({
    text: '记一下写周报',
    config: CONFIG(port),
    tools: TASK_TOOL,
    executeTool: async () => { calls++; throw new Error('便签服务未连接'); },
    onEvent: (e) => events.push(e),
  });
  assert.equal(calls, 1);
  assert.equal(result, '便签服务没连上，这条没保存成。');
  const toolMsg = requests[1].messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.match(toolMsg.content, /便签服务未连接/);
  assert.equal(requests[1].messages[2].role, 'assistant');
  assert.ok(requests[1].messages[2].tool_calls[0].function.name === 'create_task');
  const toolEvent = events.find((e) => e.type === 'tool');
  assert.equal(toolEvent.name, 'create_task');
  assert.equal(toolEvent.result.error, '便签服务未连接');
  assert.deepEqual(chat.messages(), [
    { role: 'user', content: '记一下写周报' },
    { role: 'assistant', content: '便签服务没连上，这条没保存成。' },
  ]);
});

test('arguments 不是有效 JSON 时不执行工具并真实回执', async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { server, requests } = sseServer(async ({ res, emit, count }) => {
    if (count === 1) {
      emit({ tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'create_task', arguments: '{"text":' } }] });
    } else {
      emit({ content: '参数坏了。' });
    }
    res.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const chat = new ChatService({ filePath: file });
  let calls = 0;
  const events = [];

  const result = await chat.send({
    text: '记一下',
    config: CONFIG(port),
    tools: TASK_TOOL,
    executeTool: async () => { calls++; return {}; },
    onEvent: (e) => events.push(e),
  });
  assert.equal(calls, 0);
  assert.equal(result, '参数坏了。');
  assert.match(requests[1].messages.find((m) => m.role === 'tool').content, /不是有效的 JSON/);
  const toolEvent = events.find((e) => e.type === 'tool');
  assert.equal(toolEvent.result.error, '工具参数不是有效的 JSON');
});

test('中途取消：busy 复位、部分正文保留、可继续发送', async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { server } = sseServer(async ({ res, emit, count }) => {
    if (count === 1) {
      emit({ content: '部分' });
      await delay(5000); // 挂住直到客户端取消断开
      return;
    }
    emit({ content: '好了' });
    res.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const chat = new ChatService({ filePath: file });
  const events = [];
  const ac = new AbortController();

  const pending = chat.send({ text: '帮我看看', config: CONFIG(port), signal: ac.signal, onEvent: (e) => events.push(e) });
  await delay(50);
  assert.ok(events.some((e) => e.type === 'delta' && e.text === '部分'));
  ac.abort();
  await assert.rejects(() => pending);
  assert.equal(chat.busy, false);
  assert.deepEqual(chat.messages(), [
    { role: 'user', content: '帮我看看' },
    { role: 'assistant', content: '部分' },
  ]);
  assert.ok(events.some((e) => e.type === 'error' && e.message === '已取消'));
  assert.equal(await chat.send({ text: '继续', config: CONFIG(port), onEvent: () => {} }), '好了');
});

test('工具调用轮数达到上限即停止，已执行动作真实保留', async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { server, requests } = sseServer(async ({ res, emit, count }) => {
    emit({ tool_calls: [{ index: 0, id: `call_${count}`, type: 'function', function: { name: 'create_task', arguments: '{"text":"又来"}' } }] });
    res.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const chat = new ChatService({ filePath: file });
  const events = [];
  let executed = 0;

  await assert.rejects(
    () => chat.send({
      text: '开始',
      config: CONFIG(port),
      tools: TASK_TOOL,
      executeTool: async () => { executed++; return { id: String(executed) }; },
      maxRounds: 2,
      onEvent: (e) => events.push(e),
    }),
    /上限/,
  );
  assert.equal(executed, 2);
  assert.equal(requests.length, 2);
  assert.ok(events.some((e) => e.type === 'error' && /上限/.test(e.message)));
  assert.deepEqual(chat.messages(), [{ role: 'user', content: '开始' }]);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.includes('"role": "tool"'));
  assert.ok(!raw.includes('dummy-not-a-real-key'));
});

test('会话跨实例持久化且 clear 可清空，不含 Key', async (t) => {
  const { dir, file } = tempFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { server } = sseServer(async ({ res, emit }) => {
    emit({ content: '在的' });
    res.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const chat = new ChatService({ filePath: file });
  await chat.send({ text: '在吗', config: CONFIG(port), onEvent: () => {} });
  const again = new ChatService({ filePath: file });
  assert.deepEqual(again.messages(), [
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '在的' },
  ]);
  again.clear();
  assert.deepEqual(again.messages(), []);
  const third = new ChatService({ filePath: file });
  assert.deepEqual(third.messages(), []);
});
