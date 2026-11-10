'use strict';

/**
 * ChatService —— GLM（OpenAI 兼容 chat/completions）流式聊天 + 工具调用循环。
 *
 * 公开接口（见 docs/CONTRACTS.md）：
 *   new ChatService({ filePath, fetchImpl?, now? })
 *   messages()                       仅可展示的 user/assistant 记录（[{role,content}]）
 *   clear()                          清空并落盘会话；busy 时拒绝
 *   send({ text, config:{apiBaseUrl,model,apiKey,thinking?,reasoningEffort?}, tools?, executeTool?, onEvent?, signal?, maxRounds? })
 *     -> 最终 assistant 内容；busy 时抛 code='BUSY'，结束（含失败/取消）后复位
 *   get busy()                       是否有回复进行中
 *
 * 事件（onEvent）：{type:'start'} {type:'delta',text} {type:'tool',name,result}
 *                 {type:'done',text} {type:'error',message}
 * result 为进入模型上下文的回执值；失败时为 {error}。
 *
 * 错误约定：send() 以真实失败 reject（HTTP 状态与响应体摘要在 message，
 * code='HTTP_<status>'；SSE 内 error 载荷 code='PROVIDER_ERROR'；轮数上限
 * code='ROUND_LIMIT'；并发 code='BUSY'；取消时 reject 传入 signal 的 reason）。
 * 会话文件缺失视为空会话；损坏或不可读在构造时抛错，保存失败（clear/commit）抛错，
 * 均不吞错、不伪造成功。工具失败不抛出，而是以 {error} 回执进入下一轮上下文并随
 * 'tool' 事件上报。不自动重试。
 *
 * 持久化只保存 messages，绝不写入 Key。GLM 5.3 默认开启思考并使用 low 强度，
 * 其他模型默认关闭思考；传 thinking:false 可省略该字段（非 GLM 端点）。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_API_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MAX_ROUNDS = 8;

function busyError() {
  const err = new Error('已有回复正在进行，请等待完成或取消后再发送');
  err.code = 'BUSY';
  return err;
}

function abortReason(signal) {
  return (signal && signal.reason) || new Error('已取消');
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function localClock(now) {
  let timeZone = '本地时区';
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone; } catch {}
  let weekday = '';
  try { weekday = now.toLocaleDateString('zh-CN', { weekday: 'long' }); } catch {}
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return { date, time, weekday, timeZone };
}

function buildSystemPrompt(now) {
  const { date, time, weekday, timeZone } = localClock(now);
  return [
    // 双向模式原提示暂存：'你是"大肥鱼"，一只圆滚滚的桌面宠物鱼，帮用户记待办、开番茄钟、陪聊。用中文回复，自然、友好、简短，不要长篇大论。',
    '你是"大肥鱼"，陪用户聊天、查看本机便签、开番茄钟。用中文回复，自然、友好、简短，不要长篇大论。',
    `当前本地时间：${date} ${time}（${weekday}，时区 ${timeZone}）。用户说"今天、明天、下午"这类时间时，以这个时间为准。`,
    '规则：',
    // 双向模式原规则暂存：'- 创建或修改带日期时间的任务时，如果哪一天或几点不明确，先用一句话问清楚，再调用工具。',
    '- 当前便签是本机便签到大肥鱼的单向只读同步。你只能查询待办和绑定专注，不能新增、修改、完成任务或设置提醒；需要编辑时请用户在本机便签中操作。',
    '- 只有工具执行成功返回后才算完成；没有工具回执，绝不要声称已保存、已修改或已完成。',
    '- 番茄钟结束只代表专注时间结束，不代表任务完成，不要替用户把任务标记为完成。',
    '- 工具失败或结果里带 error 时，如实告诉用户出了什么问题，不要编造成功。',
    '- 工具返回的内部数据不要原样贴出来，用一两句话总结给用户。',
    '- 模型就绪且提供pet_react时，每轮根据聊天语气自然选择一次合适表情和动作，例如开心挥手、害羞点头、疑惑歪头、讲解竖指；不要每次固定同一种反应。严肃或难过的内容要匹配情绪，不必强行动作。',
    '- pet_react只允许当前模型提供的表情和动作。playing回执只表示动作实际启动；没有工具或调用失败时说明无法控制，不要用文字假装动作已经播放，更不能声称播放已经完成。',
  ].join('\n');
}

/** 跨网络 chunk 的 SSE 解析：跨包粘包/断包、多行 data、[DONE]。 */
async function* ssePayloads(bodyStream, signal) {
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = null;
  let finished = false;

  const takeLine = (rawLine) => {
    let line = rawLine;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      if (dataLines === null) return null;
      const data = dataLines.join('\n');
      dataLines = null;
      if (data === '[DONE]') { finished = true; return null; }
      try { return JSON.parse(data); } catch { return null; }
    }
    if (line.startsWith(':')) return null;
    if (line.startsWith('data')) {
      let value = line.slice(4);
      if (value.startsWith(':')) value = value.slice(1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (dataLines === null) dataLines = [];
      dataLines.push(value);
    }
    return null;
  };

  const drain = function* (chunk) {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const payload = takeLine(line);
      if (payload != null) yield payload;
      if (finished) return;
    }
  };

  try {
    while (true) {
      if (signal && signal.aborted) throw abortReason(signal);
      const { value, done } = await reader.read();
      if (done) break;
      for (const payload of drain(decoder.decode(value, { stream: true }))) yield payload;
      if (finished) break;
    }
    if (!finished) {
      buffer += decoder.decode();
      if (buffer.length) {
        const payload = takeLine(buffer);
        buffer = '';
        if (payload != null) yield payload;
      }
      if (!finished && dataLines !== null) {
        const data = dataLines.join('\n');
        dataLines = null;
        if (data !== '[DONE]') {
          try {
            const payload = JSON.parse(data);
            if (payload != null) yield payload;
          } catch {}
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

/** 按 index 合并分片 tool_calls：id/name/arguments 可能分多次到达。 */
function mergeToolCallParts(into, parts) {
  for (const part of parts || []) {
    const index = Number.isInteger(part.index) ? part.index : into.size;
    let call = into.get(index);
    if (!call) {
      call = { index, id: '', type: 'function', function: { name: '', arguments: '' } };
      into.set(index, call);
    }
    if (part.id) call.id = part.id;
    if (part.type) call.type = part.type;
    const fn = part.function || {};
    if (fn.name) {
      const current = call.function.name;
      if (!current || fn.name.startsWith(current)) call.function.name = fn.name;
      else call.function.name = current + fn.name;
    }
    if (typeof fn.arguments === 'string' && fn.arguments) call.function.arguments += fn.arguments;
  }
}

function extractErrorMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  try {
    const data = JSON.parse(trimmed);
    return (data.error && (data.error.message || data.error.msg || data.error.code))
      || data.msg || data.message || trimmed;
  } catch {
    return trimmed;
  }
}

class ChatService {
  #filePath;
  #fetchImpl;
  #now;
  #history = [];
  #busy = false;

  constructor({ filePath, fetchImpl, now } = {}) {
    if (!filePath) throw new Error('ChatService 需要 filePath 持久化会话');
    this.#filePath = filePath;
    this.#fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.#now = now || (() => new Date());
    this.#load();
  }

  get busy() { return this.#busy; }

  /** 仅可展示的 user/assistant 记录；工具内部消息不进入 UI 正文。 */
  messages() {
    return this.#history
      .filter((m) => m && (m.role === 'user'
        || (m.role === 'assistant' && typeof m.content === 'string'
          && m.content.length > 0 && !Array.isArray(m.tool_calls))))
      .map((m) => ({ role: m.role, content: m.content }));
  }

  clear() {
    if (this.#busy) throw busyError();
    this.#history = [];
    this.#save();
  }

  async send({ text, config, tools, executeTool, onEvent, signal, maxRounds } = {}) {
    if (this.#busy) throw busyError();
    if (typeof text !== 'string' || !text.trim()) throw new Error('消息内容不能为空');
    if (!config || typeof config !== 'object') throw new Error('缺少聊天配置');
    if (!config.apiKey) throw new Error('缺少 API Key，请先在设置里填写');
    if (!config.model) throw new Error('缺少模型，请先在设置里选择');
    const baseUrl = normalizeBaseUrl(config.apiBaseUrl || DEFAULT_API_BASE_URL);
    const useTools = Array.isArray(tools) && tools.length > 0;
    if (useTools && typeof executeTool !== 'function') throw new Error('提供了工具列表但缺少 executeTool');
    const limit = Number.isInteger(maxRounds) && maxRounds > 0 ? maxRounds : DEFAULT_MAX_ROUNDS;
    const isGlm53 = /^glm-5\.3(?:-|$)/i.test(config.model);
    const thinking = config.thinking === undefined ? { type: isGlm53 ? 'enabled' : 'disabled' } : config.thinking;
    const reasoningEffort = config.reasoningEffort ?? (isGlm53 ? 'low' : undefined);

    this.#busy = true;
    const emit = (event) => {
      if (typeof onEvent === 'function') {
        try { onEvent(event); } catch {}
      }
    };
    emit({ type: 'start' });

    const url = `${baseUrl}/chat/completions`;
    const system = { role: 'system', content: buildSystemPrompt(this.#now()) };
    const msgs = [...this.#history, { role: 'user', content: text }];
    let partial = '';        // 被中断回合里已收到的正文
    let answeredTools = 0;   // 本轮已真实执行过的工具数
    let pending = [];        // 已声明但还没回执的 tool call（取消时补真实回执）

    try {
      for (let round = 0; round < limit; round++) {
        partial = '';
        pending = [];
        const result = await this.#requestRound({
          url,
          apiKey: config.apiKey,
          model: config.model,
          thinking,
          reasoningEffort,
          signal,
          messages: [system, ...msgs],
          tools: useTools ? tools : null,
          onDelta: (piece) => { partial += piece; emit({ type: 'delta', text: piece }); },
        });

        if (result.toolCalls.length === 0) {
          msgs.push({ role: 'assistant', content: result.content });
          this.#commit(msgs);
          emit({ type: 'done', text: result.content });
          return result.content;
        }

        const calls = result.toolCalls.map((call) => ({
          id: call.id || `call_${call.index}`,
          name: call.function.name || '',
          arguments: call.function.arguments || '',
        }));
        msgs.push({
          role: 'assistant',
          content: result.content || null,
          ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
          tool_calls: calls.map((c) => ({
            id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
          })),
        });
        pending = calls.slice();
        for (const call of calls) {
          if (signal && signal.aborted) throw abortReason(signal);
          const receipt = await this.#runTool(call, executeTool, emit);
          msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(receipt) });
          pending = pending.filter((p) => p.id !== call.id);
          answeredTools++;
        }
        this.#commit(msgs);
      }
      const limitError = new Error(`工具调用轮数超过上限（${limit} 轮），本轮停止；已完成的操作保留`);
      limitError.code = 'ROUND_LIMIT';
      throw limitError;
    } catch (err) {
      if (partial) msgs.push({ role: 'assistant', content: partial });
      for (const call of pending) {
        msgs.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: '已取消，工具未执行' }),
        });
      }
      if (partial || answeredTools > 0) this.#commit(msgs);
      const cancelled = Boolean(signal && signal.aborted);
      emit({ type: 'error', message: cancelled ? '已取消' : (err && err.message) || String(err) });
      throw err;
    } finally {
      this.#busy = false;
    }
  }

  /** 一轮模型请求：流式收集 content 与按 index 分片的 tool_calls。 */
  async #requestRound({ url, apiKey, model, thinking, reasoningEffort, messages, tools, signal, onDelta }) {
    const body = { model, messages, stream: true };
    if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
    if (thinking) body.thinking = thinking;
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (tools && /^glm-5\.3(?:-|$)/i.test(model)) body.tool_stream = true;

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal && signal.reason);
    if (signal) {
      if (signal.aborted) throw abortReason(signal);
      signal.addEventListener('abort', onAbort);
    }
    try {
      const response = await this.#fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const detail = extractErrorMessage(text);
        const err = new Error(`模型请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
        err.code = `HTTP_${response.status}`;
        throw err;
      }
      if (!response.body) throw new Error('模型响应缺少流式内容');

      let content = '';
      let reasoning = '';
      const callMap = new Map();
      for await (const payload of ssePayloads(response.body, controller.signal)) {
        if (payload && payload.error) {
          const detail = typeof payload.error === 'string'
            ? payload.error
            : payload.error.message || payload.error.msg || payload.error.code || JSON.stringify(payload.error);
          const err = new Error(`模型流式响应返回错误：${detail}`);
          err.code = 'PROVIDER_ERROR';
          throw err;
        }
        const choice = Array.isArray(payload.choices) && payload.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onDelta(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) mergeToolCallParts(callMap, delta.tool_calls);
      }
      const toolCalls = [...callMap.values()].sort((a, b) => a.index - b.index);
      return { content, reasoning, toolCalls };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** 工具只经 executeTool 白名单执行；失败回执 {error}，不伪造成功。 */
  async #runTool(call, executeTool, emit) {
    let args;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      const receipt = { error: '工具参数不是有效的 JSON', arguments: call.arguments };
      emit({ type: 'tool', name: call.name, result: receipt });
      return receipt;
    }
    try {
      const result = await executeTool(call.name, args);
      const value = result === undefined ? null : result;
      emit({ type: 'tool', name: call.name, result: value });
      return value;
    } catch (err) {
      const receipt = { error: (err && err.message) || String(err) };
      emit({ type: 'tool', name: call.name, result: receipt });
      return receipt;
    }
  }

  #commit(msgs) {
    this.#history = msgs.slice();
    this.#save();
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
      const tmp = `${this.#filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, messages: this.#history }, null, 2), 'utf8');
      fs.renameSync(tmp, this.#filePath);
    } catch (err) {
      throw new Error(`会话保存失败（${this.#filePath}）：${err.message}`);
    }
  }

  #load() {
    let raw;
    try {
      raw = fs.readFileSync(this.#filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        this.#history = [];
        return;
      }
      throw new Error(`会话文件读取失败（${this.#filePath}）：${err.message}`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`会话文件损坏，不是有效 JSON（${this.#filePath}）：${err.message}`);
    }
    if (data && Array.isArray(data.messages)) {
      this.#history = data.messages.filter((m) =>
        m && typeof m.role === 'string' && ['user', 'assistant', 'tool'].includes(m.role));
    }
  }
}

module.exports = { ChatService };
