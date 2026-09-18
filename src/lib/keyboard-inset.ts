// The on-screen keyboard does not change the layout viewport on iOS: `100dvh` stays, `position:
// fixed` stays glued to the layout viewport's bottom edge, and the browser shrinks *and pans* the
// visual viewport to reveal the focused field (window.innerHeight follows the pan, so it is not
// the layout height). The app reads the visual viewport and publishes it as CSS custom properties,
// so fixed bars lift to the visible bottom edge, sheets shrink to the visible height, headers
// follow the visible top edge, and the tab bar steps aside while typing.
//
// Measured on iPhone 17 Pro / iOS 26 Safari with the keyboard up: layout 714, visible 377,
// offsetTop 290.66, innerHeight 423.
export type ViewportSample = {
  /** document.documentElement.clientHeight: the layout viewport height fixed elements use. */
  layoutHeight: number;
  /** visualViewport.height, or the layout height when the API is missing. */
  height: number;
  /** visualViewport.offsetTop: how far the visible area is panned down inside the layout viewport. */
  offsetTop: number;
};
export type KeyboardInset = {
  /** Distance from the layout viewport's bottom edge to the visible bottom edge, in CSS px. */
  inset: number;
  /** Visible height and top offset, rounded to whole px for stable layout. */
  height: number;
  top: number;
  /** True once the visible area lost a keyboard's worth of height, not just browser chrome. */
  open: boolean;
};
/** Browser chrome animations hide up to ~100px of height; a keyboard hides far more. */
export const KEYBOARD_THRESHOLD = 100;
export function keyboardInset(sample: ViewportSample): KeyboardInset {
  const height = Math.max(0, Math.round(sample.height));
  const top = Math.max(0, Math.round(sample.offsetTop));
  const hidden = sample.layoutHeight - sample.height;
  const inset = Math.max(0, Math.round(sample.layoutHeight - sample.height - sample.offsetTop));
  return { inset, height, top, open: hidden >= KEYBOARD_THRESHOLD };
}
type Root = {
  style: { setProperty(name: string, value: string): void };
  dataset: DOMStringMap;
  clientHeight?: number;
};
export function applyKeyboardInset(root: Root, value: KeyboardInset) {
  root.style.setProperty('--keyboard-inset', `${value.open ? value.inset : 0}px`);
  root.style.setProperty('--vv-height', `${value.height}px`);
  root.style.setProperty('--vv-top', `${value.top}px`);
  if (value.open) root.dataset.keyboard = 'open';
  else delete root.dataset.keyboard;
}
type ViewportLike = {
  height: number;
  offsetTop: number;
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void;
};
type Rect = { top: number; bottom: number };
/** Room kept between a revealed field and the edge of its scroll container. */
export const REVEAL_MARGIN = 24;
/** How far a scroll container must move so the target sits inside it with the margin; 0 if it already does. */
export function revealDelta(container: Rect, target: Rect, margin = REVEAL_MARGIN): number {
  const tooLow = target.bottom - (container.bottom - margin);
  if (tooLow > 0) return Math.round(tooLow);
  const tooHigh = target.top - (container.top + margin);
  if (tooHigh < 0) return Math.round(tooHigh);
  return 0;
}
type ElementLike = {
  tagName: string;
  parentElement: ElementLike | null;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): Rect;
  isContentEditable?: boolean;
};
type DocumentLike = {
  documentElement: Root;
  body?: ElementLike | null;
  activeElement?: ElementLike | null;
};
type WindowLike = {
  innerHeight: number;
  visualViewport?: ViewportLike | null;
  document: DocumentLike;
  getComputedStyle?(el: ElementLike): { overflowY: string };
  requestAnimationFrame?(fn: () => void): unknown;
};
const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password']);
export function isTextField(el: ElementLike | null | undefined): el is ElementLike {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') return TEXT_TYPES.has((el.getAttribute('type') ?? 'text').toLowerCase());
  return !!el.isContentEditable;
}
/** The nearest ancestor that scrolls (overflow auto/scroll with content to spare); never the document. */
export function scrollParent(el: ElementLike, win: WindowLike): ElementLike | null {
  const body = win.document.body ?? null;
  for (let node = el.parentElement; node && node !== body; node = node.parentElement) {
    const style = win.getComputedStyle?.(node);
    if (!style) return null;
    const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
    if (scrolls && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}
/**
 * Scrolls the focused text field into view inside its own scroll container (a sheet body, a
 * panel). iOS reveals fields in the document by panning the visual viewport, but it does not
 * scroll an element container whose fold moved because the container shrank to the keyboard.
 */
export function revealFocusedField(win: WindowLike): number {
  const active = win.document.activeElement;
  if (!isTextField(active)) return 0;
  const container = scrollParent(active, win);
  if (!container) return 0;
  const delta = revealDelta(container.getBoundingClientRect(), active.getBoundingClientRect());
  if (delta) container.scrollTop += delta;
  return delta;
}
/** Subscribes the document root to the visual viewport; returns the unsubscribe. */
export function installKeyboardInset(win: WindowLike): () => void {
  const viewport = win.visualViewport;
  const root = win.document.documentElement;
  const layoutHeight = () => root.clientHeight || win.innerHeight;
  const measure = () =>
    keyboardInset({
      layoutHeight: layoutHeight(),
      height: viewport?.height ?? layoutHeight(),
      offsetTop: viewport?.offsetTop ?? 0,
    });
  const update = () => applyKeyboardInset(root, measure());
  // A resize is the keyboard (or its height) changing: let the shrunken layout settle, then reveal.
  const resize = () => {
    const value = measure();
    applyKeyboardInset(root, value);
    if (!value.open) return;
    const after = () => revealFocusedField(win);
    if (win.requestAnimationFrame) win.requestAnimationFrame(after);
    else after();
  };
  update();
  if (!viewport) return () => {};
  viewport.addEventListener('resize', resize);
  viewport.addEventListener('scroll', update);
  return () => {
    viewport.removeEventListener('resize', resize);
    viewport.removeEventListener('scroll', update);
    applyKeyboardInset(root, { inset: 0, height: layoutHeight(), top: 0, open: false });
  };
}
