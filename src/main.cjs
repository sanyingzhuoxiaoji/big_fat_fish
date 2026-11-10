'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, dialog,
  protocol, Notification, safeStorage, shell,
} = require('electron');

const { petWindowBounds, BUBBLE_HEIGHT } = require('./window-layout.cjs');
const ROOT = path.resolve(__dirname, '..');
const LOCAL = path.join(ROOT, '.local');
const PANEL_WIDTH = 390;
const PANEL_HEIGHT = 650;
const DEFAULT_MODEL = path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek', '大肥鱼.model3.json');
const SCHEME = 'fish';
const SHELL_STATE_FILE = path.join(LOCAL, 'userData', 'shell-state.json');
const WINDOW_ACTIONS = new Set(['showPanel', 'hidePanel', 'setMouseThrough', 'movePet', 'setPetScale', 'quit', 'selectModel', 'selectNotesExecutable', 'getShellInfo', 'reportPetStatus', 'petReactionResult']);
const PET_REPORT_ACTIONS = new Set(['reportPetStatus', 'petReactionResult']);

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (arg) return arg.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function resolvePath(value, fallback) {
  return path.resolve(value || fallback);
}

const dataDir = resolvePath(argValue('data-dir'), path.join(LOCAL, 'fish'));
const requestedNoteDataDir = argValue('note-data-dir') || process.env.DESKTOP_NOTE_DATA_DIR;
const noteDataDir = requestedNoteDataDir ? path.resolve(requestedNoteDataDir) : undefined;
app.setPath('userData', path.join(LOCAL, 'userData'));
app.setPath('sessionData', path.join(LOCAL, 'sessionData'));

let petWindow;
let panelWindow;
let tray;
let service;
let quitting = false;
let mouseThrough = true;   // 主开关：托盘控制；true = 透明区域放行鼠标
let hovered = false;       // 渲染端上报：光标是否悬停在鱼身上
let mouseDragging = false;
let petScale = 1;
let modelPath = DEFAULT_MODEL;
let shellState = {};
let persistTimer = null;
let moveEndTimer = null;
const allowedWebContents = new Set();
let petStatus = { ready: false, emotions: [], gestures: [], current: null, error: '模型正在加载' };
let reactionRequestId = 0;
const reactionRequests = new Map();

function readShellState() {
  try {
    const state = JSON.parse(fs.readFileSync(SHELL_STATE_FILE, 'utf8'));
    if (typeof state.modelPath === 'string' && state.modelPath.trim()) modelPath = path.resolve(state.modelPath);
    if (typeof state.mouseThrough === 'boolean') mouseThrough = state.mouseThrough;
    if (Number.isFinite(state.petScale) && state.petScale >= 0.5 && state.petScale <= 1.5) petScale = state.petScale;
    return state;
  } catch {
    return {};
  }
}

