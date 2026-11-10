'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

class NoteClient extends EventEmitter {
  constructor({ dataDir, onChange, onReminder } = {}) {
    super();
    this.dataDir = dataDir;
    this.onChange = onChange;
    this.onReminder = onReminder;
    this.current = { connected: false, error: '', revision: 0, items: [] };
    this.closed = false;
    this.generation = 0;
    this.retry = null;
    this.stream = null;
    this.endpoint = null;
  }

  snapshot() { return structuredClone(this.current); }

  publish(patch) {
    Object.assign(this.current, patch);
    const snapshot = this.snapshot();
    this.onChange?.(snapshot);
    this.emit('state', snapshot);
  }

  apply(snapshot, generation = this.generation) {
    if (!snapshot || !Array.isArray(snapshot.data?.items)) throw new Error('便签返回了无效的数据快照');
    if (generation !== this.generation || snapshot.revision < this.current.revision) return;
    const items = snapshot.data.items.map(({ id, text, status, remindAt, reminded, createdAt, finishedAt, note }) =>
      ({ id, text, status, remindAt, reminded, createdAt, finishedAt, note }));
    this.publish({ connected: true, error: '', revision: snapshot.revision, items });
  }

  discover() {
    const descriptor = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'pet-bridge.json'), 'utf8'));
    if (descriptor.version !== 1 || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.token !== 'string' || !descriptor.token) {
      throw new Error('便签桥接描述文件无效，请重新启动便签');
    }
    return { url: `http://127.0.0.1:${descriptor.port}`, token: descriptor.token };
  }

  async request(route, { method = 'GET', body } = {}) {
    if (!this.endpoint) throw new Error('尚未连接便签，请先启动或连接 desktop_note');
    const response = await fetch(this.endpoint.url + route, {
      method,
      headers: { Authorization: `Bearer ${this.endpoint.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `便签请求失败（${response.status}）`);
    return result;
  }

  async connect() {
    if (this.closed) throw new Error('便签连接已关闭');
    const generation = ++this.generation;
    clearTimeout(this.retry);
    this.stream?.abort();
    try {
      const endpoint = this.discover();
      if (!this.endpoint || endpoint.url !== this.endpoint.url || endpoint.token !== this.endpoint.token) this.current.revision = -1;
      this.endpoint = endpoint;
      const snapshot = await this.request('/v1/state');
      if (this.closed || generation !== this.generation) return this.snapshot();
      this.apply(snapshot, generation);
      const controller = new AbortController();
      this.stream = controller;
      this.consumeEvents(generation, controller).catch(error => {
        if (!this.closed && generation === this.generation && !controller.signal.aborted) this.disconnected(error);
      });
      return this.snapshot();
    } catch (error) {
      if (!this.closed && generation === this.generation) this.disconnected(error);
      throw new Error(this.current.error || error.message);
    }
  }

  disconnected(error) {
    const message = error.code === 'ENOENT' ? '未找到便签服务，请点击“启动便签”' : `便签连接断开：${error.message}`;
    this.publish({ connected: false, error: message });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect().catch(() => {}), 2000);
    this.retry.unref?.();
  }

  async consumeEvents(generation, controller) {
    const response = await fetch(this.endpoint.url + '/v1/events', {
      headers: { Authorization: `Bearer ${this.endpoint.token}` }, signal: controller.signal
    });
    if (!response.ok) throw new Error(`无法订阅便签事件（${response.status}）`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = block => {
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length || generation !== this.generation || this.closed) return;
      const payload = JSON.parse(data.join('\n'));
      if (event === 'snapshot' || event === 'state') this.apply(payload);
      if (event === 'reminder') { this.onReminder?.(payload.item); this.emit('reminder', payload.item); }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        buffer = buffer.replace(/\r\n/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
        if (done) break;
      }
      throw new Error('便签事件连接已结束');
    } finally { reader.releaseLock(); }
  }

  async createTask(input) {
    const generation = this.generation;
    const result = await this.request('/v1/tasks', { method: 'POST', body: input });
    this.apply(result.snapshot, generation);
    return result.item;
  }

  async updateTask(id, patch) {
    const generation = this.generation;
    const result = await this.request(`/v1/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
    this.apply(result.snapshot, generation);
    return result.item;
  }

  close() {
    this.closed = true;
    ++this.generation;
    clearTimeout(this.retry);
    this.stream?.abort();
  }
}
module.exports = { NoteClient };
