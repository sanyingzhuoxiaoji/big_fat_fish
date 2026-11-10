/* 大肥鱼共享反应目录：语义表情/动作 → 实际模型资源与支持要求，以及输入归一化。
 *
 * 纯 ESM 数据模块：无顶层 await、无 DOM/Node 依赖；Node 24 / Electron 渲染端均可同步 require。
 * 资源名与 DeepSeek免费公皮/DeepSeek/{Exp3,Animation} 下的真实文件一一对应
 * （Name/File 由 src/main.cjs buildVirtualManifest 生成）。
 *
 * 归一化契约：
 * - 输入只允许 {emotion, gesture, seconds, strength}；缺省默认 neutral/none/4 秒/0.7。
 * - seconds 有效范围 2.5～6（覆盖 wave/point 的入场+保持+收尾，2.5 秒下限对全部动作成立），
 *   strength 有效范围 0.3～1；非有限数值一律拒绝，不做静默回退。
 * - 只接受目录内语义枚举，且必须出现在 capabilities 支持清单里；脱鞋/裙子切换等换装控制、
 *   任意原生参数（如 parameters 字段）全部拒绝并抛出含中文名词的错误。
 */

export const LIMITS = {
  minSeconds: 2.5,
  maxSeconds: 6,
  defaultSeconds: 4,
  minStrength: 0.3,
  maxStrength: 1,
  defaultStrength: 0.7,
};

/* 表情目录：expression 对应 Exp3 文件名（manifest Expressions.Name）；
 * surprised 不用表情文件，直接驱动原生参数（值经 min/max 收敛，setter 仍会按原生范围截断）。 */
export const EMOTIONS = {
  neutral: { label: '平静', kind: 'clear' },
  happy: { label: '开心', kind: 'expression', expression: '＞＜' },
  shy: { label: '害羞', kind: 'expression', expression: '脸红' },
  love: { label: '喜欢', kind: 'expression', expression: '爱心眼' },
  confused: { label: '困惑', kind: 'expression', expression: '圈圈眼' },
  sad: { label: '难过', kind: 'expression', expression: '流泪' },
  embarrassed: { label: '尴尬', kind: 'expression', expression: '流冷汗' },
  smug: { label: '得意', kind: 'expression', expression: '屑屑眼' },
  surprised: {
    label: '惊讶',
    kind: 'parameters',
    parameters: [
      { id: 'ParamEyeLOpen', min: 0, max: 1, base: 0.6, gain: 0.4 },
      { id: 'ParamEyeROpen', min: 0, max: 1, base: 0.6, gain: 0.4 },
      { id: 'ParamMouthOpenY', min: 0, max: 1, base: 0.25, gain: 0.6 },
    ],
  },
};

/* 动作目录：channel 为参数摆动（写入发生在 updateNaturalMovements 之后、物理之前）。
 * 大肥鱼的 physics3.json 以 AngleX/Y/Z 为输入（PhysicsSetting1/2/3：Angle* → ParamAngle*），
 * 作者物理据此驱动 ParamAngle* 与头发——因此优先写物理输入 Angle*，让物理呈现头部与二级摆动，
 * 仅当模型缺失 Angle* 时才回退写已存在的 ParamAngle*（届时物理可能覆盖，为该模型的降级行为）。
 * motionPair 为真实 Animation 动作对，enterSeconds/exitSeconds 是动作 JSON 的实际 Meta.Duration。 */
export const GESTURES = {
  none: { label: '不动', kind: 'none' },
  nod: { label: '点头', kind: 'channel', parameters: ['AngleY', 'ParamAngleY'], amplitude: -22, cycleSeconds: 0.55, shape: 'dip' },
  shake: { label: '摇头', kind: 'channel', parameters: ['AngleX', 'ParamAngleX'], amplitude: 24, cycleSeconds: 0.4, shape: 'swing' },
  tilt: { label: '歪头', kind: 'channel', parameters: ['AngleZ', 'ParamAngleZ'], amplitude: 15, cycleSeconds: 0, shape: 'lean' },
  wave: {
    label: '举手',
    kind: 'motionPair',
    selectors: ['Movement2'],
    enter: '默认手切举手',
    exit: '举手切默认手',
    enterSeconds: 1.133,
    exitSeconds: 1.017,
  },
  point: {
    label: '竖手指',
    kind: 'motionPair',
    selectors: ['Movement1', 'Movement3'],
    enter: '竖手指切出来动画',
    exit: '竖手指切回默认',
    enterSeconds: 1.25,
    exitSeconds: 1.25,
  },
};

const ALLOWED_KEYS = ['emotion', 'gesture', 'seconds', 'strength'];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/* 归一化反应指令；任何不支持/越界/多余字段都以中文错误抛出，绝不静默回退。 */
export function normalizeReaction(input, capabilities) {
  if (!capabilities || typeof capabilities !== 'object' || capabilities.ready !== true) {
    throw new Error('模型尚未就绪（ready 为 false），无法处理反应指令');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('反应输入必须是对象（仅允许 emotion/gesture/seconds/strength 字段）');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.includes(key)) {
      throw new Error(`不支持的字段：${key}（反应只接受 emotion/gesture/seconds/strength，禁止 parameters 等任意参数或换装控制）`);
    }
  }

  const rawEmotion = input.emotion === undefined ? 'neutral' : input.emotion;
  if (typeof rawEmotion !== 'string' || !hasOwn(EMOTIONS, rawEmotion)) {
    throw new Error(`表情不支持：${String(rawEmotion)}（emotion 必须是目录内的语义表情）`);
  }
  if (!Array.isArray(capabilities.emotions) || !capabilities.emotions.includes(rawEmotion)) {
    throw new Error(`表情不支持：${rawEmotion}（当前模型能力清单未包含该表情）`);
  }

  const rawGesture = input.gesture === undefined ? 'none' : input.gesture;
  if (typeof rawGesture !== 'string' || !hasOwn(GESTURES, rawGesture)) {
    throw new Error(`动作不支持：${String(rawGesture)}（gesture 必须是目录内的语义动作）`);
  }
  if (!Array.isArray(capabilities.gestures) || !capabilities.gestures.includes(rawGesture)) {
    throw new Error(`动作不支持：${rawGesture}（当前模型能力清单未包含该动作）`);
  }

  let seconds = LIMITS.defaultSeconds;
  if (input.seconds !== undefined) {
    if (typeof input.seconds !== 'number' || !Number.isFinite(input.seconds)) {
      throw new Error(`时长无效：${String(input.seconds)}（seconds 必须是有限数值）`);
    }
    if (input.seconds < LIMITS.minSeconds || input.seconds > LIMITS.maxSeconds) {
      throw new Error(`时长超出范围：${input.seconds}（seconds 有效范围 ${LIMITS.minSeconds}～${LIMITS.maxSeconds} 秒）`);
    }
    seconds = input.seconds;
  }

  let strength = LIMITS.defaultStrength;
  if (input.strength !== undefined) {
    if (typeof input.strength !== 'number' || !Number.isFinite(input.strength)) {
      throw new Error(`强度无效：${String(input.strength)}（strength 必须是有限数值）`);
    }
    if (input.strength < LIMITS.minStrength || input.strength > LIMITS.maxStrength) {
      throw new Error(`强度超出范围：${input.strength}（strength 有效范围 ${LIMITS.minStrength}～${LIMITS.maxStrength}）`);
    }
    strength = input.strength;
  }

  return { emotion: rawEmotion, gesture: rawGesture, seconds, strength };
}
