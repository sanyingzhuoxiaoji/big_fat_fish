/* 大肥鱼桌宠反应控制器：把 reaction-catalog 的语义指令落到原生 Live2D 渲染上。
 *
 * 运行环境：Electron 渲染端（@laplace.live/pixijs-live2d 0.6.1 + Pixi8 + Cubism 5 框架镜像）。
 * 依赖的事实（vendor/runtime 对应 dist/index.js 实测）：
 * - 引擎更新顺序：updateMotions → saveParameters → expressionManager.update → eyeBlink →
 *   updateFocus → updateNaturalMovements → 物理姿势更新 → core.update → loadParameters。
 *   因此包一层 updateNaturalMovements：先调原实现，再写我们的头部/惊讶通道——值不会被
 *   saveParameters 收进基线（帧末 loadParameters 还原），且在物理求值前生效。
 *   头部通道写物理输入 AngleX/Y/Z（本模型 physics3.json：Angle* → ParamAngle* + 头发），
 *   由作者物理呈现头部与二级摆动；绝不改写物理输出或关闭物理。
 * - coreModel 是原生 CubismModel：用 getModel().parameters.ids 找真实下标（getParameterIds
 *   返回的是句柄对象不是字符串），getParameterValueByIndex/setParameterValueByIndex 读写
 *   （setter 按原生范围截断）。
 * - motionManager.definitions 按 group 分组、definition.File 是 "Animation/xxx.motion3.json"；
 *   expressionManager.definitions 带 Name，getExpressionIndex(name) 查支持。
 * - motionManager.startMotion 同步先 reserve 再异步 loadMotion；queueManager 抽干后
 *   update() 发 "motionFinish" 事件（options.onFinish 只在音频同步路径触发，本模型无音频，
 *   不能依赖）。loop 选项优先于动作 JSON 的 Loop 元数据（setLoop(loop ?? motion._motionData.loop)）。
 *
 * 手部动作对（wave/point）的入场和收尾均强制非循环。
 * 两段都等待真实 motionFinish；保持段不重放首0末1的切换曲线，整段时长包含入场与收尾。
 * 入场前预载成对资源，失败时恢复先前的手势选择器，不把停止队列冒充姿势已复位。
 */

import { EMOTIONS, GESTURES, normalizeReaction } from './reaction-catalog.mjs';

const PRIORITY_FORCE = 3;
const RELEASE_MS = 250;          // 通道取消后的平滑回落窗口
const FINISH_GRACE_MS = 3000;    // motionFinish 看门狗宽限（超过即判定卡死并强制复位）
const LOCAL_EXPRESSIONS = new Set(['加载', '脸红', '流冷汗']);

export class PetReactionController {
  #model = null;
  #onState = null;
  #caps = { ready: false, emotions: [], gestures: [] };
  #paramIndexById = new Map(); // 原生参数 id -> 下标（一次性预算，帧内零分配）
  #motionCache = new Map();    // 动作文件名 -> {group,index} | null
  #originalUpdateNatural = null;
  #channels = [];              // 活跃通道（头部摆动/惊讶参数）
  #run = null;                 // 当前反应序列
  #current = null;             // {emotion, gesture, phase}
  #error = null;
  #token = 0;                  // 单一导演令牌：play/stop/destroy 递增，异步续体校验
  #feedback = null;            // 本地反馈表情（加载/脸红/流冷汗）：{expression, timer}
  #lifecycle = new Set();      // destroy 时统一清理的监听/定时器
  #destroyed = false;

