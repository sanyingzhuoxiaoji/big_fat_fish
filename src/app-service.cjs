'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { NoteClient } = require('./services/note-client.cjs');
const { ChatService } = require('./services/chat.cjs');
const { Pomodoro } = require('./services/pomodoro.cjs');

const DEFAULT_API = 'https://open.bigmodel.cn/api/paas/v4';
const TOOL_DEFINITIONS = [
  { name: 'list_tasks', description: '读取真实待办列表。修改或完成已有任务前，先查询以获取真实ID。', properties: { status: { type: 'string', enum: ['todo', 'done', 'all'] } }, required: [] },
  { name: 'create_task', description: '保存用户明确要求记录的新待办。remindAt是提醒时间，不是截止日期；用户未指定具体时间则不填写，时间含糊时先追问。', properties: { text: { type: 'string' }, remindAt: { type: 'string', description: '带时区的ISO8601，例如2030-01-01T15:00:00+08:00' } }, required: ['text'] },
  { name: 'update_task', description: '修改真实任务文字或提醒时间。取消提醒时remindAt设为null。', properties: { id: { type: 'string' }, text: { type: 'string' }, remindAt: { type: ['string', 'null'] } }, required: ['id'] },
  { name: 'complete_task', description: '仅在用户明确表示任务已完成时标记完成。番茄钟结束不等于任务完成。', properties: { id: { type: 'string' } }, required: ['id'] },
  { name: 'start_focus', description: '为指定待办启动番茄钟。先查询获取任务ID；也可用text记录独立专注目标。', properties: { taskId: { type: 'string' }, text: { type: 'string' }, workMinutes: { type: 'number' }, restMinutes: { type: 'number' } }, required: [] }
].map(({ name, description, properties, required }) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }));

function atomicJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}
function loadJSON(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`无法读取 ${path.basename(file)}：${error.message}`); }
}
function textValue(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}
function reminderValue(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('提醒时间必须是明确日期、时间及所在时区');
  return new Date(value).toISOString();
}
function duration(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1440) throw new Error(`${label}应大于0且不超过1440分钟`);
  return number;
}
function apiAddress(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('API地址不能包含凭据、查询参数或锚点');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('远程API必须使用HTTPS');
  return url.href.replace(/\/+$/, '');
}

