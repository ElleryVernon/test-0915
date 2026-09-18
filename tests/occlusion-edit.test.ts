import test from 'node:test';
import assert from 'node:assert/strict';
import { editOcclusion, eraseMasks, initialOcclusion, paintMasks } from '../src/lib/occlusion-edit';

const a = { x: 10, y: 10, width: 10, height: 10 };
const b = { x: 70, y: 70, width: 10, height: 10 };
test('a full eraser gesture is one undo; redo restores erasure without touching other boxes', () => {
  let state = initialOcclusion([a, b]);
  state = editOcclusion(state, { type: 'begin' });
  state = editOcclusion(state, {
    type: 'preview',
    masks: eraseMasks(state.masks, { x: 0, y: 15 }, { x: 50, y: 15 }),
  });
  state = editOcclusion(state, { type: 'commit' });
  assert.deepEqual(state.masks, [b]);
  assert.equal(state.past.length, 1);
  state = editOcclusion(state, { type: 'undo' });
  assert.deepEqual(state.masks, [a, b]);
  assert.deepEqual(editOcclusion(state, { type: 'redo' }).masks, [b]);
});
test('cancel interrupted move or stroke restores image; no-op does not consume undo history', () => {
  let state = editOcclusion(initialOcclusion([a]), { type: 'begin' });
  state = editOcclusion(state, { type: 'preview', masks: [{ ...a, x: 30 }] });
  state = editOcclusion(state, { type: 'cancel' });
  assert.deepEqual(state, initialOcclusion([a]));
  state = editOcclusion(editOcclusion(state, { type: 'begin' }), { type: 'commit' });
  assert.equal(state.past.length, 0);
});
test('new edit clears redo; auto detection replacement and clear all are reversible', () => {
  let state = editOcclusion(initialOcclusion([a]), { type: 'replace', masks: [b] });
  state = editOcclusion(state, { type: 'undo' });
  state = editOcclusion(state, { type: 'replace', masks: [] });
  assert.equal(state.future.length, 0);
  assert.deepEqual(editOcclusion(state, { type: 'undo' }).masks, [a]);
  assert.deepEqual(editOcclusion(state, { type: 'reset', masks: [] }), initialOcclusion());
});
test('eraser does not erase along extended line or near misses; stationary tap erases touched box', () => {
  assert.deepEqual(eraseMasks([a, b], { x: 0, y: 0 }, { x: 5, y: 5 }), [a, b]);
  assert.deepEqual(eraseMasks([a, b], { x: 0, y: 30 }, { x: 50, y: 30 }), [a, b]);
  assert.deepEqual(eraseMasks([a, b], { x: 15, y: 15 }, { x: 15, y: 15 }), [b]);
});
test('paint interpolates fast strokes, stays within bounds and honours storage capacity', () => {
  const masks = paintMasks([], { x: 0, y: 0 }, { x: 100, y: 100 });
  assert.ok(masks.length > 50);
  assert.ok(
    masks.every((m) => m.x >= 0 && m.y >= 0 && m.x + m.width <= 100 && m.y + m.height <= 100),
  );
  assert.equal(
    paintMasks(
      Array.from({ length: 99 }, () => a),
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ).length,
    100,
  );
});
test('history is bounded and input values are never mutated', () => {
  const source = [a];
  let state = initialOcclusion(source);
  for (let x = 0; x < 70; x++)
    state = editOcclusion(state, { type: 'replace', masks: [{ ...a, x }] });
  assert.equal(state.past.length, 50);
  assert.deepEqual(source, [a]);
});