  constructor({ model, onState } = {}) {
    this.#model = model || null;
    this.#onState = typeof onState === 'function' ? onState : null;
    this.#probe();
    if (this.#caps.ready) this.#install();
  }

  /* ---------- 能力探测：只发布模型真实支持的档案，通用模型绝不虚报 ---------- */
  #probe() {
    const internal = this.#model && this.#model.internalModel;
    const motionManager = (internal && internal.motionManager) || null;
    const expressionManager = (motionManager && motionManager.expressionManager) || null;
    const core = (internal && internal.coreModel) || null;
    let ids = null;
    if (core && typeof core.getModel === 'function') {
      try {
        const native = core.getModel();
        if (native && native.parameters && Array.isArray(native.parameters.ids)) ids = native.parameters.ids;
      } catch { ids = null; }
    }
    const canWrite = !!(ids
      && typeof core.getParameterValueByIndex === 'function'
      && typeof core.setParameterValueByIndex === 'function');
    if (canWrite) {
      for (let i = 0; i < ids.length; i++) {
        const id = String(ids[i]);
        if (!this.#paramIndexById.has(id)) this.#paramIndexById.set(id, i);
      }
    }
    const ready = !!(internal && motionManager && canWrite
      && typeof internal.updateNaturalMovements === 'function'
      && typeof this.#model.motion === 'function');
    if (!ready) {
      this.#error = '模型能力不足：缺少原生参数访问、动作或表情管理器，反应不可用';
      return;
    }
    this.#caps.ready = true;

    const emotions = ['neutral'];
    for (const [id, spec] of Object.entries(EMOTIONS)) {
      if (id === 'neutral') continue;
      if (spec.kind === 'expression') {
        if (expressionManager && typeof expressionManager.getExpressionIndex === 'function'
          && expressionManager.getExpressionIndex(spec.expression) >= 0) emotions.push(id);
      } else if (spec.kind === 'parameters') {
        if (spec.parameters.every((p) => this.#paramIndexById.has(p.id))) emotions.push(id);
      }
    }
    this.#caps.emotions = emotions;

    const gestures = ['none'];
    for (const [id, spec] of Object.entries(GESTURES)) {
      if (id === 'none') continue;
      if (spec.kind === 'channel') {
        if (this.#resolveChannelParam(spec)) gestures.push(id);
      } else if (spec.kind === 'motionPair') {
        if (spec.selectors.every(id => this.#paramIndexById.has(id))
          && this.#resolveMotion(spec.enter) && this.#resolveMotion(spec.exit)) gestures.push(id);
      }
    }
    this.#caps.gestures = gestures;
  }

  /* 通道参数按目录优先级选取：优先物理输入 Angle*（作者物理驱动 ParamAngle* 与头发），模型缺失时回退 ParamAngle*。 */
  #resolveChannelParam(spec) {
    for (const id of spec.parameters) {
      const index = this.#paramIndexById.get(id);
      if (index !== undefined) return { id, index };
    }
    return null;
  }

  #resolveMotion(stem) {
    if (this.#motionCache.has(stem)) return this.#motionCache.get(stem);
    let found = null;
    const definitions = this.#model?.internalModel?.motionManager?.definitions;
    if (definitions) {
      const suffix = `/${stem.toLowerCase()}.motion3.json`;
      for (const group of Object.keys(definitions)) {
        const defs = definitions[group];
        if (!Array.isArray(defs)) continue;
        for (let i = 0; i < defs.length; i++) {
          const file = defs[i] && defs[i].File;
          if (typeof file === 'string' && file.toLowerCase().endsWith(suffix)) {
            found = { group, index: i };
            break;
          }
        }
        if (found) break;
      }
    }
    this.#motionCache.set(stem, found);
    return found;
  }

  /* ---------- 引擎钩子：包裹 updateNaturalMovements，帧内追加有界平滑通道 ---------- */
  #install() {
    const internal = this.#model.internalModel;
    const original = internal.updateNaturalMovements;
    const controller = this;
    this.#originalUpdateNatural = original;
    internal.updateNaturalMovements = function (dt, now) {
      original.call(this, dt, now);
      controller.#applyChannels();
    };
  }

  #applyChannels() {
    if (this.#destroyed || !this.#channels.length) return;
    const core = this.#model?.internalModel?.coreModel;
    if (!core) return;
    const now = performance.now();
    for (let i = this.#channels.length - 1; i >= 0; i--) {
      const ch = this.#channels[i];
      const u = (now - ch.t0) / ch.windowMs;
      if (u >= 1) { this.#channels.splice(i, 1); continue; }
      if (u <= 0) continue;
      let delta;
      if (ch.mode === 'release') {
        delta = ch.contribution * (1 - u * u * (3 - 2 * u)); // smoothstep 平滑回落
      } else {
        const env = Math.sin(Math.PI * u); // 0→1→0 包络，起止都归零
        if (ch.mode === 'add') {
          // dip：点头等下探回正（不越过基线上扬）；swing：左右对称摆；lean：单侧倾倒回正
          const osc = ch.shape === 'dip' ? Math.sin(Math.PI * ch.cycles * u) ** 2
            : ch.shape === 'swing' ? Math.sin(2 * Math.PI * ch.cycles * u) : 1;
          delta = ch.amplitude * env * osc;
        } else {
          delta = (ch.target - core.getParameterValueByIndex(ch.index)) * env;
        }
      }
      if (delta !== 0) core.setParameterValueByIndex(ch.index, core.getParameterValueByIndex(ch.index) + delta);
      if (ch.mode !== 'release') ch.contribution = delta;
    }
  }

  #startChannel(spec, seconds, strength) {
    const resolved = this.#resolveChannelParam(spec);
    if (!resolved) throw new Error(`参数不支持：${spec.parameters.join('/')}`);
    this.#channels.push({
      mode: 'add',
      index: resolved.index,
      amplitude: spec.amplitude * strength,
      cycles: spec.cycleSeconds > 0 ? Math.max(1, Math.round(seconds / spec.cycleSeconds)) : 0,
      shape: spec.shape,
      t0: performance.now(),
      windowMs: seconds * 1000,
      contribution: 0,
    });
  }

  #releaseChannels() {
    if (!this.#channels.length) return;
    const now = performance.now();
    const old = this.#channels;
    this.#channels = [];
    for (const ch of old) {
      this.#channels.push({
        mode: 'release',
        index: ch.index,
        t0: now,
        windowMs: RELEASE_MS,
        contribution: ch.contribution || 0,
      });
    }
  }

  /* ---------- 表情/反馈 ---------- */
  #expressionManager() {
    return this.#model?.internalModel?.motionManager?.expressionManager || null;
  }