function writeShellState() {
  const bounds = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null;
  const state = { ...shellState, modelPath, mouseThrough, petScale, petBounds: bounds };
  try {
    fs.mkdirSync(path.dirname(SHELL_STATE_FILE), { recursive: true });
    const temp = `${SHELL_STATE_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), 'utf8');
    fs.renameSync(temp, SHELL_STATE_FILE);
  } catch (error) {
    console.error('[大肥鱼] 保存窗口设置失败：', error.message);
  }
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(writeShellState, 500);
}

function trustedSender(event) {
  if (!allowedWebContents.has(event.sender.id)) return false;
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith('fish://app/');
}

function broadcast(channel, payload) {
  for (const window of [petWindow, panelWindow]) {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function resetPetStatus(message) {
  petStatus = { ready: false, emotions: [], gestures: [], current: null, error: message };
  for (const pending of reactionRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }
  reactionRequests.clear();
  if (service) broadcast('fish:state', service.state());
}

function requestPetReaction(type, command) {
  if (!petStatus.ready || !petWindow || petWindow.isDestroyed()) {
    return Promise.reject(new Error(petStatus.error || '模型尚未就绪'));
  }
  const id = ++reactionRequestId;
  return new Promise((resolve, reject) => {
    const pending = { resolve, reject, timeout: null };
    pending.timeout = setTimeout(() => {
      if (reactionRequests.get(id) !== pending) return;
      reactionRequests.delete(id);
      if (type === 'reaction' && petWindow && !petWindow.isDestroyed()) {
        petWindow.webContents.send('fish:pet', { type: 'cancelReaction', id });
      }
      reject(new Error('模型未确认动作启动，请检查模型窗口'));
    }, 10000);
    reactionRequests.set(id, pending);
    petWindow.webContents.send('fish:pet', { type, id, command });
  });
}

function addTrustedWindow(window) {
  allowedWebContents.add(window.webContents.id);
  window.webContents.once('destroyed', () => allowedWebContents.delete(window.webContents.id));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('fish://app/')) event.preventDefault();
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.moc3': 'application/octet-stream',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  })[ext] || 'application/octet-stream';
}

function safeMountedPath(root, encodedPath) {
  let decoded;
  try { decoded = decodeURIComponent(encodedPath); } catch { return null; }
  const absolute = path.resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return absolute;
}

async function buildVirtualManifest() {
  const modelDir = path.dirname(modelPath);
  const original = JSON.parse(await fs.promises.readFile(modelPath, 'utf8'));
  const source = original.FileReferences;
  if (!source || !source.Moc || !Array.isArray(source.Textures)) {
    throw new Error('model3.json 缺少必要的 FileReferences.Moc 或 Textures 字段');
  }
  const references = { ...source };
  const readDir = async (subdir) => {
    try { return await fs.promises.readdir(path.join(modelDir, subdir)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
  };
  const expressionFiles = await readDir('Exp3');
  const animationFiles = await readDir('Animation');
  references.Expressions = expressionFiles
    .filter((name) => name.toLowerCase().endsWith('.exp3.json'))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((name) => ({ Name: name.slice(0, -10), File: `Exp3/${name}` }));
  const idle = [];
  const animations = [];
  for (const name of animationFiles
    .filter((entry) => entry.toLowerCase().endsWith('.motion3.json'))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    const motion = { File: `Animation/${name}` };
    if (/^idle\.motion3\.json$/i.test(name)) idle.push(motion);
    else animations.push(motion);
  }
  references.Motions = { ...(source.Motions || {}), Idle: idle, Animation: animations };
  return { ...original, FileReferences: references };
}

async function handleProtocol(request) {
  const url = new URL(request.url);
  const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers });
  }
  try {
    if (url.hostname === 'model' && url.pathname === '/manifest.virtual.json') {
      const manifest = await buildVirtualManifest();
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(manifest), {
        status: 200, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    let root;
    if (url.hostname === 'app') root = path.join(ROOT, 'src', 'ui');
    else if (url.hostname === 'vendor') root = path.join(ROOT, 'vendor');
    else if (url.hostname === 'model') root = path.dirname(modelPath);
    else return new Response('Unknown fish resource host', { status: 404, headers });
    const file = safeMountedPath(root, url.pathname);
    if (!file) return new Response('Invalid resource path', { status: 400, headers });
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return new Response('Not found', { status: 404, headers });
    const body = request.method === 'HEAD' ? null : await fs.promises.readFile(file);
    return new Response(body, {
      status: 200,
      headers: { ...headers, 'Content-Type': contentType(file), 'Content-Length': String(stat.size) },
    });
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 500;
    return new Response(`大肥鱼资源加载失败：${error.message}`, {
      status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

function clampPetBounds(x, y) {
  const workArea = screen.getDisplayNearestPoint({ x, y }).workArea;
  return petWindowBounds({ x, y, scale: petScale, workArea });
}

function applyMousePolicy() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.setIgnoreMouseEvents(mouseThrough && !hovered && !mouseDragging, { forward: true });
}

function showPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) createPanelWindow();
  if (!panelWindow.isVisible()) {
    const petBounds = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null;
    const display = petBounds
      ? screen.getDisplayNearestPoint({ x: petBounds.x, y: petBounds.y })
      : screen.getPrimaryDisplay();
    const area = display.workArea;
    let x = petBounds ? petBounds.x - PANEL_WIDTH - 16 : area.x + area.width - PANEL_WIDTH - 24;
    if (x < area.x) x = petBounds ? petBounds.x + petBounds.width + 16 : area.x + 24;
    x = Math.max(area.x, Math.min(x, area.x + area.width - PANEL_WIDTH));
    const y = petBounds
      ? Math.max(area.y, Math.min(petBounds.y + 24, area.y + area.height - PANEL_HEIGHT))
      : area.y + 24;
    panelWindow.setBounds({ x, y, width: PANEL_WIDTH, height: PANEL_HEIGHT });
    panelWindow.show();
  }
  panelWindow.focus();
  return { visible: true };
}

function hidePanel() {
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.hide();
  return { visible: false };
}

function getModelFiles() {
  const directory = path.dirname(modelPath);
  const list = (subdir, suffix) => {
    try {
      return fs.readdirSync(path.join(directory, subdir))
        .filter((name) => name.toLowerCase().endsWith(suffix))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    } catch {
      return [];
    }
  };
  return {
    expressions: list('Exp3', '.exp3.json').map((name) => name.slice(0, -10)),
    motions: list('Animation', '.motion3.json').map((name) => name.replace(/\.motion3\.json$/i, '')),
  };
}

async function selectModel() {
  const result = await dialog.showOpenDialog(panelWindow || petWindow, {
    title: '选择 Live2D 模型文件',
    defaultPath: path.dirname(modelPath),
    properties: ['openFile'],
    filters: [{ name: 'Live2D 模型', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const selected = path.resolve(result.filePaths[0]);
  if (!selected.toLowerCase().endsWith('.model3.json')) {
    throw new Error('请选择文件名以 .model3.json 结尾的 Live2D 模型文件。');
  }
  const parsed = JSON.parse(await fs.promises.readFile(selected, 'utf8'));
  if (!parsed.FileReferences || !parsed.FileReferences.Moc) {
    throw new Error('所选文件不是有效的 Cubism model3.json。');
  }
  const mocPath = path.resolve(path.dirname(selected), parsed.FileReferences.Moc);
  await fs.promises.access(mocPath, fs.constants.R_OK);
  modelPath = selected;
  writeShellState();
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.reload();
  return { canceled: false, modelPath };
}

async function selectNotesExecutable() {
  const result = await dialog.showOpenDialog(panelWindow || petWindow, {
    title: '选择本机已安装的桌面便签',
    defaultPath: service.state().settings.noteExePath || undefined,
    filters: [{ name: 'Windows 程序', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return service.handle('saveSettings', { noteExePath: result.filePaths[0] });
}

async function handleWindowAction(method, payload = {}) {
  switch (method) {
    case 'showPanel': return showPanel();
    case 'hidePanel': return hidePanel();
    case 'setMouseThrough': {
      if (payload.enabled !== undefined) {
        if (typeof payload.enabled !== 'boolean') throw new TypeError('setMouseThrough 需要 boolean enabled');
        mouseThrough = payload.enabled;
        schedulePersist();
        if (tray) rebuildTrayMenu();
      }
      if (payload.hovered !== undefined) {
        if (typeof payload.hovered !== 'boolean') throw new TypeError('setMouseThrough 需要 boolean hovered');
        hovered = payload.hovered;
      }
      applyMousePolicy();
      return { enabled: mouseThrough, mouseThrough, ignore: mouseThrough && !hovered && !mouseDragging };
    }
    case 'setPetScale': {
      const scale = payload.scale;
      if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.5 || scale > 1.5) {
        throw new TypeError('模型大小应在 50% 到 150% 之间');
      }
      petScale = scale;
      if (petWindow && !petWindow.isDestroyed()) {
        const previous = petWindow.getBounds();
        const workArea = screen.getDisplayMatching(previous).workArea;
        petWindow.setBounds(petWindowBounds({ scale, workArea, previous }));
      }
      schedulePersist();
      return { scale: petScale };
    }
    case 'movePet': {
      if (!petWindow || petWindow.isDestroyed()) return { moved: false };
      const dx = Number(payload.dx);
      const dy = Number(payload.dy);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new TypeError('movePet 需要有限的 dx、dy');
      mouseDragging = true;
      const bounds = petWindow.getBounds();
      petWindow.setBounds(clampPetBounds(bounds.x + dx, bounds.y + dy));
      applyMousePolicy();
      clearTimeout(moveEndTimer);
      moveEndTimer = setTimeout(() => {
        mouseDragging = false;
        applyMousePolicy();
        writeShellState();
      }, 300);
      return { moved: true };
    }
    case 'quit':
      quitting = true;
      writeShellState();
      service?.close?.();
      app.quit();
      return { quitting: true };
    case 'selectModel': return selectModel();
    case 'selectNotesExecutable': return selectNotesExecutable();
    case 'reportPetStatus': {
      petStatus = payload;
      if (service) broadcast('fish:state', service.state());
      return { received: true };
    }
    case 'petReactionResult': {
      const pending = reactionRequests.get(payload.id);
      if (!pending) return { received: false };
      clearTimeout(pending.timeout);
      reactionRequests.delete(payload.id);
      if (payload.error) pending.reject(new Error(payload.error));
      else pending.resolve(payload.result);
      return { received: true };
    }
    case 'getShellInfo': return {
      modelPath,
      modelExists: fs.existsSync(modelPath),
      mouseThrough,
      petScale,
      bubbleHeight: BUBBLE_HEIGHT,
      files: getModelFiles(),
      petBounds: petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null,
      panelVisible: !!(panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()),
      versions: { electron: process.versions.electron, chromium: process.versions.chrome },
    };
    default: throw new Error(`不支持的窗口操作：${method}`);
  }
}

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: PANEL_WIDTH, height: PANEL_HEIGHT, minWidth: 320, minHeight: 440,
    frame: false, show: false, resizable: true, backgroundColor: '#f5f7fb',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  addTrustedWindow(panelWindow);
  panelWindow.loadURL('fish://app/panel.html');
  panelWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); panelWindow.hide(); } });
  panelWindow.on('closed', () => { panelWindow = null; });
}

function createPetWindow(savedBounds) {
  const previous = savedBounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(savedBounds[key])) ? savedBounds : undefined;
  const workArea = previous ? screen.getDisplayMatching(previous).workArea : screen.getPrimaryDisplay().workArea;
  const bounds = petWindowBounds({ scale: petScale, workArea, previous });
  petWindow = new BrowserWindow({
    ...bounds, frame: false, transparent: true,
    resizable: false, skipTaskbar: true, show: true, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  addTrustedWindow(petWindow);
  petWindow.webContents.on('did-start-loading', () => resetPetStatus('模型正在加载'));
  petWindow.webContents.on('render-process-gone', () => resetPetStatus('模型渲染进程已退出，请重新加载模型'));
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  petWindow.loadURL('fish://app/pet.html');
  petWindow.on('move', schedulePersist);
  petWindow.on('closed', () => { petWindow = null; });
}

function togglePanel() {
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) hidePanel();
  else showPanel();
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示大肥鱼',
      click: () => {
        if (!petWindow || petWindow.isDestroyed()) return createPetWindow(shellState.petBounds);
        petWindow.show();
        petWindow.setAlwaysOnTop(true, 'screen-saver');
        const bounds = petWindow.getBounds();
        petWindow.setBounds(clampPetBounds(bounds.x, bounds.y));
      },
    },
    { label: panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible() ? '隐藏控制面板' : '打开控制面板', click: togglePanel },
    {
      type: 'checkbox',
      label: '鼠标穿透（透明区域不挡点击）',
      checked: mouseThrough,
      click: (item) => {
        mouseThrough = item.checked;
        applyMousePolicy();
        schedulePersist();
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: '退出大肥鱼',
      click: () => {
        quitting = true;
        writeShellState();
        service?.close?.();
        app.quit();
      },
    },
  ]));
}

function createTray() {
  const iconPath = path.join(__dirname, 'ui', 'assets', 'tray.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('大肥鱼桌宠');
  tray.on('click', togglePanel);
  rebuildTrayMenu();
}

function encryptSecret(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 系统加密存储不可用，无法安全记住 API Key。请取消勾选“记住 Key”后保存。');
  }
  return safeStorage.encryptString(String(value)).toString('base64');
}

function decryptSecret(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 系统加密存储不可用，无法读取已保存的 API Key。');
  }
  return safeStorage.decryptString(Buffer.from(String(value), 'base64'));
}

function createService() {
  const modulePath = path.join(__dirname, 'app-service.cjs');
  if (!fs.existsSync(modulePath)) throw new Error(`缺少应用业务服务文件：${modulePath}`);
  const { createAppService } = require(modulePath);
  if (typeof createAppService !== 'function') throw new Error('src/app-service.cjs 未导出 createAppService()');
  service = createAppService({
    dataDir,
    noteDataDir,
    desktopDir: app.getPath('desktop'),
    readShortcutLink: (file) => shell.readShortcutLink(file),
    openNoteExecutable: (file) => shell.openPath(file),
    getPetState: () => structuredClone(petStatus),
    playPetReaction: (command) => requestPetReaction('reaction', command),
    stopPetReaction: () => requestPetReaction('stopReaction'),
    onState: (state) => broadcast('fish:state', state),
    onChat: (event) => broadcast('fish:chat', event),
    onPet: (event) => broadcast('fish:pet', event),
    notify: ({ title, body }) => {
      if (Notification.isSupported()) new Notification({ title: String(title || '大肥鱼'), body: String(body || '') }).show();
    },
    encryptSecret,
    decryptSecret,
  });
  if (!service || typeof service.init !== 'function' || typeof service.handle !== 'function') {
    throw new Error('createAppService() 返回值缺少 init() 或 handle()');
  }
  return service.init();
}

ipcMain.handle('fish:action', async (event, method, payload) => {
  if (!trustedSender(event)) throw new Error('拒绝来自未授权窗口的 IPC 调用');
  if (typeof method !== 'string') throw new TypeError('action 名称必须是字符串');
  if (PET_REPORT_ACTIONS.has(method) && event.sender !== petWindow?.webContents) {
    throw new Error('动作回执只能由模型窗口提交');
  }
  if (WINDOW_ACTIONS.has(method)) return handleWindowAction(method, payload);
  if (!service) throw new Error('业务服务尚未初始化完成，请稍后重试。');
  return service.handle(method, payload);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.show();
      petWindow.setAlwaysOnTop(true, 'screen-saver');
    }
    showPanel();
  });

  app.whenReady().then(async () => {
    // 自定义协议的 Request.headers 要求 ByteString；中文 productName 不能进入 UA 应用标识。
    app.userAgentFallback = app.userAgentFallback.replace(`${app.getName()}/`, 'BigFatFish/');
    fs.mkdirSync(LOCAL, { recursive: true });
    shellState = readShellState();
    protocol.handle(SCHEME, handleProtocol);
    createPetWindow(shellState.petBounds);
    createPanelWindow();
    createTray();
    try {
      await createService();
    } catch (error) {
      console.error('[大肥鱼] 业务服务初始化失败：', error.stack || String(error));
      dialog.showErrorBox('大肥鱼初始化失败', `${error.message || error}\n\n详细错误见控制台输出。`);
    }
  }).catch((error) => {
    console.error('[大肥鱼] Electron 启动失败：', error);
    dialog.showErrorBox('大肥鱼启动失败', error.stack || String(error));
  });
}

app.on('before-quit', () => {
  quitting = true;
  clearTimeout(persistTimer);
  clearTimeout(moveEndTimer);
  resetPetStatus('应用正在退出');
  writeShellState();
  service?.close?.();
});
app.on('window-all-closed', () => { /* 常驻托盘，不随窗口关闭退出 */ });
