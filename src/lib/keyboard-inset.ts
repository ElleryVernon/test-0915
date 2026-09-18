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
  scale?: number;
  focused?: boolean;
  referenceHeight?: number;
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
  if (Math.abs((sample.scale ?? 1) - 1) > 0.01) {
    return { inset: 0, height: Math.max(0, Math.round(sample.layoutHeight)), top: 0, open: false };
  }
  const height = Math.max(0, Math.round(sample.height));
  const top = Math.max(0, Math.round(sample.offsetTop));
  const reference = Math.max(sample.layoutHeight, sample.referenceHeight ?? sample.layoutHeight);
  const inset = Math.max(0, Math.round(sample.layoutHeight - sample.height - sample.offsetTop));
  return {
    inset,
    height,
    top,
    open: (sample.focused ?? true) && reference - sample.height >= KEYBOARD_THRESHOLD,
  };
}
type Root = {
  style: {
    setProperty(name: string, value: string): void;
    getPropertyValue?(name: string): string;
  };
  dataset: DOMStringMap;
  clientHeight?: number;
};
export function applyKeyboardInset(root: Root, value: KeyboardInset) {
  const set = (name: string, next: string) => {
    if (root.style.getPropertyValue?.(name) === next) return;
    root.style.setProperty(name, next);
  };
  set('--keyboard-inset', `${value.open ? value.inset : 0}px`);
  set('--vv-height', `${value.height}px`);
  set('--vv-top', `${value.top}px`);
  if (value.open) root.dataset.keyboard = 'open';
  else delete root.dataset.keyboard;
}
type ViewportLike = {
  height: number;
  offsetTop: number;
  scale?: number;
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void;
};
type Rect = { top: number; bottom: number };
/** Room kept between a revealed field and the edge of its scroll container. */
export const REVEAL_MARGIN = 24;
/** How far a scroll container must move so the target sits inside it with the margin; 0 if it already does. */
export function revealDelta(container: Rect, target: Rect, margin = REVEAL_MARGIN): number {
  const top = container.top + margin;
  const bottom = container.bottom - margin;
  if (bottom <= top) return 0;
  if (target.bottom - target.top > bottom - top) {
    if (target.top <= top && target.bottom >= bottom) return 0;
    return Math.round(target.top > top ? target.top - top : target.bottom - bottom);
  }
  if (target.bottom > bottom) return Math.round(target.bottom - bottom);
  if (target.top < top) return Math.round(target.top - top);
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
  addEventListener?(type: string, listener: () => void, options?: unknown): void;
  removeEventListener?(type: string, listener: () => void): void;
};
type WindowLike = {
  innerHeight: number;
  innerWidth?: number;
  visualViewport?: ViewportLike | null;
  document: DocumentLike;
  getComputedStyle?(el: ElementLike): { overflowY: string };
  requestAnimationFrame?(fn: () => void): unknown;
  cancelAnimationFrame?(id: unknown): void;
  addEventListener?(type: string, listener: () => void, options?: unknown): void;
  removeEventListener?(type: string, listener: () => void): void;
};
const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password']);
export function isTextField(el: ElementLike | null | undefined): el is ElementLike {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) return false;
  if (el.getAttribute('disabled') !== null || el.getAttribute('readonly') !== null) return false;
  if ((el.getAttribute('inputmode') ?? '').toLowerCase() === 'none') return false;
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
  const bounds = container.getBoundingClientRect();
  const viewport = win.visualViewport;
  const band =
    viewport && Math.abs((viewport.scale ?? 1) - 1) <= 0.01
      ? {
          top: Math.max(bounds.top, viewport.offsetTop),
          bottom: Math.min(bounds.bottom, viewport.offsetTop + viewport.height),
        }
      : bounds;
  const delta = revealDelta(band, active.getBoundingClientRect());
  if (delta) container.scrollTop += delta;
  return delta;
}
/** Subscribes the document root to the visual viewport; returns the unsubscribe. */
export function installKeyboardInset(win: WindowLike): () => void {
  const viewport = win.visualViewport;
  const root = win.document.documentElement;
  const doc = win.document;
  const layoutHeight = () => root.clientHeight || win.innerHeight;
  let baseline = layoutHeight();
  let lastWidth = win.innerWidth ?? 0;
  let wasOpen = false;
  let userScrolling = false;
  let focusedField: ElementLike | null = null;
  let pendingField: ElementLike | null = null;
  let revealedHeight: number | null = null;
  let frame: unknown = null;
  let disposed = false;
  const measure = () =>
    keyboardInset({
      layoutHeight: layoutHeight(),
      height: viewport?.height ?? layoutHeight(),
      offsetTop: viewport?.offsetTop ?? 0,
      scale: viewport?.scale ?? 1,
      focused: isTextField(doc.activeElement) || wasOpen,
      referenceHeight: baseline,
    });
  const cancelReveal = () => {
    if (frame !== null) {
      win.cancelAnimationFrame?.(frame);
      frame = null;
    }
    pendingField = null;
  };
  const settle = (open: boolean) => {
    if (open && !wasOpen) userScrolling = false;
    if (!open && wasOpen) {
      cancelReveal();
      revealedHeight = null;
    }
    wasOpen = open;
    if (!open)
      baseline = isTextField(doc.activeElement)
        ? Math.max(baseline, layoutHeight())
        : layoutHeight();
  };
  const update = () => {
    const value = measure();
    applyKeyboardInset(root, value);
    settle(value.open);
  };
  const runReveal = () => {
    frame = null;
    const field = pendingField;
    pendingField = null;
    if (disposed || userScrolling || !wasOpen) return;
    if (!field || doc.activeElement !== field || !isTextField(field)) return;
    revealFocusedField(win);
    revealedHeight = viewport?.height ?? layoutHeight();
  };
  const queueReveal = () => {
    pendingField = doc.activeElement ?? null;
    if (frame !== null) return;
    if (win.requestAnimationFrame) frame = win.requestAnimationFrame(runReveal);
    else runReveal();
  };
  // A resize is the keyboard (or its height) changing: let the shrunken layout settle, then reveal.
  const resize = () => {
    const width = win.innerWidth ?? 0;
    if (
      width &&
      Math.abs(width - lastWidth) > 80 &&
      Math.abs((viewport?.scale ?? 1) - 1) <= 0.01
    ) {
      lastWidth = width;
      baseline = layoutHeight();
    }
    const value = measure();
    applyKeyboardInset(root, value);
    settle(value.open);
    const visible = viewport?.height ?? layoutHeight();
    if (value.open && !userScrolling && (revealedHeight === null || visible < revealedHeight - 32))
      queueReveal();
  };
  const focusIn = () => {
    const active = doc.activeElement;
    if (isTextField(active) && active !== focusedField) {
      focusedField = active;
      userScrolling = false;
    }
    const value = measure();
    applyKeyboardInset(root, value);
    settle(value.open);
    if (value.open) queueReveal();
  };
  const focusOut = () => {
    focusedField = null;
    cancelReveal();
  };
  const gesture = () => {
    userScrolling = true;
    cancelReveal();
  };
  update();
  viewport?.addEventListener('resize', resize);
  viewport?.addEventListener('scroll', update);
  win.addEventListener?.('resize', resize);
  doc.addEventListener?.('focusin', focusIn);
  doc.addEventListener?.('focusout', focusOut);
  doc.addEventListener?.('touchmove', gesture, { passive: true });
  doc.addEventListener?.('wheel', gesture, { passive: true });
  if (wasOpen && isTextField(doc.activeElement)) queueReveal();
  return () => {
    disposed = true;
    cancelReveal();
    viewport?.removeEventListener('resize', resize);
    viewport?.removeEventListener('scroll', update);
    win.removeEventListener?.('resize', resize);
    doc.removeEventListener?.('focusin', focusIn);
    doc.removeEventListener?.('focusout', focusOut);
    doc.removeEventListener?.('touchmove', gesture);
    doc.removeEventListener?.('wheel', gesture);
    applyKeyboardInset(root, { inset: 0, height: layoutHeight(), top: 0, open: false });
  };
}
