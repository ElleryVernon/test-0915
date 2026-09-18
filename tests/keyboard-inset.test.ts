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
  const input = {
    tagName: 'INPUT',
    parentElement: null,
    scrollHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
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
      activeElement: input,
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

function harness({ layout = 812, vvHeight = 812, focused = true } = {}) {
  const props: Record<string, string> = {};
  const vvListeners: Record<string, (() => void)[]> = { resize: [], scroll: [] };
  const docListeners: Record<string, (() => void)[]> = {};
  const winListeners: Record<string, (() => void)[]> = {};
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const viewport = {
    height: vvHeight,
    offsetTop: 0,
    scale: 1,
    addEventListener: (type: 'resize' | 'scroll', fn: () => void) => vvListeners[type].push(fn),
    removeEventListener: (type: 'resize' | 'scroll', fn: () => void) => {
      vvListeners[type] = vvListeners[type].filter((l) => l !== fn);
    },
  };
  const body = { tagName: 'BODY', parentElement: null } as never;
  const node = (
    tagName: string,
    parent: unknown,
    rect: { top: number; bottom: number },
    extra = {},
  ) => ({
    tagName,
    parentElement: parent as never,
    scrollHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    getAttribute: () => null,
    getBoundingClientRect: () => rect,
    ...extra,
  });
  const scroll = node(
    'DIV',
    body,
    { top: 100, bottom: 300 },
    { scrollHeight: 1200, clientHeight: 200 },
  );
  const input = node('INPUT', scroll, { top: 320, bottom: 360 });
  const root = {
    clientHeight: layout,
    style: {
      setProperty: (name: string, value: string) => void (props[name] = value),
      getPropertyValue: (name: string) => props[name] ?? '',
    },
    dataset: {} as DOMStringMap,
  };
  const win = {
    innerHeight: layout,
    innerWidth: 390,
    visualViewport: viewport,
    document: {
      documentElement: root,
      body,
      activeElement: (focused ? input : null) as never,
      addEventListener: (type: string, fn: () => void) => (docListeners[type] ??= []).push(fn),
      removeEventListener: (type: string, fn: () => void) => {
        docListeners[type] = (docListeners[type] ?? []).filter((l) => l !== fn);
      },
    },
    getComputedStyle: (el: unknown) => ({ overflowY: el === scroll ? 'auto' : 'visible' }),
    requestAnimationFrame: (fn: () => void) => {
      const id = ++nextFrame;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
    addEventListener: (type: string, fn: () => void) => (winListeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: () => void) => {
      winListeners[type] = (winListeners[type] ?? []).filter((l) => l !== fn);
    },
  };
  const flush = () => {
    for (const [id, fn] of [...frames]) {
      frames.delete(id);
      fn();
    }
  };
  return {
    props,
    vvListeners,
    docListeners,
    winListeners,
    frames,
    viewport,
    scroll,
    input,
    root,
    win,
    node,
    body,
    flush,
  };
}

test('a field taller than the reveal band is not fought: covering stays, otherwise the nearest edge aligns', () => {
  const container = { top: 100, bottom: 400 };
  assert.equal(revealDelta(container, { top: 80, bottom: 420 }), 0);
  assert.equal(revealDelta(container, { top: 300, bottom: 600 }), 176);
  assert.equal(revealDelta(container, { top: -100, bottom: 200 }), -176);
  const field = { top: 500, bottom: 760 };
  const delta = revealDelta(container, field);
  assert.equal(delta, 376);
  assert.equal(revealDelta(container, { top: field.top - delta, bottom: field.bottom - delta }), 0);
});

test('the reveal band is clipped to the visible viewport, not the off-screen bottom of the container', () => {
  const body = { tagName: 'BODY', parentElement: null } as never;
  const scroll = {
    tagName: 'DIV',
    parentElement: body,
    scrollHeight: 1600,
    clientHeight: 812,
    scrollTop: 0,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 812 }),
  };
  const input = {
    ...scroll,
    tagName: 'INPUT',
    parentElement: scroll,
    scrollHeight: 0,
    clientHeight: 0,
    getBoundingClientRect: () => ({ top: 700, bottom: 740 }),
  };
  const win = {
    innerHeight: 812,
    visualViewport: {
      height: 476,
      offsetTop: 0,
      scale: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document: { documentElement: {} as never, body, activeElement: input },
    getComputedStyle: (el: unknown) => ({ overflowY: el === scroll ? 'auto' : 'visible' }),
  };
  assert.equal(revealFocusedField(win), 288);
  assert.equal(scroll.scrollTop, 288);
});

test('read-only, disabled and inputmode=none fields never own the keyboard', () => {
  const field = (attrs: Record<string, string>) => ({
    tagName: 'INPUT',
    parentElement: null,
    scrollHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
  });
  assert.equal(isTextField(field({ readonly: '' })), false);
  assert.equal(isTextField(field({ readonly: 'readonly', type: 'text' })), false);
  assert.equal(isTextField(field({ disabled: '' })), false);
  assert.equal(isTextField(field({ inputmode: 'none' })), false);
  assert.equal(isTextField(field({ type: 'date' })), false);
  assert.equal(isTextField(field({ type: 'search' })), true);
});

test('a user gesture suppresses automatic reveal for the focus session; a repeated same-size resize never scrolls', () => {
  const h = harness();
  installKeyboardInset(h.win);
  h.viewport.height = 476;
  h.vvListeners.resize.forEach((fn) => fn());
  h.flush();
  assert.equal(h.scroll.scrollTop, 84);
  h.scroll.scrollTop = 40;
  h.docListeners.touchmove.forEach((fn) => fn());
  h.vvListeners.resize.forEach((fn) => fn());
  h.viewport.height = 400;
  h.vvListeners.resize.forEach((fn) => fn());
  h.flush();
  assert.equal(h.scroll.scrollTop, 40, 'no automatic scroll while the user drives');
});

test('closing and reopening the keyboard re-arms the reveal after a user scroll', () => {
  const h = harness();
  installKeyboardInset(h.win);
  h.viewport.height = 476;
  h.vvListeners.resize.forEach((fn) => fn());
  h.flush();
  assert.equal(h.scroll.scrollTop, 84);
  h.docListeners.wheel.forEach((fn) => fn());
  h.scroll.scrollTop = 0;
  h.viewport.height = 400;
  h.vvListeners.resize.forEach((fn) => fn());
  h.flush();
  assert.equal(h.scroll.scrollTop, 0, 'inhibited while the user drives');
  h.viewport.height = 812;
  h.vvListeners.resize.forEach((fn) => fn());
  h.viewport.height = 476;
  h.vvListeners.resize.forEach((fn) => fn());
  h.flush();
  assert.equal(h.scroll.scrollTop, 84, 'a reopened keyboard reveals again');
});

test('focusing another field while the keyboard stays open reveals that field', () => {
  const h = harness();
  const second = h.node('INPUT', h.scroll, { top: 640, bottom: 680 });
  installKeyboardInset(h.win);
  h.viewport.height = 476;
  h.vvListeners.resize.forEach((fn) => fn());
  h.flush();
  assert.equal(h.scroll.scrollTop, 84);
  h.win.document.activeElement = second as never;
  h.scroll.scrollTop = 0;
  h.docListeners.focusin.forEach((fn) => fn());
  h.flush();
  assert.equal(h.scroll.scrollTop, 404, 'the newly focused field is the reveal target');
});

test('uninstall cancels a pending reveal and removes every listener; a stale frame cannot scroll', () => {
  const h = harness();
  const stop = installKeyboardInset(h.win);
  h.viewport.height = 476;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.frames.size, 1, 'the reveal waits for the next frame');
  const [stale] = [...h.frames.values()];
  stop();
  assert.equal(h.frames.size, 0, 'the queued frame was cancelled');
  stale();
  assert.equal(h.scroll.scrollTop, 0, 'a stale frame must not scroll after uninstall');
  assert.equal(h.vvListeners.resize.length, 0);
  assert.equal(h.vvListeners.scroll.length, 0);
  assert.equal(h.winListeners.resize?.length ?? 0, 0);
  assert.equal(h.docListeners.focusin?.length ?? 0, 0);
  assert.equal(h.docListeners.touchmove?.length ?? 0, 0);
  assert.equal(h.docListeners.wheel?.length ?? 0, 0);
  assert.equal(h.props['--keyboard-inset'], '0px');
  assert.equal('keyboard' in h.root.dataset, false);
});

