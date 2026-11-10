/* 大肥鱼操作面板：原生JS，全部数据来自 window.fish（preload契约）。 */
'use strict';
(() => {
  const $ = (sel) => document.querySelector(sel);

  const el = {
    boot: $('#boot'), bootError: $('#boot-error'), bootRetry: $('#boot-retry'), root: $('#panel-root'),

    chatLog: $('#chat-log'), chatState: $('#chat-messages'), chatLive: $('#chat-live'),
    chatEmpty: $('#chat-empty'), chatError: $('#chat-error'),
    chatForm: $('#chat-form'), chatInput: $('#chat-input'),
    chatSend: $('#btn-chat-send'), chatStop: $('#btn-chat-stop'), chatClear: $('#btn-chat-clear'),

    notesStatus: $('#notes-status'), tasksMsg: $('#tasks-msg'),
    taskForm: $('#task-form'), taskText: $('#task-text'), taskRemind: $('#task-remind'),
    taskCreate: $('#btn-create-task'), openNotes: $('#btn-open-notes'), connectNotes: $('#btn-connect-notes'),
    todoList: $('#todo-list'), todoEmpty: $('#todo-empty'), doneList: $('#done-list'), doneEmpty: $('#done-empty'),

    focusPhase: $('#focus-phase'), focusTime: $('#focus-time'), focusTarget: $('#focus-target'),
    focusTask: $('#focus-task'), focusGoalWrap: $('#focus-goal-wrap'), focusGoal: $('#focus-goal'),
    focusWork: $('#focus-work'), focusRest: $('#focus-rest'),
    focusMsg: $('#focus-msg'), focusToday: $('#focus-today'),
    btnFocusStart: $('#btn-focus-start'), btnFocusPause: $('#btn-focus-pause'),
    btnFocusResume: $('#btn-focus-resume'), btnFocusRest: $('#btn-focus-rest'), btnFocusStop: $('#btn-focus-stop'),

    settingsMsg: $('#settings-msg'), settingsForm: $('#settings-form'), settingsSave: $('#btn-save-settings'),
    setApiBase: $('#set-api-base'), setModel: $('#set-model'), selectModelBtn: $('#btn-select-model'),
    setApiKey: $('#set-api-key'), keyState: $('#key-state'), setRemember: $('#set-remember-key'),
    clearKeyBtn: $('#btn-clear-key'), setWork: $('#set-work'), setRest: $('#set-rest'),
    setNoteProject: $('#set-note-project'), setNoteData: $('#set-note-data'),
    mouseBtn: $('#btn-mouse-through'), mouseState: $('#mouse-state'),
    tabs: [...document.querySelectorAll('[role="tab"]')],
    views: { chat: $('#view-chat'), tasks: $('#view-tasks'), focus: $('#view-focus'), settings: $('#view-settings') },
  };
  const TAB_BY_VIEW = { chat: $('#tab-chat'), tasks: $('#tab-tasks'), focus: $('#tab-focus'), settings: $('#tab-settings') };

  // ---------- 本地界面状态 ----------
  let latest = null;            // 最近一次完整 state
  let booted = false;

  const settingsDirty = new Set();  // 用户改过、尚未提交的设置字段
  let settingsInfo = '';            // 最近一次设置操作回执（成功）
  let settingsError = '';           // 最近一次设置操作失败原因（每秒刷新不吞掉）
  let savingSettings = false;
  let keyBusy = false;

  let mouseThrough = false;

  const notesBusy = new Set();      // 'open' | 'connect'
  let itemsSig = '';
  const busyIds = new Set();        // 正在执行操作的任务 id
  const taskEdit = new Map();       // id -> {kind:'text'|'remind', value}

  let focusOptionsSig = '';
  let focusTaskId = '';
  const focusMinutesTouched = new Set();  // workMinutes / restMinutes
  let focusBusy = false;
  let startingFocus = false;

  let chatSig = '';
  let overlaySig = '';
  const chatLocal = { pendingUser: null, streamText: '', streaming: false, tools: [], busy: false, error: '' };

  const PHASE_LABEL = {
    idle: '未开始', work: '专注中', workEnd: '本轮专注结束', rest: '休息中', restEnd: '休息结束',
  };
  const TOOL_LABELS = {
    list_tasks: '读取待办', create_task: '新建待办', update_task: '修改待办',
    complete_task: '完成任务', start_focus: '启动专注',
  };

  // ---------- 小工具 ----------
  const pad2 = (n) => String(n).padStart(2, '0');

  function showLine(node, text, kind) {
    node.hidden = !text;
    node.textContent = text || '';
    node.classList.toggle('is-error', kind === 'error');
    node.classList.toggle('is-ok', kind === 'ok');
  }

  function fmtMs(ms) {
    const t = Math.round(Math.max(0, ms || 0) / 1000);
    return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
  }

  function fmtLocal(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  // datetime-local 本地值 → 带时区偏移的 ISO（例如 2026-01-01T15:00:00+08:00）
  function localToOffsetISO(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!m) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const offset = -d.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  }

  // ISO → datetime-local 本地值
  function isoToLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function parseMinutes(raw, label) {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0) return { error: `${label}需要是大于0的数字，可用小数（如 0.5）` };
    if (n > 1440) return { error: `${label}不能超过1440分钟` };
    return { value: n };
  }

  function settingsNotice(text, kind) {
    if (kind === 'error') { settingsError = text; settingsInfo = ''; }
    else if (kind === 'ok') { settingsInfo = text; settingsError = ''; }
    else { settingsInfo = ''; settingsError = ''; }
    showLine(el.settingsMsg, text, kind);
  }

  // ---------- 状态入口 ----------
  function applyState(state) {
    if (!state || typeof state !== 'object') return;
    latest = state;
    if (!booted) {
      booted = true;
      el.boot.hidden = true;
      el.root.hidden = false;
    }
    renderSettings(state.settings || {});
    renderNotes(state.notes || { connected: false, error: '尚未获取到便签状态', items: [] });
    renderFocus(state.focus || {});
    renderChat(state.chat || { messages: [], busy: false, error: '' });
  }

  // ---------- 聊天 ----------
  function summarizeTool(name, result) {
    const label = TOOL_LABELS[name] || name;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if (result.error) return { fail: true, text: `${label}失败：${result.error}` };
      if (Array.isArray(result.items)) return { fail: false, text: `${label}：共 ${result.items.length} 条待办` };
      if (typeof result.text === 'string' && result.text) return { fail: false, text: `${label}：${truncate(result.text, 60)}` };
      const json = JSON.stringify(result, (k, v) => (typeof v === 'string' && v.startsWith('data:') ? '[图片数据已省略]' : v));
      return { fail: false, text: `${label}：${truncate(json, 160)}` };
    }
    return { fail: false, text: `${label}：${String(result)}` };
  }

  function bubble(role, text, extraClass) {
    const b = document.createElement('div');
    b.className = `msg msg-${role}${extraClass ? ` ${extraClass}` : ''}`;
    const p = document.createElement('p');
    p.textContent = text;
    b.append(p);
    return b;
  }

  function streamingBubble(text) {
    const b = document.createElement('div');
    b.className = 'msg msg-assistant';
    const p = document.createElement('p');
    p.append(document.createTextNode(text));
    const caret = document.createElement('span');
    caret.className = 'caret';
    p.append(caret);
    b.append(p);
    return b;
  }

  function toolLine(entry) {
    const p = document.createElement('p');
    p.className = `tool-line${entry.fail ? ' is-fail' : ''}`;
    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = entry.name;
    const text = document.createElement('span');
    text.textContent = entry.text;
    p.append(name, text);
    return p;
  }

  function rebuildChat(messages) {
    el.chatState.textContent = '';
    for (const m of messages) el.chatState.append(bubble(m.role, m.content));
  }

  function scrollChat(force) {
    const log = el.chatLog;
    const near = force || log.scrollTop + log.clientHeight >= log.scrollHeight - 48;
    if (near) log.scrollTop = log.scrollHeight;
  }

  function renderChat(chat) {
    const stickToBottom = el.chatLog.scrollTop + el.chatLog.clientHeight >= el.chatLog.scrollHeight - 48;
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    const sig = `${messages.length}|${messages.map((m) => `${m.role === 'user' ? 'u' : 'a'}${m.content.length}`).join(',')}`;
    let structureChanged = false;
    if (sig !== chatSig) {
      chatSig = sig;
      structureChanged = true;
      // 提交后的历史已含本条消息与最终回复，覆盖本地暂显，避免重复。
      chatLocal.pendingUser = null;
      chatLocal.streamText = '';
      chatLocal.streaming = false;
      chatLocal.tools.length = 0;
      if (!chat.busy) chatLocal.busy = false;
      rebuildChat(messages);
    }
    if (chat.error) chatLocal.error = ''; // state 里的错误是权威值
    const busy = Boolean(chat.busy) || chatLocal.busy;
    const errorText = chat.error || chatLocal.error;
    showLine(el.chatError, errorText, 'error');

    const nextOverlaySig = [
      busy, chatLocal.pendingUser ? '1' : '0',
      chatLocal.streaming || chatLocal.streamText ? chatLocal.streamText.length : -1,
      chatLocal.tools.length,
    ].join('|');
    if (nextOverlaySig !== overlaySig) {
      overlaySig = nextOverlaySig;
      structureChanged = true;
      el.chatLive.textContent = '';
      if (chatLocal.pendingUser) el.chatLive.append(bubble('user', chatLocal.pendingUser, 'pending'));
      for (const t of chatLocal.tools) el.chatLive.append(toolLine(t));
      if (chatLocal.streamText || chatLocal.streaming) el.chatLive.append(streamingBubble(chatLocal.streamText));
      if (busy && !chatLocal.streamText) {
        const p = document.createElement('p');
        p.className = 'chat-busy';
        p.textContent = '大肥鱼正在思考…';
        el.chatLive.append(p);
      }
    }
    el.chatEmpty.hidden = messages.length > 0 || Boolean(chatLocal.pendingUser) || busy;
    el.chatStop.hidden = !busy;
    el.chatSend.disabled = busy;
    if (structureChanged) scrollChat(stickToBottom);
  }

  function onChatEvent(event) {
    switch (event.type) {
      case 'start':
        chatLocal.busy = true;
        chatLocal.streaming = true;
        chatLocal.streamText = '';
        chatLocal.tools.length = 0;
        chatLocal.error = '';
        break;
      case 'delta':
        chatLocal.streaming = true;
        chatLocal.streamText += event.text || '';
        break;
      case 'tool':
        chatLocal.tools.push({ name: event.name, fail: false, ...summarizeTool(event.name, event.result) });
        break;
      case 'done':
        chatLocal.streaming = false;
        break;
      case 'error':
        // 失败/取消时未提交的暂显内容不可信，全部撤下，只留真实错误。
        chatLocal.streaming = false;
        chatLocal.streamText = '';
        chatLocal.tools.length = 0;
        chatLocal.pendingUser = null;
        chatLocal.busy = false;
        chatLocal.error = event.message === '已取消' ? '已停止回复。' : (event.message || '回复失败');
        break;
      default:
        return;
    }
    overlaySig = ''; // 强制重绘暂显区
    renderChat(latest?.chat || { messages: [], busy: chatLocal.busy, error: '' });
    scrollChat(false);
  }

  function submitChat() {
    const text = el.chatInput.value.trim();
    if (!text) { el.chatInput.focus(); return; }
    if (chatLocal.busy || latest?.chat?.busy) return;
    el.chatInput.value = '';
    chatLocal.pendingUser = text;
    chatLocal.busy = true;
    chatLocal.error = '';
    chatLocal.streamText = '';
    chatLocal.streaming = false;
    chatLocal.tools.length = 0;
    overlaySig = '';
    renderChat(latest?.chat || { messages: [], busy: true, error: '' });
    scrollChat(true);
    window.fish.action('sendMessage', { text })
      .catch((err) => { if (!chatLocal.error) chatLocal.error = err.message; })
      .finally(() => {
        chatLocal.busy = false;
        overlaySig = '';
        renderChat(latest?.chat || { messages: [], busy: false, error: '' });
      });
  }

  el.chatForm.addEventListener('submit', (e) => { e.preventDefault(); submitChat(); });
  el.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitChat();
    }
  });
  el.chatStop.addEventListener('click', () => {
    window.fish.action('cancelChat')
      .catch((err) => showLine(el.chatError, `停止回复失败：${err.message}`, 'error'));
  });
  el.chatClear.addEventListener('click', async () => {
    if (chatLocal.busy || latest?.chat?.busy) {
      showLine(el.chatError, '请先等待回复结束或停止当前回复，再清除会话', 'error');
      return;
    }
    el.chatClear.disabled = true;
    try {
      chatSig = '';
      chatLocal.pendingUser = null;
      chatLocal.streamText = '';
      chatLocal.streaming = false;
      chatLocal.tools.length = 0;
      chatLocal.error = '';
      overlaySig = '';
      const next = await window.fish.action('clearChat');
      showLine(el.chatError, '');
      applyState(next);
    } catch (err) {
      showLine(el.chatError, `清除会话失败：${err.message}`, 'error');
    } finally {
      el.chatClear.disabled = false;
    }
  });

  // ---------- 待办 ----------
  function taskItemElement(item) {
    const li = document.createElement('li');
    li.className = 'task';
    li.dataset.id = item.id;
    li.innerHTML = `
      <div class="task-main">
        <p class="task-text"></p>
        <p class="task-remind" hidden></p>
      </div>
      <div class="task-actions">
        <button type="button" class="btn small" data-act="edit">改文字</button>
        <button type="button" class="btn small" data-act="remind">提醒</button>
        <button type="button" class="btn small" data-act="toggle">完成</button>
        <button type="button" class="btn small" data-act="focus">专注</button>
      </div>
      <div class="task-editor" data-editor="text" hidden>
        <label class="editor-label">修改任务内容<input class="task-edit-input" type="text"></label>
        <div class="editor-row">
          <button type="button" class="btn small primary" data-act="save-text">保存</button>
          <button type="button" class="btn small" data-act="cancel-edit">取消</button>
        </div>
      </div>
      <div class="task-editor" data-editor="remind" hidden>
        <label class="editor-label">提醒时间<input class="task-remind-input" type="datetime-local"></label>
        <div class="editor-row">
          <button type="button" class="btn small primary" data-act="save-remind">保存提醒</button>
          <button type="button" class="btn small" data-act="clear-remind">清除提醒</button>
          <button type="button" class="btn small" data-act="cancel-remind">取消</button>
        </div>
      </div>
      <p class="task-error" role="status" hidden></p>`;
    li.querySelector('.task-edit-input').addEventListener('input', (e) => {
      const edit = taskEdit.get(item.id);
      if (edit && edit.kind === 'text') edit.value = e.target.value;
    });
    li.querySelector('.task-remind-input').addEventListener('input', (e) => {
      const edit = taskEdit.get(item.id);
      if (edit && edit.kind === 'remind') edit.value = e.target.value;
    });
    return li;
  }

  function updateTaskLi(li, item) {
    const done = item.status === 'done';
    li.classList.toggle('is-done', done);
    const textEl = li.querySelector('.task-text');
    if (textEl.textContent !== item.text) textEl.textContent = item.text;

    const remindEl = li.querySelector('.task-remind');
    if (item.remindAt && !done) {
      const label = `提醒 ${fmtLocal(item.remindAt)}${item.reminded ? '（已提醒）' : ''}`;
      if (remindEl.textContent !== label) remindEl.textContent = label;
      remindEl.hidden = false;
    } else {
      remindEl.hidden = true;
    }

    const edit = taskEdit.get(item.id);
    const textEditor = li.querySelector('[data-editor="text"]');
    const remindEditor = li.querySelector('[data-editor="remind"]');
    textEditor.hidden = !(edit && edit.kind === 'text');
    remindEditor.hidden = !(edit && edit.kind === 'remind');
    if (edit) {
      const input = (edit.kind === 'text' ? textEditor : remindEditor).querySelector('input');
      if (document.activeElement !== input && input.value !== edit.value) input.value = edit.value;
    }

    const toggleBtn = li.querySelector('[data-act="toggle"]');
    if (toggleBtn) toggleBtn.textContent = done ? '恢复' : '完成';
    for (const b of li.querySelectorAll('.task-actions [data-act]')) {
      const act = b.dataset.act;
      b.disabled = busyIds.has(item.id) || (done && (act === 'remind' || act === 'focus'));
    }
  }

  function syncList(listEl, items) {
    const existing = new Map();
    for (const li of listEl.children) existing.set(li.dataset.id, li);
    const keep = new Set();
    items.forEach((item, index) => {
      keep.add(item.id);
      let li = existing.get(item.id);
      if (!li) {
        li = taskItemElement(item);
        existing.set(item.id, li);
      }
      updateTaskLi(li, item);
      if (listEl.children[index] !== li) listEl.insertBefore(li, listEl.children[index] || null);
    });
    for (const [id, li] of existing) if (!keep.has(id)) li.remove();
  }

  function renderNotes(notes) {
    const items = Array.isArray(notes.items) ? notes.items : [];
    el.openNotes.disabled = notesBusy.has('open');
    el.connectNotes.disabled = notesBusy.has('connect');
    if (notes.connected) {
      el.notesStatus.textContent = '便签已连接，任务与提醒双端同步。';
      el.notesStatus.classList.remove('is-error');
    } else {
      el.notesStatus.textContent = `便签未连接：${notes.error || '尚未启动'}${items.length ? '。当前列表是最近一次同步的结果' : ''}`;
      el.notesStatus.classList.add('is-error');
    }
    const sig = items.map((i) => `${i.id}:${i.status}:${i.text || ''}:${i.remindAt || ''}:${i.reminded ? 1 : 0}`).join('|');
    if (sig !== itemsSig) {
      itemsSig = sig;
      const todo = items.filter((i) => i.status === 'todo');
      const done = items.filter((i) => i.status === 'done');
      syncList(el.todoList, todo);
      syncList(el.doneList, done);
      el.todoEmpty.hidden = todo.length > 0;
      el.doneEmpty.hidden = done.length > 0;
      for (const id of [...taskEdit.keys()]) {
        if (!items.some((i) => i.id === id)) taskEdit.delete(id);
      }
    }
  }

  function taskError(li, text) {
    const p = li.querySelector('.task-error');
    showLine(p, text, 'error');
  }

  function openEditor(li, kind, value) {
    taskEdit.set(li.dataset.id, { kind, value });
    updateTaskLi(li, latest.notes.items.find((i) => i.id === li.dataset.id));
    const editor = li.querySelector(kind === 'text' ? '[data-editor="text"]' : '[data-editor="remind"]');
    const input = editor.querySelector('input');
    if (input.value !== value) input.value = value;
    requestAnimationFrame(() => {
      input.focus();
      if (typeof input.setSelectionRange === 'function') {
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    });
  }

  function closeEditors(li) {
    taskEdit.delete(li.dataset.id);
    updateTaskLi(li, latest.notes.items.find((i) => i.id === li.dataset.id));
  }

  function runTaskAction(method, payload, btn, id) {
    btn.disabled = true;
    busyIds.add(id);
    return window.fish.action(method, payload).finally(() => {
      busyIds.delete(id);
      applyState(latest);
    });
  }

  async function handleTaskAction(btn, li) {
    const id = li.dataset.id;
    const act = btn.dataset.act;
    const item = latest?.notes?.items.find((i) => i.id === id);
    if (!item) return;
    try {
      switch (act) {
        case 'edit':
          taskError(li, '');
          openEditor(li, 'text', item.text);
          return;
        case 'remind':
          taskError(li, '');
          openEditor(li, 'remind', isoToLocalInput(item.remindAt));
          return;
        case 'cancel-edit':
        case 'cancel-remind':
          closeEditors(li);
          return;
        case 'save-text': {
          const value = li.querySelector('.task-edit-input').value.trim();
          if (!value) { taskError(li, '任务内容不能为空'); return; }
          await runTaskAction('updateTask', { id, patch: { text: value } }, btn, id);
          closeEditors(li);
          showLine(el.tasksMsg, '已保存修改', 'ok');
          return;
        }
        case 'save-remind': {
          const raw = li.querySelector('.task-remind-input').value;
          if (!raw) { taskError(li, '请选择提醒时间，或使用“清除提醒”'); return; }
          const iso = localToOffsetISO(raw);
          if (!iso) { taskError(li, '提醒时间无效，请重新选择'); return; }
          await runTaskAction('updateTask', { id, patch: { remindAt: iso } }, btn, id);
          closeEditors(li);
          showLine(el.tasksMsg, `已更新提醒，将在 ${fmtLocal(iso)} 提醒`, 'ok');
          return;
        }
        case 'clear-remind':
          await runTaskAction('updateTask', { id, patch: { remindAt: null } }, btn, id);
          closeEditors(li);
          showLine(el.tasksMsg, '已清除提醒', 'ok');
          return;
        case 'toggle': {
          const next = item.status === 'todo' ? 'done' : 'todo';
          await runTaskAction('updateTask', { id, patch: { status: next } }, btn, id);
          showLine(el.tasksMsg, next === 'done' ? '已标记完成（专注结束不会自动完成，由你确认）' : '已恢复为未完成', 'ok');
          return;
        }
        case 'focus': {
          selectView('focus');
          focusTaskId = id;
          overlayFocusSelect();
          await startFocusFromPanel(id);
          return;
        }
        default:
          return;
      }
    } catch (err) {
      if (act === 'focus') {
        showLine(el.focusMsg, `启动专注失败：${err.message}`, 'error');
        selectView('focus');
      } else {
        taskError(li, `操作失败：${err.message}`);
      }
    }
  }

  for (const listEl of [el.todoList, el.doneList]) {
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const li = btn.closest('.task');
      if (li) handleTaskAction(btn, li);
    });
  }

  el.taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = el.taskText.value.trim();
    if (!text) { showLine(el.tasksMsg, '请填写任务内容', 'error'); el.taskText.focus(); return; }
    const payload = { text };
    let remindIso = '';
    if (el.taskRemind.value) {
      remindIso = localToOffsetISO(el.taskRemind.value);
      if (!remindIso) { showLine(el.tasksMsg, '提醒时间无效，请重新选择', 'error'); return; }
      payload.remindAt = remindIso;
    }
    el.taskCreate.disabled = true;
    try {
      await window.fish.action('createTask', payload);
      el.taskText.value = '';
      el.taskRemind.value = '';
      showLine(el.tasksMsg, remindIso ? `已添加任务，将在 ${fmtLocal(remindIso)} 提醒` : '已添加任务', 'ok');
    } catch (err) {
      showLine(el.tasksMsg, `添加任务失败：${err.message}`, 'error');
    } finally {
      el.taskCreate.disabled = false;
    }
  });

  el.openNotes.addEventListener('click', async () => {
    notesBusy.add('open');
    el.openNotes.disabled = true;
    try {
      const snapshot = await window.fish.action('openNotes');
      if (snapshot && typeof snapshot === 'object' && latest) applyState({ ...latest, notes: snapshot });
      showLine(el.tasksMsg, snapshot?.connected ? '便签已启动并连接' : '便签启动中，正在等待连接…', snapshot?.connected ? 'ok' : undefined);
    } catch (err) {
      showLine(el.tasksMsg, `启动便签失败：${err.message}`, 'error');
    } finally {
      notesBusy.delete('open');
      applyState(latest);
    }
  });

  el.connectNotes.addEventListener('click', async () => {
    notesBusy.add('connect');
    el.connectNotes.disabled = true;
    try {
      const next = await window.fish.action('connectNotes');
      applyState(next);
      showLine(el.tasksMsg, next?.notes?.connected ? '已连接便签' : `连接未成功：${next?.notes?.error || '原因未知'}`, next?.notes?.connected ? 'ok' : 'error');
    } catch (err) {
      showLine(el.tasksMsg, `连接便签失败：${err.message}`, 'error');
    } finally {
      notesBusy.delete('connect');
      applyState(latest);
    }
  });

  // ---------- 专注 ----------
  function overlayFocusSelect() {
    const todos = (latest?.notes?.items || []).filter((i) => i.status === 'todo');
    const sig = todos.map((i) => `${i.id}:${i.text || ''}`).join('|');
    if (sig !== focusOptionsSig) {
      focusOptionsSig = sig;
      el.focusTask.textContent = '';
      const free = document.createElement('option');
      free.value = '';
      free.textContent = '自由专注';
      el.focusTask.append(free);
      for (const item of todos) {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = truncate(item.text || '未命名任务', 24);
        el.focusTask.append(opt);
      }
    }
    if (!todos.some((i) => i.id === focusTaskId)) focusTaskId = '';
    if (el.focusTask.value !== focusTaskId) el.focusTask.value = focusTaskId;
    el.focusGoalWrap.hidden = el.focusTask.value !== '';
  }

  function renderFocus(f) {
    const phase = PHASE_LABEL[f.phase] ? f.phase : 'idle';
    el.focusPhase.textContent = PHASE_LABEL[phase] + (f.paused ? '（已暂停）' : '');
    el.focusTime.textContent = phase === 'idle' ? '--:--' : fmtMs(f.remainingMs);
    el.focusTime.classList.toggle('is-idle', phase === 'idle');
    el.focusTime.classList.toggle('is-paused', Boolean(f.paused));
    const hasTarget = phase !== 'idle' && f.text;
    el.focusTarget.hidden = !hasTarget;
    if (hasTarget) el.focusTarget.textContent = `目标：${f.text}`;

    const running = phase === 'work' || phase === 'rest';
    el.btnFocusStart.hidden = !(phase === 'idle' || phase === 'restEnd');
    el.btnFocusStart.textContent = phase === 'restEnd' ? '开始下一轮' : '开始专注';
    el.btnFocusPause.hidden = !(running && !f.paused);
    el.btnFocusResume.hidden = !(running && Boolean(f.paused));
    el.btnFocusRest.hidden = phase !== 'workEnd';
    el.btnFocusStop.hidden = phase === 'idle';
    const locked = focusBusy || startingFocus;
    for (const b of [el.btnFocusStart, el.btnFocusPause, el.btnFocusResume, el.btnFocusRest, el.btnFocusStop]) {
      b.disabled = locked;
    }
    const editable = phase === 'idle' || phase === 'workEnd' || phase === 'restEnd';
    el.focusTask.disabled = !editable;
    el.focusGoal.disabled = !editable;
    el.focusWork.disabled = !editable;
    el.focusRest.disabled = !editable;

    el.focusToday.textContent = `今日：完成 ${f.completedToday ?? 0} 轮 · 累计专注 ${f.focusMinutesToday ?? 0} 分钟`;
    overlayFocusSelect();
  }

  async function startFocusFromPanel(forcedTaskId) {
    if (startingFocus) return;
    const work = parseMinutes(el.focusWork.value, '专注时长');
    if (work.error) { showLine(el.focusMsg, work.error, 'error'); return; }
    const rest = parseMinutes(el.focusRest.value, '休息时长');
    if (rest.error) { showLine(el.focusMsg, rest.error, 'error'); return; }
    const payload = { workMinutes: work.value, restMinutes: rest.value };
    const taskId = forcedTaskId !== undefined ? forcedTaskId : el.focusTask.value;
    if (taskId) payload.taskId = taskId;
    else {
      const goal = el.focusGoal.value.trim();
      if (goal) payload.text = goal;
    }
    startingFocus = true;
    try {
      await window.fish.action('startFocus', payload);
      showLine(el.focusMsg, '');
    } catch (err) {
      showLine(el.focusMsg, `启动专注失败：${err.message}`, 'error');
    } finally {
      startingFocus = false;
      applyState(latest);
    }
  }

  el.btnFocusStart.addEventListener('click', () => startFocusFromPanel());

  async function focusAction(method, label) {
    if (focusBusy) return;
    focusBusy = true;
    applyState(latest);
    try {
      await window.fish.action(method);
      showLine(el.focusMsg, '');
    } catch (err) {
      showLine(el.focusMsg, `${label}失败：${err.message}`, 'error');
    } finally {
      focusBusy = false;
      applyState(latest);
    }
  }
  el.btnFocusPause.addEventListener('click', () => focusAction('pauseFocus', '暂停'));
  el.btnFocusResume.addEventListener('click', () => focusAction('resumeFocus', '继续'));
  el.btnFocusRest.addEventListener('click', () => focusAction('startRest', '开始休息'));
  el.btnFocusStop.addEventListener('click', () => focusAction('stopFocus', '结束'));

  el.focusTask.addEventListener('change', () => {
    focusTaskId = el.focusTask.value;
    el.focusGoalWrap.hidden = el.focusTask.value !== '';
  });
  for (const [key, input] of [['workMinutes', el.focusWork], ['restMinutes', el.focusRest]]) {
    input.addEventListener('input', () => focusMinutesTouched.add(key));
  }

  // ---------- 设置 ----------
  const SETTING_INPUTS = [
    ['apiBaseUrl', () => el.setApiBase],
    ['model', () => el.setModel],
    ['workMinutes', () => el.setWork],
    ['restMinutes', () => el.setRest],
    ['noteProjectPath', () => el.setNoteProject],
    ['noteDataDir', () => el.setNoteData],
  ];

  function renderSettings(s) {
    for (const [key, getInput] of SETTING_INPUTS) {
      if (settingsDirty.has(key)) continue;
      const input = getInput();
      const value = s[key] === undefined || s[key] === null ? '' : String(s[key]);
      if (input.value !== value) input.value = value;
    }
    // 未被用户改过的专注分钟输入跟随设置默认值
    for (const [key, input] of [['workMinutes', el.focusWork], ['restMinutes', el.focusRest]]) {
      if (focusMinutesTouched.has(key)) continue;
      const value = s[key] === undefined ? '' : String(s[key]);
      if (input.value !== value) input.value = value;
    }
    el.keyState.textContent = s.hasApiKey ? '已保存 API Key，无需重复填写。' : '未保存 API Key，聊天前需要填写。';
    el.clearKeyBtn.disabled = keyBusy || !s.hasApiKey;
    el.settingsSave.disabled = savingSettings;

    if (s.error) showLine(el.settingsMsg, s.error, 'error');
    else if (settingsError) showLine(el.settingsMsg, settingsError, 'error');
    else if (settingsInfo) showLine(el.settingsMsg, settingsInfo, 'ok');
    else showLine(el.settingsMsg, '');
  }

  for (const [key, getInput] of SETTING_INPUTS) {
    getInput().addEventListener('input', () => {
      settingsDirty.add(key);
      if (settingsInfo) settingsInfo = '';
    });
  }

  el.settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (savingSettings) return;
    const current = latest?.settings || {};
    const payload = {};
    const invalid = [];

    if (settingsDirty.has('apiBaseUrl') && el.setApiBase.value.trim() !== String(current.apiBaseUrl ?? '')) {
      const v = el.setApiBase.value.trim();
      if (!v) invalid.push('API 地址不能为空');
      else payload.apiBaseUrl = v;
    }
    if (settingsDirty.has('model') && el.setModel.value.trim() !== String(current.model ?? '')) {
      const v = el.setModel.value.trim();
      if (!v) invalid.push('模型名称不能为空');
      else payload.model = v;
    }
    for (const [key, input, label] of [['workMinutes', el.setWork, '专注时长'], ['restMinutes', el.setRest, '休息时长']]) {
      if (!settingsDirty.has(key)) continue;
      if (input.value.trim() === String(current[key] ?? '')) continue;
      const parsed = parseMinutes(input.value, label);
      if (parsed.error) invalid.push(parsed.error);
      else payload[key] = parsed.value;
    }
    for (const [key, input, label] of [['noteProjectPath', el.setNoteProject, '便签项目路径'], ['noteDataDir', el.setNoteData, '便签数据目录']]) {
      if (!settingsDirty.has(key)) continue;
      if (input.value.trim() === String(current[key] ?? '')) continue;
      const v = input.value.trim();
      if (!v) invalid.push(`${label}不能为空`);
      else payload[key] = v;
    }
    const key = el.setApiKey.value.trim();
    if (key) payload.apiKey = key;
    if (el.setRemember.checked) payload.rememberKey = true;

    if (invalid.length) { settingsNotice(invalid[0], 'error'); return; }
    if (!Object.keys(payload).length) {
      settingsNotice('设置没有修改，无需保存', undefined);
      return;
    }

    savingSettings = true;
    el.settingsSave.disabled = true;
    try {
      const next = await window.fish.action('saveSettings', payload);
      savingSettings = false;
      settingsDirty.clear();
      el.setApiKey.value = '';
      el.setRemember.checked = false;
      settingsNotice('设置已保存。', 'ok');
      applyState(next);
    } catch (err) {
      savingSettings = false;
      settingsNotice(`保存设置失败：${err.message}`, 'error');
      applyState(latest);
    }
  });

  el.clearKeyBtn.addEventListener('click', async () => {
    if (keyBusy || !latest?.settings?.hasApiKey) return;
    keyBusy = true;
    el.clearKeyBtn.disabled = true;
    try {
      const next = await window.fish.action('saveSettings', { clearApiKey: true });
      el.setApiKey.value = '';
      settingsNotice('已清除保存的 API Key。', 'ok');
      applyState(next);
    } catch (err) {
      settingsNotice(`清除 Key 失败：${err.message}`, 'error');
      applyState(latest);
    } finally {
      keyBusy = false;
    }
  });

  el.selectModelBtn.addEventListener('click', async () => {
    el.selectModelBtn.disabled = true;
    try {
      await window.fish.action('selectModel');
      settingsNotice('模型选择窗口已打开。', undefined);
    } catch (err) {
      settingsNotice(`打开模型选择失败：${err.message}`, 'error');
    } finally {
      el.selectModelBtn.disabled = false;
    }
  });

  function updateMouseUI() {
    el.mouseBtn.textContent = mouseThrough ? '关闭鼠标穿透' : '开启鼠标穿透';
    el.mouseState.textContent = `鼠标穿透：${mouseThrough ? '已开启' : '关闭'}`;
  }

  async function syncMouseUI() {
    const shell = await window.fish.action('getShellInfo');
    mouseThrough = shell.mouseThrough;
    updateMouseUI();
  }

  window.addEventListener('focus', () => {
    syncMouseUI().catch(err => settingsNotice(`读取鼠标穿透状态失败：${err.message}`, 'error'));
  });

  el.mouseBtn.addEventListener('click', async () => {
    const next = !mouseThrough;
    el.mouseBtn.disabled = true;
    try {
      const result = await window.fish.action('setMouseThrough', { enabled: next });
      mouseThrough = result && typeof result.enabled === 'boolean' ? result.enabled : next;
      updateMouseUI();
    } catch (err) {
      settingsNotice(`切换鼠标穿透失败：${err.message}`, 'error');
    } finally {
      el.mouseBtn.disabled = false;
    }
  });

  async function hidePanel() {
    try {
      await window.fish.action('hidePanel');
    } catch (err) {
      settingsNotice(`关闭面板失败：${err.message}`, 'error');
    }
  }
  $('#btn-hide-panel').addEventListener('click', hidePanel);
  $('#btn-hide-panel-settings').addEventListener('click', hidePanel);

  // ---------- 标签页 ----------
  function selectView(name) {
    for (const key of Object.keys(el.views)) {
      const active = key === name;
      el.views[key].hidden = !active;
      const tab = TAB_BY_VIEW[key];
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
    }
    if (name === 'chat') scrollChat(true);
    if (name === 'settings') syncMouseUI().catch(err => settingsNotice(`读取鼠标穿透状态失败：${err.message}`, 'error'));
  }
  for (const tab of el.tabs) {
    tab.addEventListener('click', () => selectView(tab.getAttribute('aria-controls').replace('view-', '')));
  }
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const names = Object.keys(el.views);
    const current = names.findIndex((n) => el.views[n].hidden === false);
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const next = names[(current + delta + names.length) % names.length];
    selectView(next);
    TAB_BY_VIEW[next].focus();
  });

  // ---------- 启动 ----------
  async function boot() {
    el.bootError.textContent = '';
    el.bootRetry.hidden = true;
    try {
      const [state] = await Promise.all([window.fish.action('getState'), syncMouseUI()]);
      applyState(state);
    } catch (err) {
      el.bootError.textContent = `无法读取大肥鱼状态：${err.message}`;
      el.bootRetry.hidden = false;
    }
  }
  el.bootRetry.addEventListener('click', boot);
  window.fish.onState(applyState);
  window.fish.onChat(onChatEvent);
  updateMouseUI();
  boot();
})();