function createAppService(options) {
  const { dataDir, onState, onChat, onPet, notify, encryptSecret, decryptSecret } = options;
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, 'settings.json');
  const saved = loadJSON(settingsFile);
  const sibling = path.resolve(__dirname, '..', '..');
  const defaultNoteProject = fs.existsSync(path.join(sibling, '便签', 'package.json')) ? path.join(sibling, '便签') : path.join(sibling, 'desktop_note');
  const defaultNoteData = options.noteDataDir || process.env.DESKTOP_NOTE_DATA_DIR || path.join(process.env.APPDATA || path.join(dataDir, 'appdata'), 'desktop-sticky-note');
  let settings = {
    apiBaseUrl: DEFAULT_API, model: 'glm-5.3-flash', workMinutes: 25, restMinutes: 5,
    noteProjectPath: defaultNoteProject, noteDataDir: defaultNoteData,
    ...saved
  };
  if (options.noteDataDir) settings.noteDataDir = options.noteDataDir;
  let apiKey = process.env.GLM_API_KEY || '';
  let settingsError = '';
  if (!apiKey && saved.encryptedApiKey) {
    try {
      if (!decryptSecret) throw new Error('安全存储不可用');
      apiKey = decryptSecret(saved.encryptedApiKey);
    } catch (error) { settingsError = `已保存的Key无法解密，请重新填写：${error.message}`; }
  }
  let chatBusy = false;
  let chatError = '';
  let closed = false;
  let chatAbort;
  let noteProcess;
  const chat = new ChatService({ filePath: path.join(dataDir, 'chat.json') });
  let note;
  let timer;
  const state = () => {
    const { encryptedApiKey, ...publicSettings } = settings;
    return {
      settings: { ...publicSettings, hasApiKey: Boolean(apiKey), error: settingsError },
      notes: note.snapshot(), focus: timer.snapshot(),
      chat: { messages: chat.messages(), busy: chatBusy, error: chatError }
    };
  };
  const publish = () => { if (!closed && note && timer) onState?.(state()); };
  const createNoteClient = () => new NoteClient({
    dataDir: settings.noteDataDir,
    onChange: publish,
    onReminder: item => {
      onPet?.({ type: 'bubble', text: `该做这件事啦：${item.text || '待办任务'}` });
      onPet?.({ type: 'expression', name: '加载' });
      // 待办系统通知由便签发出，这里只呈现桌宠提醒，不启动第二套闹钟。
    }
  });
  note = createNoteClient();
  timer = new Pomodoro({
    filePath: path.join(dataDir, 'focus.json'), onChange: publish,
    onComplete: focus => {
      const phase = focus?.phase || timer.snapshot().phase;
      const body = phase === 'restEnd' ? '休息结束，要开始下一轮吗？' : '这一轮专注结束了。任务是否完成，由你决定。';
      onPet?.({ type: 'bubble', text: body });
      onPet?.({ type: 'expression', name: '脸红' });
      notify?.({ title: '大肥鱼番茄钟', body });
    }
  });

  function requireNotes() {
    if (!note.snapshot().connected) throw new Error('待办尚未连接。请在设置中启动或连接 desktop_note');
  }
  async function createTask(input) {
    requireNotes();
    const payload = { text: textValue(input.text, '任务内容') };
    if (Object.hasOwn(input, 'remindAt')) payload.remindAt = reminderValue(input.remindAt);
    const item = await note.createTask(payload);
    onPet?.({ type: 'bubble', text: `记下了：${item.text}` });
    return item;
  }
  async function updateTask({ id, patch }) {
    requireNotes();
    textValue(id, '任务ID');
    const allowed = {};
    if (Object.hasOwn(patch || {}, 'text')) allowed.text = textValue(patch.text, '任务内容');
    if (Object.hasOwn(patch || {}, 'remindAt')) allowed.remindAt = reminderValue(patch.remindAt);
    if (Object.hasOwn(patch || {}, 'status')) {
      if (!['todo', 'done', 'dropped'].includes(patch.status)) throw new Error('任务状态无效');
      allowed.status = patch.status;
    }
    if (Object.hasOwn(patch || {}, 'note')) allowed.note = String(patch.note);
    if (!Object.keys(allowed).length) throw new Error('没有可更新的任务字段');
    return note.updateTask(id, allowed);
  }
  function startFocus(input = {}) {
    let task;
    if (input.taskId) {
      requireNotes();
      task = note.snapshot().items.find(item => item.id === input.taskId);
      if (!task || task.status !== 'todo') throw new Error('所选任务不存在或已不在待办中，请刷新后重新选择');
    }
    if (['work', 'rest'].includes(timer.snapshot().phase)) throw new Error('已有计时回合，请先结束当前回合');
    timer.start({
      taskId: task?.id || '', text: task?.text || input.text || '自由专注',
      workMinutes: duration(input.workMinutes ?? settings.workMinutes, '专注时长'),
      restMinutes: duration(input.restMinutes ?? settings.restMinutes, '休息时长')
    });
    onPet?.({ type: 'bubble', text: `陪你专注：${task?.text || input.text || '自由专注'}` });
    publish();
    return timer.snapshot();
  }
  function toolTask({ id, text, status, remindAt, reminded }) {
    return { id, text, status, remindAt, reminded };
  }
  async function executeTool(name, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
    switch (name) {
      case 'list_tasks': {
        requireNotes();
        const items = note.snapshot().items;
        const filtered = args.status === 'all' ? items : items.filter(item => item.status === (args.status || 'todo'));
        return { items: filtered.map(({ id, text, status, remindAt, reminded }) => ({ id, text, status, remindAt, reminded })), localTime: new Date().toString() };
      }
      case 'create_task': return toolTask(await createTask(args));
      case 'update_task': {
        const { id, ...patch } = args;
        return toolTask(await updateTask({ id, patch }));
      }
      case 'complete_task': return toolTask(await updateTask({ id: args.id, patch: { status: 'done' } }));
      case 'start_focus': return startFocus(args);
      default: throw new Error(`不允许的工具：${name}`);
    }
  }

  async function saveSettings(input) {
    const next = { ...settings };
    if (Object.hasOwn(input, 'apiBaseUrl')) next.apiBaseUrl = apiAddress(input.apiBaseUrl);
    if (Object.hasOwn(input, 'model')) next.model = textValue(input.model, '模型名称');
    for (const [key, label] of [['workMinutes', '专注时长'], ['restMinutes', '休息时长']]) if (Object.hasOwn(input, key)) next[key] = duration(input[key], label);
    if (Object.hasOwn(input, 'noteProjectPath')) next.noteProjectPath = path.resolve(textValue(input.noteProjectPath, '便签项目路径'));
    if (Object.hasOwn(input, 'noteDataDir')) next.noteDataDir = path.resolve(textValue(input.noteDataDir, '便签数据路径'));
    let nextKey = apiKey;
    if (Object.hasOwn(input, 'apiKey') && input.apiKey !== '') nextKey = String(input.apiKey).trim();
    if (input.clearApiKey) nextKey = '';
    if (input.rememberKey) {
      if (!encryptSecret) throw new Error('当前环境不支持加密安全存储，无法记住Key；请取消勾选后使用');
      if (!nextKey) throw new Error('请先填写API Key');
      next.encryptedApiKey = encryptSecret(nextKey);
    } else if (Object.hasOwn(input, 'rememberKey') || input.clearApiKey || (input.apiBaseUrl && next.apiBaseUrl !== settings.apiBaseUrl)) delete next.encryptedApiKey;
    if (input.apiBaseUrl && next.apiBaseUrl !== settings.apiBaseUrl && !input.apiKey) {
      nextKey = '';
      delete next.encryptedApiKey;
    }
    const notePathChanged = next.noteDataDir !== settings.noteDataDir;
    atomicJSON(settingsFile, next);
    settings = next;
    apiKey = nextKey;
    settingsError = '';
    if (notePathChanged) { note.close(); note = createNoteClient(); await note.connect().catch(() => {}); }
    publish();
    return state();
  }

  async function openNotes() {
    const project = settings.noteProjectPath;
    const manifestPath = path.join(project, 'package.json');
    if (!fs.existsSync(manifestPath)) throw new Error('未找到便签源码项目，请在设置中选择 desktop_note 所在目录');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = path.join(project, manifest.main || 'main.js');
    if (!fs.existsSync(entry)) throw new Error('便签项目缺少启动文件');
    const electronPath = process.versions.electron ? process.execPath : require('electron');
    if (typeof electronPath !== 'string') throw new Error('当前启动环境无法定位Electron，请使用 npm start 启动桌宠');
    const environment = { ...process.env, DESKTOP_NOTE_DATA_DIR: settings.noteDataDir };
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.GLM_API_KEY;
    noteProcess = spawn(electronPath, [project, '--background'], { cwd: project, env: environment, windowsHide: true, stdio: 'ignore' });
    noteProcess.on('error', error => note.publish({ connected: false, error: `启动便签失败：${error.message}` }));
    noteProcess.unref();
    // 连接器按协议持续重新发现；启动请求本身不伪报“已连接”。
    await note.connect().catch(() => {});
    return note.snapshot();
  }

  return {
    async init() { await note.connect().catch(() => {}); publish(); return state(); },
    state,
    async handle(method, payload = {}) {
      if (closed) throw new Error('应用已关闭');
      switch (method) {
        case 'getState': return state();
        case 'saveSettings': return saveSettings(payload);
        case 'connectNotes': await note.connect(); return state();
        case 'openNotes': return openNotes();
        case 'createTask': return createTask(payload);
        case 'updateTask': return updateTask(payload);
        case 'startFocus': return startFocus(payload);
        case 'pauseFocus': timer.pause(); publish(); return timer.snapshot();
        case 'resumeFocus': timer.resume(); publish(); return timer.snapshot();
        case 'stopFocus': timer.stop(); publish(); return timer.snapshot();
        case 'startRest': timer.startRest(); publish(); return timer.snapshot();
        case 'clearChat':
          if (chatBusy) throw new Error('请先等待本轮回复结束再清除会话');
          chat.clear(); chatError = ''; publish(); return state();
        case 'cancelChat': chatAbort?.abort(); return { cancelled: true };
        case 'sendMessage': {
          if (!apiKey) throw new Error('请先在设置中填写GLM API Key');
          if (chatBusy) throw new Error('大肥鱼正在回复，请等待或停止当前回复');
          const text = textValue(payload.text, '消息');
          chatBusy = true; chatError = ''; chatAbort = new AbortController(); publish();
          onPet?.({ type: 'expression', name: '加载' });
          try {
            const answer = await chat.send({ text, config: { apiBaseUrl: settings.apiBaseUrl, model: settings.model, apiKey }, tools: TOOL_DEFINITIONS, executeTool, onEvent: event => { onChat?.(event); }, signal: chatAbort.signal });
            onPet?.({ type: 'expression', name: '脸红' });
            onPet?.({ type: 'bubble', text: answer });
            return answer;
          } catch (error) {
            chatError = error.name === 'AbortError' ? '已停止回复；已成功执行的任务操作不会撤回' : error.message;
            onPet?.({ type: 'expression', name: '流冷汗' });
            throw new Error(chatError);
          } finally { chatBusy = false; chatAbort = null; publish(); }
        }
        default: throw new Error(`未知操作：${method}`);
      }
    },
    close() { closed = true; chatAbort?.abort(); note.close(); timer.close(); }
  };
}
module.exports = { createAppService, TOOL_DEFINITIONS };