test('a pinch zoom is not a keyboard: surfaces keep the layout size and nothing reveals', () => {
  const h = harness();
  installKeyboardInset(h.win);
  h.viewport.scale = 2;
  h.viewport.height = 406;
  h.viewport.offsetTop = 100;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.props['--keyboard-inset'], '0px');
  assert.equal(
    h.props['--vv-height'],
    '812px',
    'fixed surfaces keep the layout size while pinching',
  );
  assert.equal(h.props['--vv-top'], '0px');
  assert.equal('keyboard' in h.root.dataset, false);
  assert.equal(h.frames.size, 0);
});

test('Android resize-content shrinks the layout itself: open is read against the baseline with no inset', () => {
  const h = harness();
  installKeyboardInset(h.win);
  h.root.clientHeight = 476;
  h.viewport.height = 476;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.root.dataset.keyboard, 'open');
  assert.equal(
    h.props['--keyboard-inset'],
    '0px',
    'the layout already resized; nothing hides behind the keyboard',
  );
  assert.equal(h.props['--vv-height'], '476px');
});

test('without a focused text field a shrunken visual viewport is not the keyboard', () => {
  const h = harness({ focused: false });
  installKeyboardInset(h.win);
  h.viewport.height = 500;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.props['--keyboard-inset'], '0px');
  assert.equal('keyboard' in h.root.dataset, false);
  assert.equal(h.frames.size, 0);
});

