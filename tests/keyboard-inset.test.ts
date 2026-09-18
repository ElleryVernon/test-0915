import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYBOARD_THRESHOLD,
  REVEAL_MARGIN,
  applyKeyboardInset,
  installKeyboardInset,
  isTextField,
  keyboardInset,
  revealDelta,
  revealFocusedField,
} from '../src/lib/keyboard-inset';

test('the inset is the strip between the layout bottom and the visible bottom, and only a keyboard-sized shrink counts as open', () => {
  // iPhone Safari, keyboard closed: visual and layout viewports agree.
  assert.deepEqual(keyboardInset({ layoutHeight: 812, height: 812, offsetTop: 0 }), {
    inset: 0,
    height: 812,
    top: 0,
    open: false,
  });
  // Browser chrome sliding in hides a little; that is not a keyboard.
  assert.equal(keyboardInset({ layoutHeight: 812, height: 760, offsetTop: 0 }).open, false);
  assert.equal(KEYBOARD_THRESHOLD, 100);
  // Keyboard up without a pan: the visible area shrank by ~336px, all of it at the bottom.
  assert.deepEqual(keyboardInset({ layoutHeight: 812, height: 476, offsetTop: 0 }), {
    inset: 336,
    height: 476,
    top: 0,
    open: true,
  });
  // iOS panned the visible area down to reveal the field: the bottom edge moves with it.
  assert.deepEqual(keyboardInset({ layoutHeight: 812, height: 476, offsetTop: 120 }), {
    inset: 216,
    height: 476,
    top: 120,
    open: true,
  });
  // Measured on iPhone 17 Pro / iOS 26: the pan leaves only 46px of the layout under the keyboard,
  // yet the keyboard is clearly open (337px of height lost).
  assert.deepEqual(keyboardInset({ layoutHeight: 714, height: 377, offsetTop: 290.65625 }), {
    inset: 46,
    height: 377,
    top: 291,
    open: true,
  });
  // Fractional viewport sizes round to whole px and never go negative.
  assert.deepEqual(keyboardInset({ layoutHeight: 812, height: 812.4, offsetTop: -0.2 }), {
    inset: 0,
    height: 812,
    top: 0,
    open: false,
  });
});

test('the root receives the custom properties and the keyboard flag, and drops them when closed', () => {
  const props: Record<string, string> = {};
  const root = {
    style: { setProperty: (name: string, value: string) => void (props[name] = value) },
    dataset: {} as DOMStringMap,
  };
  applyKeyboardInset(root, { inset: 336, height: 476, top: 0, open: true });
  assert.deepEqual(props, {
    '--keyboard-inset': '336px',
    '--vv-height': '476px',
    '--vv-top': '0px',
  });
  assert.equal(root.dataset.keyboard, 'open');
  applyKeyboardInset(root, { inset: 60, height: 752, top: 0, open: false });
  assert.equal(props['--keyboard-inset'], '0px', 'chrome-sized strips do not lift bars');
  assert.equal(props['--vv-height'], '752px');
  assert.equal('keyboard' in root.dataset, false);
});

test('installing measures the layout viewport from the root, subscribes to visual viewport changes, and restores the root on uninstall', () => {
  const props: Record<string, string> = {};
  const listeners: Record<string, (() => void)[]> = { resize: [], scroll: [] };
  const viewport = {
    height: 714,
    offsetTop: 0,
    addEventListener: (type: 'resize' | 'scroll', fn: () => void) => listeners[type].push(fn),
    removeEventListener: (type: 'resize' | 'scroll', fn: () => void) => {
      listeners[type] = listeners[type].filter((l) => l !== fn);
    },
  };
  const win = {
    // window.innerHeight follows the pan on iOS; the root's clientHeight is the layout height.
    innerHeight: 423,
    visualViewport: viewport,
    document: {
      documentElement: {
        clientHeight: 714,
        style: { setProperty: (name: string, value: string) => void (props[name] = value) },
        dataset: {} as DOMStringMap,
      },
    },
  };
  const stop = installKeyboardInset(win);
  assert.equal(props['--keyboard-inset'], '0px');
  assert.equal(props['--vv-height'], '714px');
  assert.equal(listeners.resize.length, 1);
  viewport.height = 377;
  viewport.offsetTop = 290.65625;
  listeners.resize.forEach((fn) => fn());
  assert.equal(props['--keyboard-inset'], '46px');
  assert.equal(props['--vv-top'], '291px');
  assert.equal(win.document.documentElement.dataset.keyboard, 'open');
  stop();
  assert.equal(listeners.resize.length, 0);
  assert.equal(props['--keyboard-inset'], '0px');
  assert.equal(props['--vv-height'], '714px');
  assert.equal('keyboard' in win.document.documentElement.dataset, false);
  // Without the API (or a measurable root) the window height is the fallback and nothing is subscribed.
  const bare = {
    innerHeight: 800,
    visualViewport: null,
    document: { documentElement: { ...win.document.documentElement, clientHeight: 0 } },
  };
  installKeyboardInset(bare)();
  assert.equal(props['--vv-height'], '800px');
});

