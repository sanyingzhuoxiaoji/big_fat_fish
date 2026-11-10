'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// 本机便签只读连接器：直接观察安装版桌面便签的数据文件（sticky-note-data.json），
// 不经过 pet-bridge、不写回任何便签数据。旧双向实现见 services/note-client.cjs（未启用）。

const NOTE_FILE = 'sticky-note-data.json';
const DEBOUNCE_MS = 200; // 与便签 200ms 防抖写盘对齐，合并同一次保存的多个事件
const RECHECK_MS = 3000; // 数据目录/文件尚未出现时的兜底重查；fs.watch 仍是主要观察手段

class LocalNoteReader extends EventEmitter {
  constructor({ dataDir, onChange, onReminder } = {}) {
    super();
    if (!dataDir) throw new Error('缺少便签数据目录');
    this.dataDir = dataDir;
    this.file = path.join(dataDir, NOTE_FILE);
    this.onChange = onChange;
    this.onReminder = onReminder;
    this.current = { connected: false, error: '', revision: 0, items: [] };
    this.closed = false;
    this.seeded = false; // 首次成功读取只建立基线，绝不重放历史提醒
    this.lastItems = '[]';
    this.watcher = null;
    this.watchRoot = '';
    this.debounce = null;
    this.recheck = null;
  }

  snapshot() { return structuredClone(this.current); }

  // 与 NoteClient 相同的发布约定：合并补丁 → onChange → 'state' 事件。
  publish(patch) {
    Object.assign(this.current, patch);
    const snapshot = this.snapshot();
    this.onChange?.(snapshot);
    this.emit('state', snapshot);
  }

  // 只提取本工具链需要的字段；images 等便签私有内容绝不进入调用方。
  readItems() {
    const raw = fs.readFileSync(this.file, 'utf8');
    let data;
    try { data = JSON.parse(raw); }
    catch (error) { throw Object.assign(new Error(`JSON解析失败（${error.message}）`), { code: 'EINVALID' }); }
    if (!data || !Array.isArray(data.items)) throw Object.assign(new Error('数据格式无效：items不是数组'), { code: 'EINVALID' });
    return data.items.map(item => ({
      id: String(item?.id ?? ''),
      text: String(item?.text ?? ''),
      status: ['todo', 'done', 'dropped'].includes(item?.status) ? item.status : 'todo',
      remindAt: typeof item?.remindAt === 'string' ? item.remindAt : null,
      reminded: item?.reminded === true
    }));
  }

  scan() {
    if (this.closed) return;
    let connected;
    let error = '';
    let items;
    try {
      items = this.readItems();
      connected = true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        // 目录或文件尚不存在：绝不创建，等待安装版便签写出数据后自动连接。
        connected = false;
        error = fs.existsSync(this.dataDir)
          ? `便签数据文件尚未生成（${this.file}）。打开已安装的桌面便签后会自动读取`
          : `尚未找到本机便签数据目录（${this.dataDir}）。打开已安装的桌面便签后会自动读取`;
      } else {
        // 保存未完成/内容暂不可读：保留最后一次有效任务列表，等待下次保存恢复。
        connected = false;
        error = `便签数据暂不可读，已保留上次读取的 ${this.current.items.length} 条任务：${err.message}`;
      }
      items = this.current.items;
    }

    const serialized = JSON.stringify(items);
    // 只在任务内容真正变化时本地递增 revision；reminded 转移检测必须在发布前用旧快照计算。
    const previous = new Map(this.current.items.map(item => [item.id, item]));
    const due = this.seeded
      ? items.filter(item => {
          if (item.reminded !== true || item.status !== 'todo') return false;
          const before = previous.get(item.id);
          return Boolean(before) && before.reminded !== true;
        })
      : [];
    if (connected) this.seeded = true;

    const changedItems = serialized !== this.lastItems;
    this.lastItems = serialized;
    const revision = changedItems ? this.current.revision + 1 : this.current.revision;
    const next = { connected, error, revision, items };
    if (next.connected !== this.current.connected || next.error !== this.current.error || next.revision !== this.current.revision) {
      this.publish(next);
    }
    if (connected) this.stopRecheck(); else this.startRecheck();
    for (const item of due) this.onReminder?.(item);
  }

  scheduleScan() {
    if (this.closed) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.scan();
      this.ensureWatch();
    }, DEBOUNCE_MS);
  }

  // 目录级 fs.watch：文件被原子替换/重命名也不会丢失后续事件。
  // 数据目录尚不存在时改为监视其父目录，等目录出现后切换，全程不创建任何目录。
  ensureWatch() {
    if (this.closed || this.watcher) return;
    const watchingDataDir = fs.existsSync(this.dataDir);
    const root = watchingDataDir ? this.dataDir : path.dirname(this.dataDir);
    const expect = watchingDataDir ? '' : path.basename(this.dataDir);
    let handle;
    try { handle = fs.watch(root, (event, filename) => this.onWatchEvent(expect, filename)); }
    catch { this.startRecheck(); return; }
    this.watcher = handle;
    this.watchRoot = root;
    handle.on('error', () => {
      this.stopWatch();
      if (!this.closed) { this.scan(); this.ensureWatch(); }
    });
  }

  onWatchEvent(expect, filename) {
    if (this.closed) return;
    if (expect) {
      if (fs.existsSync(this.dataDir)) { this.stopWatch(); this.scan(); this.ensureWatch(); return; }
      if (filename && filename !== expect) return; // 父目录的无关变化
    }
    this.scheduleScan();
  }

  stopWatch() {
    if (this.watcher) { try { this.watcher.close(); } catch { /* 句柄可能已失效 */ } this.watcher = null; this.watchRoot = ''; }
  }

  startRecheck() {
    if (this.closed || this.recheck) return;
    this.recheck = setInterval(() => { if (!this.closed) { this.scan(); this.ensureWatch(); } }, RECHECK_MS);
    this.recheck.unref?.();
  }

  stopRecheck() {
    if (this.recheck) { clearInterval(this.recheck); this.recheck = null; }
  }

  async connect() {
    if (this.closed) throw new Error('本机便签读取器已关闭');
    this.scan();
    this.ensureWatch();
    return this.snapshot();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopWatch();
    this.stopRecheck();
    clearTimeout(this.debounce);
    this.debounce = null;
  }
}

module.exports = { LocalNoteReader, NOTE_FILE };
