const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaction } = require('../src/ui/reaction-catalog.mjs');

const capabilities = { ready: true, emotions: ['neutral', 'happy', 'shy'], gestures: ['none', 'nod'] };

test('API reactions reject unsupported model controls and cannot select clothing or arbitrary parameters', () => {
  assert.throws(() => normalizeReaction({ emotion: '脱鞋', gesture: 'none', seconds: 4, strength: 0.7 }, capabilities), /表情|emotion|不支持/);
  assert.throws(() => normalizeReaction({ emotion: 'happy', gesture: 'wave', seconds: 4, strength: 0.7 }, capabilities), /动作|gesture|不支持/);
  assert.throws(() => normalizeReaction({ emotion: 'happy', gesture: 'nod', seconds: 4, strength: 0.7, parameters: { ParamBodyAngleX: 1000 } }, capabilities), /参数|字段|parameters/);
});

test('reaction limits reject out-of-range duration or strength instead of running an unbounded animation', () => {
  assert.throws(() => normalizeReaction({ emotion: 'happy', gesture: 'nod', seconds: 600, strength: 0.7 }, capabilities), /时长|seconds|范围/);
  assert.throws(() => normalizeReaction({ emotion: 'happy', gesture: 'nod', seconds: 4, strength: 10 }, capabilities), /强度|幅度|strength|范围/);
  assert.throws(() => normalizeReaction({ emotion: 'happy', gesture: 'nod', seconds: 4, strength: 0.7 }, { ...capabilities, ready: false }), /加载|就绪|ready/);
});
