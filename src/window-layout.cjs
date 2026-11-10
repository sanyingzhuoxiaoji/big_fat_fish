'use strict';

const BUBBLE_HEIGHT = 128;
const MODEL_WIDTH = 380;
const MODEL_HEIGHT = 500;

function petWindowBounds({ scale, workArea, previous, x, y }) {
  const fittedScale = Math.min(scale, workArea.width / MODEL_WIDTH, (workArea.height - BUBBLE_HEIGHT) / MODEL_HEIGHT);
  const width = Math.min(workArea.width, Math.max(280, Math.round(MODEL_WIDTH * fittedScale)));
  const height = Math.round(MODEL_HEIGHT * fittedScale) + BUBBLE_HEIGHT;
  if (previous) {
    x = previous.x + (previous.width - width) / 2;
    y = previous.y + previous.height - height;
  }
  x ??= workArea.x + workArea.width - width - 24;
  y ??= workArea.y + workArea.height - height - 24;
  return {
    x: Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height))),
    width,
    height,
  };
}

module.exports = { petWindowBounds, BUBBLE_HEIGHT };
