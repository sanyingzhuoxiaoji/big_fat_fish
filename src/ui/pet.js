'use strict';

/* 大肥鱼桌宠渲染端：加载 Live2D 模型、气泡/表情反馈、悬停穿透与拖拽。
 * 渲染库为本地打包的 vendor/runtime.bundle.js（pixi.js 8 + @laplace.live/pixijs-live2d，
 * 内含 Cubism 5 框架镜像），全部能力通过 window.fish（preload）与 main 进程通信，无 Node 权限。 */

(function () {
  const stageEl = document.getElementById('model-stage');
  const bubbleEl = document.getElementById('bubble');
  const loadingEl = document.getElementById('loading');
  const loadingDetail = document.getElementById('loading-detail');
  const errorEl = document.getElementById('error');
  const errorDetail = document.getElementById('error-detail');
  const retryEl = document.getElementById('retry');

  const state = {
    model: null,
    app: null,
    reactions: null,
    reactionRequestId: null,
    hovered: false,
    dragging: false,
    dragMoved: false,
    dragStart: null,
    dragLast: null,
    bubbleTimer: 0,
  };

  const SETUP_HINT = '请在项目根目录执行 npm install && npm run setup';

  function setLoadingDetail(text) {
    if (loadingDetail) loadingDetail.textContent = text;
  }

  function showError(detail) {
    loadingEl.hidden = true;
    errorDetail.textContent = detail || '未知错误';
    errorEl.hidden = false;
  }

  function showLoading() {
    errorEl.hidden = true;
    loadingEl.hidden = false;
  }

  function hideNotices() {
    loadingEl.hidden = true;
    errorEl.hidden = true;
  }

  /* ---------- 气泡 ---------- */
  function showBubble(text) {
    if (!text || !bubbleEl) return;
    bubbleEl.textContent = text;
    bubbleEl.hidden = false;
    clearTimeout(state.bubbleTimer);
    const duration = Math.min(20000, Math.max(6000, text.length * 260));
    state.bubbleTimer = setTimeout(() => { bubbleEl.hidden = true; }, duration);
  }

  /* ---------- 表情/动作 ---------- */
  function reportPetState(snapshot) {
    return window.fish.action('reportPetStatus', snapshot).catch(error => {
      console.warn('[大肥鱼] 模型状态上报失败：', error.message);
    });
  }

  function applyExpression(name) {
    if (!state.reactions) return;
    const operation = name ? state.reactions.showExpression(name) : state.reactions.stop();
    Promise.resolve(operation).catch(error => console.warn('[大肥鱼] 表情不可用：', error.message));
  }


  /* ---------- 命中检测 ---------- */
  function modelRect() {
    if (!state.model) return null;
    const rect = state.model.getBounds();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  }

  function pointerInModel(event) {
    const rect = modelRect();
    if (!rect) return false;
    const stage = stageEl.getBoundingClientRect();
    const x = event.clientX - stage.left;
    const y = event.clientY - stage.top;
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  }

  function setHovered(hovered) {
    if (state.hovered === hovered) return;
    state.hovered = hovered;
    document.body.style.cursor = hovered && !state.dragging ? 'grab' : 'default';
    // 仅上报悬停状态；穿透开关（mouseThrough）由主进程托盘/设置维护，这里不再回传旧值。
    window.fish.action('setMouseThrough', { hovered }).catch(() => {});
  }

  /* ---------- 指针事件（穿透窗口用 forward 转发事件） ---------- */
  function onPointerMove(event) {
    if (state.dragging) {
      const dx = event.screenX - state.dragLast.x;
      const dy = event.screenY - state.dragLast.y;
      if (dx === 0 && dy === 0) return;
      state.dragLast = { x: event.screenX, y: event.screenY };
      if (Math.abs(event.clientX - state.dragStart.x) + Math.abs(event.clientY - state.dragStart.y) > 6) {
        state.dragMoved = true;
        document.body.style.cursor = 'grabbing';
      }
      window.fish.action('movePet', { dx, dy }).catch(() => {});
      return;
    }
    setHovered(pointerInModel(event) || (!bubbleEl.hidden && bubbleEl.contains(event.target)) || Boolean(event.target.closest?.('button')));
  }

  function onPointerDown(event) {
    if (event.button !== 0 || !pointerInModel(event)) return;
    state.dragging = true;
    state.dragMoved = false;
    state.dragStart = { x: event.clientX, y: event.clientY };
    state.dragLast = { x: event.screenX, y: event.screenY };
    setHovered(true);
  }

  function onPointerUp(event) {
    if (!state.dragging) return;
    state.dragging = false;
    document.body.style.cursor = state.hovered ? 'grab' : 'default';
    const stillInside = pointerInModel(event);
    window.fish.action('setMouseThrough', { hovered: stillInside }).catch(() => {});
    if (!state.dragMoved && stillInside) {
      window.fish.action('showPanel').catch((error) => console.warn('[大肥鱼] 打开面板失败：', error?.message));
    }
  }

  function onPointerLeave() {
    if (state.dragging) return;
    setHovered(false);
  }

  /* ---------- 模型适配 ---------- */
  function fitModel() {
    if (!state.model || !state.app) return;
    const width = stageEl.clientWidth || window.innerWidth;
    const height = stageEl.clientHeight || window.innerHeight;
    const originalWidth = state.model.internalModel?.originalWidth || state.model.width || width;
    const originalHeight = state.model.internalModel?.originalHeight || state.model.height || height;
    const scale = Math.min(width / originalWidth, height / originalHeight) * 0.96;
    state.model.scale.set(scale);
    state.model.x = width / 2;
    state.model.y = height / 2;
  }

  function onStageResize() {
    if (!state.app) return;
    state.app.renderer.resize(
      stageEl.clientWidth || window.innerWidth,
      stageEl.clientHeight || window.innerHeight,
    );
    fitModel();
  }

  /* 当前框架 5-r.5 需要 Core 06（moc3 v6/API），即使加载的是较早版本的模型。 */
  function checkRuntime() {
    if (!window.Live2DCubismCore) {
      return '缺少 live2dcubismcore.min.js，' + SETUP_HINT;
    }
    const latestMoc = window.Live2DCubismCore.Version?.csmGetLatestMocVersion?.();
    if (typeof latestMoc !== 'number' || latestMoc < 6) {
      return `Cubism Core 与框架不兼容（最高支持 moc 版本 ${typeof latestMoc === 'number' ? latestMoc : '未知'}），需要 Core 06 / SDK 5-r.5；` +
        `请重新运行 ${SETUP_HINT}，自动更新匹配的官方 Core`;
    }
    if (!window.PIXI?.Application || !window.Live2DModel) {
      return '缺少 PIXI 或 Live2D 运行库（vendor/runtime.bundle.js），' + SETUP_HINT;
    }
    return null;
  }

  async function loadModel() {
    showLoading();
    setLoadingDetail('正在检查运行库');
    const runtimeError = checkRuntime();
    if (runtimeError) throw new Error(runtimeError);

    setLoadingDetail('正在读取模型清单');
    const manifestUrl = 'fish://model/manifest.virtual.json';
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`模型清单读取失败（HTTP ${response.status}）`);
    const manifest = await response.json();
    // 引擎要求 settings JSON 携带 url 字段，用于解析 Moc/Textures/Exp3/Animation 相对路径
    manifest.url = response.url || manifestUrl;

    setLoadingDetail('正在初始化渲染器');
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    stageEl.appendChild(canvas);
    const app = new window.PIXI.Application();
    await app.init({
      canvas,
      width: stageEl.clientWidth || window.innerWidth,
      height: stageEl.clientHeight || window.innerHeight,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    state.app = app;

    setLoadingDetail('正在加载模型与动作');
    const model = await window.Live2DModel.from(manifest, {
      autoFocus: false,
      autoHitTest: false,
      // fish: 仅供本地资源；使用 DOM 图片解码，避免 Pixi 的 blob Worker 探测悬挂。
      textureOptions: { preferCreateImageBitmap: false },
    });
    state.model = model;
    app.stage.addChild(model);
    model.anchor.set(0.5, 0.5);
    fitModel();
    const { PetReactionController } = await import('./pet-reactions.mjs');
    state.reactions = new PetReactionController({ model, onState: reportPetState });
    await reportPetState(state.reactions.snapshot());
    window.addEventListener('resize', onStageResize);

    hideNotices();
  }

  async function handlePetEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'bubble') return showBubble(event.text);
    if (event.type === 'expression') return applyExpression(event.name);
    if (event.type === 'cancelReaction') {
      // 主进程超时取消：无回执（对应请求已过期）；仅当该 id 仍是最新动作请求时才生效，过期通知不能停掉替换后的新场景。
      if (state.reactionRequestId !== event.id) return;
      state.reactionRequestId = null;
      if (!state.reactions) return;
      return state.reactions.stop();
    }
    if (event.type !== 'reaction' && event.type !== 'stopReaction') return;
    try {
      if (!state.reactions) throw new Error('模型动作尚未加载完成');
      let playing;
      if (event.type === 'reaction') {
        state.reactionRequestId = event.id;
        playing = state.reactions.play(event.command);
      } else {
        state.reactionRequestId = null;
        playing = state.reactions.stop();
      }
      const result = await playing;
      await window.fish.action('petReactionResult', { id: event.id, result });
    } catch (error) {
      await window.fish.action('petReactionResult', { id: event.id, error: error.message });
    }
  }

  /* ---------- 事件订阅 ---------- */
  function subscribe() {
    window.fish.onPet(event => {
      handlePetEvent(event).catch(error => console.warn('[大肥鱼] 动作回执失败：', error.message));
    });
    window.addEventListener('mousemove', onPointerMove, { passive: true });
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('mouseleave', onPointerLeave);
    document.addEventListener('contextmenu', (event) => event.preventDefault());
    retryEl?.addEventListener('click', () => window.location.reload());
    window.addEventListener('beforeunload', () => state.reactions?.destroy());
    window.addEventListener('error', (event) => {
      if (errorEl.hidden && state.app) showError(event.message);
    });
  }

  subscribe();
  loadModel().catch((error) => {
    console.error('[大肥鱼] 模型加载失败：', error);
    showError(error?.message || String(error));
    reportPetState({ ready: false, emotions: [], gestures: [], current: null, error: error?.message || String(error) });
  });
})();
