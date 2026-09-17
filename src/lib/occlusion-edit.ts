import type { Mask } from './contracts';

export type MaskPoint = { x: number; y: number };
export type OcclusionHistory = {
  past: Mask[][];
  masks: Mask[];
  future: Mask[][];
  gesture: Mask[] | null;
};
export type OcclusionEdit =
  | { type: 'begin' | 'commit' | 'cancel' | 'undo' | 'redo' }
  | { type: 'preview' | 'replace' | 'reset'; masks: Mask[] };
const copy = (masks: Mask[]) => masks.map((mask) => ({ ...mask }));
const equal = (a: Mask[], b: Mask[]) =>
  a.length === b.length &&
  a.every(
    (mask, i) =>
      mask.x === b[i].x &&
      mask.y === b[i].y &&
      mask.width === b[i].width &&
      mask.height === b[i].height,
  );

export function initialOcclusion(masks: Mask[] = []): OcclusionHistory {
  return { past: [], masks: copy(masks), future: [], gesture: null };
}

/** One pointer stroke is one edit, including move/resize, erase and auto detection. */
export function editOcclusion(state: OcclusionHistory, action: OcclusionEdit): OcclusionHistory {
  if (action.type === 'reset') return initialOcclusion(action.masks);
  if (action.type === 'begin')
    return state.gesture ? state : { ...state, gesture: copy(state.masks) };
  if (action.type === 'preview') return { ...state, masks: copy(action.masks).slice(0, 100) };
  if (action.type === 'cancel')
    return state.gesture ? { ...state, masks: state.gesture, gesture: null } : state;
  if (action.type === 'undo') {
    if (state.gesture) return { ...state, masks: state.gesture, gesture: null };
    const masks = state.past.at(-1);
    return masks
      ? {
          past: state.past.slice(0, -1),
          masks,
          future: [state.masks, ...state.future].slice(0, 50),
          gesture: null,
        }
      : state;
  }
  if (action.type === 'redo') {
    const masks = state.future[0];
    return masks && !state.gesture
      ? {
          past: [...state.past, state.masks].slice(-50),
          masks,
          future: state.future.slice(1),
          gesture: null,
        }
      : state;
  }
  const before = state.gesture ?? state.masks;
  const masks = action.type === 'replace' ? copy(action.masks).slice(0, 100) : state.masks;
  if (equal(before, masks)) return { ...state, masks, gesture: null };
  return { past: [...state.past, before].slice(-50), masks, future: [], gesture: null };
}

/** Object eraser: delete any mask touched by the swept stroke, even with sparse pointer events. */
export function eraseMasks(masks: Mask[], from: MaskPoint, to: MaskPoint, radius = 1): Mask[] {
  return masks.filter((mask) => {
    let entry = 0;
    let exit = 1;
    for (const axis of ['x', 'y'] as const) {
      const delta = to[axis] - from[axis];
      const min = mask[axis] - radius;
      const max = mask[axis] + (axis === 'x' ? mask.width : mask.height) + radius;
      if (delta === 0) {
        if (from[axis] < min || from[axis] > max) return true;
      } else {
        const first = (min - from[axis]) / delta;
        const last = (max - from[axis]) / delta;
        entry = Math.max(entry, Math.min(first, last));
        exit = Math.min(exit, Math.max(first, last));
        if (entry > exit) return true;
      }
    }
    return false;
  });
}

/** Fill gaps between touch events without allowing any paint beyond the image bounds. */
export function paintMasks(masks: Mask[], from: MaskPoint, to: MaskPoint): Mask[] {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 1.5));
  const result = [...masks];
  for (let step = 1; step <= steps && result.length < 100; step++) {
    const x = Math.max(0, Math.min(100, from.x + ((to.x - from.x) * step) / steps) - 2);
    const y = Math.max(0, Math.min(100, from.y + ((to.y - from.y) * step) / steps) - 1.5);
    result.push({ x, y, width: Math.min(4, 100 - x), height: Math.min(3, 100 - y) });
  }
  return result;
}