test('a focused field with only browser-chrome shrinkage is not a keyboard and reveals nothing', () => {
  const h = harness();
  installKeyboardInset(h.win);
  h.viewport.height = 760;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.props['--keyboard-inset'], '0px');
  assert.equal('keyboard' in h.root.dataset, false);
  assert.equal(h.frames.size, 0);
});

test('blurring while the keyboard is still up keeps the flag until the geometry restores', () => {
  const h = harness();
  installKeyboardInset(h.win);
  h.viewport.height = 476;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.root.dataset.keyboard, 'open');
  h.win.document.activeElement = null as never;
  h.viewport.offsetTop = 40;
  h.vvListeners.scroll.forEach((fn) => fn());
  assert.equal(
    h.root.dataset.keyboard,
    'open',
    'the still-shrunken viewport is still the keyboard',
  );
  h.viewport.height = 812;
  h.viewport.offsetTop = 0;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal('keyboard' in h.root.dataset, false);
});

test('installing while the keyboard is already open reveals the autofocused field', () => {
  const h = harness({ vvHeight: 476 });
  installKeyboardInset(h.win);
  assert.equal(h.frames.size, 1);
  h.flush();
  assert.equal(h.scroll.scrollTop, 84);
});

test('a viewport scroll that opens the keyboard before the resize still reveals exactly once', () => {
  const h = harness();
  installKeyboardInset(h.win);
  h.viewport.height = 476;
  h.vvListeners.scroll.forEach((fn) => fn());
  assert.equal(h.frames.size, 0, 'a pan never queues a reveal');
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.frames.size, 1);
  h.flush();
  assert.equal(h.scroll.scrollTop, 84);
  h.vvListeners.scroll.forEach((fn) => fn());
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.frames.size, 0);
});

test('blur then refocus of the same field re-arms the reveal', () => {
  const h = harness();
  installKeyboardInset(h.win);
  h.viewport.height = 476;
  h.vvListeners.resize.forEach((fn) => fn());
  h.flush();
  assert.equal(h.scroll.scrollTop, 84);
  h.scroll.scrollTop = 0;
  h.docListeners.touchmove.forEach((fn) => fn());
  h.win.document.activeElement = null as never;
  h.docListeners.focusout.forEach((fn) => fn());
  h.win.document.activeElement = h.input as never;
  h.docListeners.focusin.forEach((fn) => fn());
  h.flush();
  assert.equal(h.scroll.scrollTop, 84);
});

test('closing the keyboard cancels a pending reveal; the stale frame cannot scroll', () => {
  const h = harness();
  installKeyboardInset(h.win);
  h.viewport.height = 476;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.frames.size, 1);
  const [stale] = [...h.frames.values()];
  h.viewport.height = 812;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.frames.size, 0);
  stale();
  assert.equal(h.scroll.scrollTop, 0);
});

test('a pinch with a changed layout never rebases the baseline', () => {
  const h = harness();
  installKeyboardInset(h.win);
  h.viewport.scale = 2;
  h.viewport.height = 350;
  h.win.innerWidth = 600;
  h.root.clientHeight = 700;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal('keyboard' in h.root.dataset, false);
  h.viewport.scale = 1;
  h.viewport.height = 476;
  h.win.innerWidth = 390;
  h.root.clientHeight = 476;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.root.dataset.keyboard, 'open', 'the pre-pinch baseline survives');
  assert.equal(h.props['--keyboard-inset'], '0px');
  h.flush();
  assert.equal(h.scroll.scrollTop, 84);
});

test('a new focus while a reveal is pending retargets the reveal to that field', () => {
  const h = harness();
  const second = h.node('INPUT', h.scroll, { top: 640, bottom: 680 });
  installKeyboardInset(h.win);
  h.viewport.height = 476;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(h.frames.size, 1);
  h.win.document.activeElement = second as never;
  h.docListeners.focusin.forEach((fn) => fn());
  h.flush();
  assert.equal(h.scroll.scrollTop, 404);
});

test('without the viewport API a focused layout shrink reports the keyboard with no inset', () => {
  const h = harness();
  h.win.visualViewport = null as never;
  installKeyboardInset(h.win);
  h.root.clientHeight = 750;
  h.winListeners.resize.forEach((fn) => fn());
  assert.equal('keyboard' in h.root.dataset, false, '62px off the baseline is not a keyboard');
  h.root.clientHeight = 712;
  h.winListeners.resize.forEach((fn) => fn());
  assert.equal(h.root.dataset.keyboard, 'open');
  assert.equal(h.props['--keyboard-inset'], '0px');
});

test('a genuine rotation rebases the layout height', () => {
  const h = harness();
  installKeyboardInset(h.win);
  h.win.innerWidth = 844;
  h.root.clientHeight = 390;
  h.viewport.height = 390;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal('keyboard' in h.root.dataset, false);
  h.viewport.height = 340;
  h.vvListeners.resize.forEach((fn) => fn());
  assert.equal(
    'keyboard' in h.root.dataset,
    false,
    '50px off the rotated baseline is not a keyboard',
  );
});