  #clearExpressions() {
    const manager = this.#expressionManager();
    if (manager && typeof manager.clearExpressions === 'function') {
      try { manager.clearExpressions(); } catch { /* 原生清理失败交由上层状态呈现 */ }
    }
  }

  /* 本地反馈表情（加载/脸红/流冷汗等）：同一导演生命周期，绝不留游离定时器。 */
  #clearFeedback() {
    const fb = this.#feedback;
    if (!fb) return;
    this.#feedback = null;
    clearTimeout(fb.timer);
    const manager = this.#expressionManager();
    if (manager && typeof manager.unsetExpression === 'function' && manager.getExpressionIndex(fb.expression) >= 0) {
      try { manager.unsetExpression(fb.expression); } catch { /* 忽略，反馈表情随下次清理淡出 */ }
    }
  }

  #resolveExpression(name) {
    const key = String(name ?? '');
    if (!key) throw new Error('表情不支持：（未指定名称）');
    if (Object.prototype.hasOwnProperty.call(EMOTIONS, key)) {
      const spec = EMOTIONS[key];
      if (spec.kind === 'clear') return null; // neutral = 清空表情
      if (spec.kind === 'expression') {
        if (!this.#caps.emotions.includes(key)) throw new Error(`表情不支持：${key}（当前模型未提供该表情）`);
        return spec.expression;
      }
      throw new Error(`表情不支持：${key}（参数型表情请通过 play 反应驱动）`);
    }
    if (!LOCAL_EXPRESSIONS.has(key)) throw new Error(`表情不支持：${key}`);
    const manager = this.#expressionManager();
    if (!manager || typeof manager.getExpressionIndex !== 'function' || manager.getExpressionIndex(key) < 0) {
      throw new Error(`表情不支持：${key}`);
    }
    return key;
  }

  async showExpression(name, seconds = 4) {
    if (this.#destroyed) throw new Error('控制器已销毁，无法显示表情');
    if (!this.#caps.ready) throw new Error(`模型尚未就绪（ready 为 false），无法显示表情：${String(name)}`);
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 60) {
      throw new Error(`时长无效：${String(seconds)}（showExpression 需要有限的正数秒，上限 60）`);
    }
    const resolved = this.#resolveExpression(name);
    const mine = ++this.#token;
    this.#error = null;
    this.#clearFeedback();
    await this.#settlePrevious();
    if (mine !== this.#token || this.#destroyed) return { status: 'superseded' };
    this.#clearExpressions();
    if (resolved === null) return { status: 'playing', expression: null, seconds: 0 };
    const manager = this.#expressionManager();
    const ok = await manager.setExpression(resolved);
    if (mine !== this.#token || this.#destroyed) return { status: 'superseded' };
    const active = manager.activeExpressionNames().includes(resolved);
    if (!ok && !active) throw new Error(`表情启动失败：${resolved}`);
    const timer = setTimeout(() => {
      if (this.#feedback && this.#feedback.timer === timer) {
        this.#feedback = null;
        try { manager.unsetExpression(resolved); } catch { /* 淡出失败不阻塞 */ }
      }
    }, seconds * 1000);
    this.#feedback = { expression: resolved, timer };
    return { status: 'playing', expression: resolved, seconds };
  }

  /* ---------- 反应序列 ---------- */
  async play(command) {
    if (this.#destroyed) throw new Error('控制器已销毁，无法播放反应');
    const normalized = normalizeReaction(command, {
      ready: this.#caps.ready,
      emotions: this.#caps.emotions,
      gestures: this.#caps.gestures,
    });
    const mine = ++this.#token;
    this.#error = null;
    await this.#settlePrevious();
    if (mine !== this.#token) return { status: 'superseded', ...normalized };

    const run = {
      token: mine,
      emotion: normalized.emotion,
      gesture: normalized.gesture,
      phase: 'entering',
      abandoned: false,
      startConfirmed: false,
      timers: new Map(),
      handBaseline: [],
      enterPromise: null,
      enterFinished: null,
      exitPromise: null,
      restoredPromise: null,
      startedResolve: null,
      startedReject: null,
    };
    run.started = new Promise((resolve, reject) => {
      run.startedResolve = resolve;
      run.startedReject = reject;
    });
    this.#run = run;
    this.#startRun(run, normalized).catch(() => { /* 启动段失败已走 failRun；余下只进状态 */ });
    await run.started;
    return { status: 'playing', emotion: normalized.emotion, gesture: normalized.gesture, seconds: normalized.seconds, strength: normalized.strength };
  }

  async #startRun(run, normalized) {
    const gestureSpec = GESTURES[run.gesture];
    try {
      if (gestureSpec.kind === 'motionPair') {
        const enter = this.#resolveMotion(gestureSpec.enter);
        const exit = this.#resolveMotion(gestureSpec.exit);
        const manager = this.#model.internalModel.motionManager;
        const motions = await Promise.all([manager.loadMotion(enter.group, enter.index), manager.loadMotion(exit.group, exit.index)]);
        if (run.abandoned) return;
        if (!motions[0] || !motions[1]) throw new Error('手部动作资源未完整加载，未执行入场');
      }
      await this.#applyEmotion(run, EMOTIONS[run.emotion], normalized.seconds, normalized.strength);
      if (run.abandoned) return;
      if (gestureSpec.kind === 'motionPair') {
        const enter = this.#resolveMotion(gestureSpec.enter);
        this.#setCurrent(run, 'entering');
        const core = this.#model.internalModel.coreModel;
        run.handBaseline = gestureSpec.selectors.map(id => {
          const index = this.#paramIndexById.get(id);
          return { index, value: core.getParameterValueByIndex(index) };
        });
        const waiter = this.#makeFinishWaiter(gestureSpec.enterSeconds * 1000 + FINISH_GRACE_MS);
        run.enterFinished = waiter.promise;
        const started = this.#playMotion(enter, { loop: false, resetExpression: false });
        run.enterPromise = started;
        const ok = await started.catch(error => { waiter.cancel(); throw error; });
        if (run.abandoned) return;
        if (!ok) {
          waiter.cancel();
          throw new Error(`动作启动失败：${gestureSpec.enter}`);
        }
      } else if (gestureSpec.kind === 'channel') {
        this.#startChannel(gestureSpec, normalized.seconds, normalized.strength);
      }
      run.startConfirmed = true;
      run.startedResolve();
    } catch (error) {
      this.#failRun(run, error);
      run.startedReject(error);
      return;
    }

    try {
      if (run.enterFinished) {
        const finished = await run.enterFinished;
        if (run.abandoned) return;
        if (!finished) throw new Error('入场动作结束超时');
      }
      this.#setCurrent(run, 'holding');
      const holdMs = gestureSpec.kind === 'motionPair'
        ? Math.max(0, (normalized.seconds - gestureSpec.enterSeconds - gestureSpec.exitSeconds) * 1000)
        : normalized.seconds * 1000;
      await this.#delay(holdMs, run);
      if (run.abandoned) return;
      if (gestureSpec.kind === 'motionPair') {
        const result = await this.#playExit(run, gestureSpec);
        if (run.abandoned) return;
        if (!result.ok) throw new Error(result.error);
      }
      this.#completeRun(run);
    } catch (error) {
      this.#failRun(run, error);
    }
  }

  /* 表情先落位（清旧 → 置新），惊讶则启动参数通道；失败原样抛出。 */
  async #applyEmotion(run, spec, seconds, strength) {
    if (spec.kind === 'clear') {
      this.#clearFeedback();
      this.#clearExpressions();
      return;
    }
    this.#clearFeedback();
    this.#clearExpressions();
    if (spec.kind === 'expression') {
      const manager = this.#expressionManager();
      if (!manager) throw new Error(`表情启动失败：${spec.expression}（缺少表情管理器）`);
      const ok = await manager.setExpression(spec.expression);
      if (!ok) throw new Error(`表情启动失败：${spec.expression}`);
      return;
    }
    // kind === 'parameters'：惊讶——三条原生参数通道，窗口与反应等长
    const now = performance.now();
    for (const p of spec.parameters) {
      const index = this.#paramIndexById.get(p.id);
      if (index === undefined) throw new Error(`参数不支持：${p.id}`);
      const target = Math.min(p.max, Math.max(p.min, p.base + p.gain * strength));
      this.#channels.push({ mode: 'blend', index, target, t0: now, windowMs: seconds * 1000, contribution: 0 });
    }
  }

  #playMotion(loc, options) {
    try {
      return Promise.resolve(this.#model.motion(loc.group, loc.index, PRIORITY_FORCE, options));
    } catch (error) {
      return Promise.resolve(false);
    }
  }

  async #playExit(run, gestureSpec) {
    if (!run.exitPromise) {
      run.exitPromise = (async () => {
        if (this.#run === run) this.#setCurrent(run, 'returning');
        const loc = this.#resolveMotion(gestureSpec.exit);
        // 先注册 motionFinish 监听再启动：本模型手部动作无音频，options.onFinish 不会触发
        //（该回调只挂在 SoundManager.play 音频路径上）；启动失败立即撤销监听。
        const waiter = this.#makeFinishWaiter(gestureSpec.exitSeconds * 1000 + FINISH_GRACE_MS);
        // 显式 loop:false：收尾动作播完自然结束；元数据 Loop:true 若生效会循环重放"放手下落"曲线
        const ok = await this.#playMotion(loc, { loop: false, resetExpression: false }).catch(error => { waiter.cancel(); throw error; });
        if (!ok) {
          waiter.cancel();
          return { ok: false, error: `动作启动失败：${gestureSpec.exit}` };
        }
        const finished = await waiter.promise;
        if (!finished) return { ok: false, error: '动作收尾超时，已停止播放' };
        return { ok: true };
      })();
    }
    return run.exitPromise;
  }

  /* 等待真实的自然结束（motionManager 的 motionFinish 事件），不按"时长到了"谎报完成；
   * 看门狗只停止播放并上报失败；姿势恢复由场景错误清理负责。 */
  #makeFinishWaiter(timeoutMs) {
    const manager = this.#model?.internalModel?.motionManager;
    if (!manager || typeof manager.on !== 'function' || typeof manager.off !== 'function') {
      return { promise: Promise.resolve(false), cancel() {} };
    }
    let done = false;
    let settleFn;
    const promise = new Promise((resolve) => { settleFn = resolve; });
    const on = () => finish(true);
    const cleanup = () => {
      manager.off('motionFinish', on);
      clearTimeout(timer);
      this.#lifecycle.delete(cleanup);
    };
    const finish = (value) => {
      if (done) return;
      done = true;
      cleanup();
      settleFn(value);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { manager.stopAllMotions(); } catch { /* 强制复位尽力而为 */ }
      cleanup();
      settleFn(false);
    }, timeoutMs);
    manager.on('motionFinish', on);
    this.#lifecycle.add(cleanup);
    return { promise, cancel() { finish(false); } };
  }

  #delay(ms, run) {
    return new Promise((resolve) => {
      if (ms <= 0 || run.abandoned) { resolve(); return; }
      const timer = setTimeout(() => {
        run.timers.delete(timer);
        resolve();
      }, ms);
      run.timers.set(timer, resolve);
    });
  }

  #clearTimers(run) {
    for (const [timer, resolve] of run.timers) { clearTimeout(timer); resolve(); }
    run.timers.clear();
  }

  #setCurrent(run, phase) {
    run.phase = phase;
    this.#current = { emotion: run.emotion, gesture: run.gesture, phase };
    this.#emit();
  }

  #completeRun(run) {
    if (this.#run !== run || run.abandoned) return;
    run.abandoned = true;
    this.#clearTimers(run);
    this.#clearExpressions(); // 原生淡出，不残留旧表情
    this.#releaseChannels();
    if (this.#run === run) this.#run = null;
    this.#current = null;
    this.#emit();
  }

  #failRun(run, error) {
    if (this.#run !== run || run.abandoned) return;
    run.abandoned = true;
    this.#clearTimers(run);
    this.#error = error && error.message ? error.message : String(error);
    this.#restoreHandBaseline(run);
    this.#clearExpressions();
    this.#releaseChannels();
    if (this.#run === run) this.#run = null;
    this.#current = null;
    this.#emit();
  }

  #restoreHandBaseline(run) {
    if (!run.handBaseline.length || this.#destroyed) return;
    const internal = this.#model.internalModel;
    internal.motionManager.stopAllMotions();
    for (const { index, value } of run.handBaseline) internal.coreModel.setParameterValueByIndex(index, value);
    // 异步清理发生在帧外；只修改已捕获的手势选择器，再保存当前基线。
    internal.coreModel.saveParameters();
  }

  /* 让上一个序列安全收场：入场未决则等它落地，举手未放则补播收尾动作并等真实结束。 */
  async #settlePrevious() {
    const prev = this.#run;
    if (!prev) return;
    if (!prev.restoredPromise) prev.restoredPromise = this.#restoreRun(prev);
    await prev.restoredPromise;
  }

  async #restoreRun(prev) {
    prev.abandoned = true;
    if (!prev.startConfirmed) prev.startedReject(new Error('动作启动已取消'));
    this.#clearFeedback();
    this.#clearExpressions();
    this.#releaseChannels();
    this.#clearTimers(prev);
    try {
      if (prev.exitPromise) {
        const result = await prev.exitPromise;
        if (!result.ok) this.#error = result.error;
      } else if (prev.enterPromise) {
        const started = await prev.enterPromise;
        if (started) {
          const entered = await prev.enterFinished;
          if (!entered) throw new Error('入场动作已停止，正在恢复手势');
          const result = await this.#playExit(prev, GESTURES[prev.gesture]);
          if (!result.ok) this.#error = result.error;
        }
      }
    } catch (error) {
      this.#error = error && error.message ? error.message : String(error);
    }
    if (this.#error) this.#restoreHandBaseline(prev);
    this.#clearExpressions();
    this.#releaseChannels();
    if (this.#run === prev) {
      this.#run = null;
      this.#current = null;
      this.#emit();
    }
  }

  /* ---------- 停止与销毁 ---------- */
  async stop() {
    if (this.#destroyed) throw new Error('控制器已销毁，无法停止');
    const mine = ++this.#token;
    this.#clearFeedback();
    await this.#settlePrevious();
    if (mine !== this.#token) return { status: 'superseded' };
    this.#releaseChannels();
    this.#clearExpressions();
    this.#run = null;
    this.#current = null;
    this.#emit();
    return { status: 'stopped' };
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#token++;
    const internal = this.#model?.internalModel;
    if (internal && this.#originalUpdateNatural) {
      try { internal.updateNaturalMovements = this.#originalUpdateNatural; } catch { /* 模型可能已释放 */ }
      this.#originalUpdateNatural = null;
    }
    for (const cleanup of [...this.#lifecycle]) {
      try { cleanup(); } catch { /* 清理尽力而为 */ }
    }
    this.#lifecycle.clear();
    this.#clearFeedback();
    this.#channels = [];
    if (this.#run) {
      this.#run.abandoned = true;
      if (!this.#run.startConfirmed) this.#run.startedReject(new Error('模型已卸载，动作启动已取消'));
      this.#clearTimers(this.#run);
    }
    this.#run = null;
    this.#current = null;
    this.#error = '控制器已销毁';
    this.#caps = { ready: false, emotions: [], gestures: [] };
    this.#emit();
  }

  /* ---------- 状态 ---------- */
  snapshot() {
    const snap = {
      ready: this.#caps.ready,
      emotions: [...this.#caps.emotions],
      gestures: [...this.#caps.gestures],
      current: this.#current ? { ...this.#current } : null,
    };
    if (this.#error) snap.error = this.#error;
    return snap;
  }

  #emit() {
    if (!this.#onState) return;
    try {
      this.#onState(this.snapshot());
    } catch (error) {
      console.warn('[大肥鱼] 反应状态回调失败：', error && error.message);
    }
  }
}
