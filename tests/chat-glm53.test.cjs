const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatService } = require('../src/services/chat.cjs');

test('GLM 5.3 thinking-only protocol completes streamed task call without exposing reasoning', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-glm53-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let turns = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (body.thinking?.type !== 'enabled' || body.reasoning_effort !== 'low') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'GLM 5.3 requires enabled thinking and low effort for this session' } }));
      return;
    }
    if (turns > 0 && !body.messages.some(m => m.role === 'assistant' && m.tool_calls && m.reasoning_content === '内部推理不应出现在气泡或聊天正文')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Tool result must include the unchanged assistant reasoning_content' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = value => res.write(`data: ${JSON.stringify({ choices: [{ delta: value }] })}\n\n`);
    turns++;
    delta({ reasoning_content: '内部推理不应出现在气泡或聊天正文' });
    if (turns === 1) {
      delta({ tool_calls: [{ index: 0, id: 'record', type: 'function', function: { name: 'create_task', arguments: '{"text":"喝水"}' } }] });
    } else {
      const receipt = body.messages.find(m => m.role === 'tool');
      delta({ content: JSON.parse(receipt.content).id === 'task-53' ? '已记录喝水待办' : '工具回执错误' });
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const service = new ChatService({ filePath: path.join(dir, 'chat.json') });
  const events = [];
  const tasks = new Map();
  const answer = await service.send({
    text: '记录喝水待办',
    config: { apiBaseUrl: `http://127.0.0.1:${server.address().port}`, model: 'glm-5.3-flash', apiKey: 'test-key' },
    tools: [{ type: 'function', function: { name: 'create_task', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }],
    executeTool: async (name, args) => {
      assert.equal(name, 'create_task');
      tasks.set('task-53', args.text);
      return { id: 'task-53', text: args.text };
    },
    onEvent: event => events.push(event)
  });
  assert.equal(answer, '已记录喝水待办');
  assert.equal(tasks.get('task-53'), '喝水');
  assert.equal(turns, 2);
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), answer);
  assert.deepEqual(service.messages(), [{ role: 'user', content: '记录喝水待办' }, { role: 'assistant', content: answer }]);
});