test('a field below a scroll container\x27s fold is scrolled up by exactly the overshoot plus the margin', () => {
  assert.equal(REVEAL_MARGIN, 24);
  // Fully visible with room to spare: nothing moves.
  assert.equal(revealDelta({ top: 100, bottom: 400 }, { top: 150, bottom: 200 }), 0);
  // Just below the fold (the sheet shrank to the keyboard): scroll down by overshoot + margin.
  assert.equal(revealDelta({ top: 100, bottom: 400 }, { top: 390, bottom: 440 }), 64);
  // Above the top edge: scroll up (negative) so it sits below the margin.
  assert.equal(revealDelta({ top: 100, bottom: 400 }, { top: 90, bottom: 130 }), -34);
});

test('only text-entry elements are revealed', () => {
  const el = (tagName: string, type?: string, editable = false) => ({
    tagName,
    parentElement: null,
    scrollHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    getAttribute: (name: string) => (name === 'type' ? (type ?? null) : null),
    getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
    isContentEditable: editable,
  });
  assert.equal(isTextField(el('INPUT')), true);
  assert.equal(isTextField(el('INPUT', 'search')), true);
  assert.equal(isTextField(el('TEXTAREA')), true);
  assert.equal(isTextField(el('DIV', undefined, true)), true);
  assert.equal(isTextField(el('INPUT', 'checkbox')), false);
  assert.equal(isTextField(el('BUTTON')), false);
  assert.equal(isTextField(null), false);
});

test('the focused field is revealed inside its nearest scroll container, never the document', () => {
  const body = { tagName: 'BODY', parentElement: null } as never;
  const overflow: Record<string, string> = {};
  const node = (
    name: string,
    parent: unknown,
    rect: { top: number; bottom: number },
    extra = {},
  ) => ({
    tagName: name,
    parentElement: parent as never,
    scrollHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    getAttribute: () => null,
    getBoundingClientRect: () => rect,
    ...extra,
  });
  // sheet (fixed, overflow hidden) > scroll (overflow auto, taller content) > editor > input
  const sheet = node('DIV', body, { top: 0, bottom: 400 });
  const scroll = node(
    'DIV',
    sheet,
    { top: 100, bottom: 300 },
    { scrollHeight: 900, clientHeight: 200 },
  );
  const editor = node('DIV', scroll, { top: 250, bottom: 600 });
  const input = node('INPUT', editor, { top: 290, bottom: 340 });
  overflow['sheet'] = 'hidden';
  const win = {
    innerHeight: 714,
    document: { documentElement: {} as never, body, activeElement: input },
    getComputedStyle: (el: unknown) => ({ overflowY: el === scroll ? 'auto' : 'hidden' }),
  };
  assert.equal(revealFocusedField(win), 64);
  assert.equal(scroll.scrollTop, 64, 'the sheet body scrolled, not the sheet or the page');
  // A field whose only scrolling ancestor is the document is left to the browser.
  const page = node('MAIN', body, { top: 0, bottom: 700 });
  const field = node('INPUT', page, { top: 650, bottom: 700 });
  const win2 = { ...win, document: { ...win.document, activeElement: field } };
  assert.equal(revealFocusedField(win2), 0);
  // Nothing focused, or a button focused: no-op.
  assert.equal(
    revealFocusedField({ ...win, document: { ...win.document, activeElement: null } }),
    0,
  );
});

test('a keyboard-sized resize reveals the focused field after the layout settles; a pan does not', () => {
  const props: Record<string, string> = {};
  const listeners: Record<string, (() => void)[]> = { resize: [], scroll: [] };
  const viewport = {
    height: 714,
    offsetTop: 0,
    addEventListener: (type: 'resize' | 'scroll', fn: () => void) => listeners[type].push(fn),
    removeEventListener: () => {},
  };
  const body = { tagName: 'BODY', parentElement: null } as never;
  const scroll = {
    tagName: 'DIV',
    parentElement: body,
    scrollHeight: 900,
    clientHeight: 200,
    scrollTop: 0,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 100, bottom: 300 }),
  };
  const input = {
    ...scroll,
    tagName: 'INPUT',
    parentElement: scroll,
    getBoundingClientRect: () => ({ top: 320, bottom: 360 }),
  };
  const frames: (() => void)[] = [];
  const win = {
    innerHeight: 714,
    visualViewport: viewport,
    document: {
      documentElement: {
        clientHeight: 714,
        style: { setProperty: (n: string, v: string) => void (props[n] = v) },
        dataset: {} as DOMStringMap,
      },
      body,
      activeElement: input,
    },
    getComputedStyle: (el: unknown) => ({ overflowY: el === scroll ? 'auto' : 'visible' }),
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
  };
  installKeyboardInset(win);
  viewport.height = 377;
  listeners.resize.forEach((fn) => fn());
  assert.equal(props['--keyboard-inset'], '337px');
  assert.equal(frames.length, 1, 'reveal is deferred to the next frame');
  frames.shift()!();
  assert.equal(scroll.scrollTop, 84);
  // The pan that follows only re-measures; it does not scroll the container again.
  viewport.offsetTop = 290;
  listeners.scroll.forEach((fn) => fn());
  assert.equal(props['--keyboard-inset'], '47px');
  assert.equal(frames.length, 0);
  // Chrome-sized resizes never reveal.
  viewport.height = 714;
  viewport.offsetTop = 0;
  listeners.resize.forEach((fn) => fn());
  assert.equal(frames.length, 0);
});
