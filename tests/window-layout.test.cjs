const { test } = require('node:test');
const assert = require('node:assert/strict');
const { petWindowBounds, BUBBLE_HEIGHT } = require('../src/window-layout.cjs');

test('resizing scales the model region while reserving separate bubble space and retaining the bottom-center anchor', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const original = petWindowBounds({ scale: 1, workArea, x: 300, y: 300 });
  const large = petWindowBounds({ scale: 1.5, workArea, previous: original });
  assert.equal((large.height - BUBBLE_HEIGHT) / (original.height - BUBBLE_HEIGHT), 1.5);
  assert.equal(large.x + large.width / 2, original.x + original.width / 2);
  assert.equal(large.y + large.height, original.y + original.height);
});

test('large model and bubble remain entirely inside a smaller secondary screen work area', () => {
  const workArea = { x: -800, y: 0, width: 800, height: 600 };
  const bounds = petWindowBounds({ scale: 1.5, workArea, x: 500, y: 900 });
  assert.ok(bounds.x >= workArea.x);
  assert.ok(bounds.y >= workArea.y);
  assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
  assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
  assert.ok(bounds.height > BUBBLE_HEIGHT);
});
