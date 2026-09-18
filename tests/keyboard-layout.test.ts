import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Static guard for the on-screen keyboard model (src/lib/keyboard-inset.ts): every bar glued to
// the bottom of the viewport must follow --keyboard-inset, sheets must size from --vv-height, the
// tab bar must step aside while typing, and sticky headers must pad the installed web app's
// status bar. The guard reads the stylesheets as text so it stays independent of a browser.
const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const globals = read('src/app/globals.css');
const layoutSystem = read('src/app/layout-system.css');

type Block = { selector: string; body: string };
/** Flattens a stylesheet into selector/body pairs; @media wrappers are dropped, comments removed. */
function blocks(css: string): Block[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
  const out: Block[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}
const declared = (b: Block, prop: string) => new RegExp(`(^|;|\\s)${prop}\\s*:`, 'm').test(b.body);
const value = (b: Block, prop: string) => {
  const hit = b.body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`, 'm'));
  return hit ? hit[1].trim() : null;
};
/** The winning value for `prop` among blocks whose selector list contains `selector` exactly. */
function finalValue(css: Block[], selector: string, prop: string) {
  let last: string | null = null;
  for (const b of css) {
    const selectors = b.selector.split(',').map((s) => s.trim());
    if (selectors.includes(selector) && declared(b, prop)) last = value(b, prop);
  }
  return last;
}
const gb = blocks(globals);

test('the root declares the keyboard and visual-viewport custom properties with safe defaults', () => {
  const rootBlock = blocks(layoutSystem).find((b) => b.selector === ':root');
  assert.ok(rootBlock, ':root block in layout-system.css');
  assert.equal(value(rootBlock, '--keyboard-inset'), '0px');
  assert.equal(value(rootBlock, '--vv-height'), '100dvh');
  assert.equal(value(rootBlock, '--vv-top'), '0px');
  assert.equal(value(rootBlock, '--safe-top'), 'env(safe-area-inset-top, 0px)');
  assert.equal(value(rootBlock, '--safe-bottom'), 'env(safe-area-inset-bottom, 0px)');
  const openRoot = gb.find((b) => b.selector === "html[data-keyboard='open']");
  assert.ok(openRoot, 'keyboard-open root override in globals.css');
  assert.equal(value(openRoot, '--safe-bottom'), '0px');
});

test('every bar fixed or stuck to the bottom of the viewport follows the keyboard inset', () => {
  // Positive controls: the bars the app draws at the bottom edge.
  for (const selector of [
    '.study-fixed-cta',
    '.recall-library-actions',
    '.curriculum-savebar',
    '.exercise-actions',
    '.page-action-dock',
    '.sheet-content',
  ]) {
    assert.equal(finalValue(gb, selector, 'bottom'), 'var(--keyboard-inset)', selector);
  }
  // Bars that normally sit above the tab bar drop to the keyboard once it is open.
  for (const selector of [
    "html[data-keyboard='open'] .study-fixed-cta.above-nav",
    "html[data-keyboard='open'] .planner-cta",
  ]) {
    assert.equal(finalValue(gb, selector, 'bottom'), 'var(--keyboard-inset)', selector);
  }
  // Negative control: no bottom-anchored fixed/sticky block in globals.css is left unhandled.
  const anchored = new Set<string>();
  for (const b of gb) {
    const position = value(b, 'position');
    if (position !== 'fixed' && position !== 'sticky') continue;
    if (!declared(b, 'bottom')) continue;
    for (const s of b.selector.split(',').map((x) => x.trim())) anchored.add(s);
  }
  const follows = (v: string | null) => !!v && v.includes('var(--keyboard-inset)');
  const handled = (selector: string) => {
    if (selector === '.bottom-nav')
      return finalValue(gb, "html[data-keyboard='open'] .bottom-nav", 'display') === 'none';
    if (follows(finalValue(gb, selector, 'bottom'))) return true;
    const base = selector.split(/\s+/).pop()!.split('.').filter(Boolean)[0];
    return (
      follows(finalValue(gb, `html[data-keyboard='open'] ${selector}`, 'bottom')) ||
      follows(finalValue(gb, `html[data-keyboard='open'] .${base}`, 'bottom'))
    );
  };
  const unhandled = [...anchored].filter((s) => !handled(s));
  assert.deepEqual(
    unhandled,
    [],
    `bottom-anchored blocks without a keyboard rule: ${unhandled.join(', ')}`,
  );
  assert.ok(
    anchored.size >= 6,
    `expected the known bottom bars to be detected, got ${anchored.size}`,
  );
});

test('the tab bar and the community write button hide while the keyboard is open', () => {
  assert.equal(finalValue(gb, "html[data-keyboard='open'] .bottom-nav", 'display'), 'none');
  const v3 = blocks(read('src/components/social/community-v3.module.css'));
  assert.equal(finalValue(v3, ":global(html[data-keyboard='open']) .fab", 'display'), 'none');
});

test('sheets size from the visible height instead of the layout viewport', () => {
  assert.match(finalValue(gb, '.sheet-content', 'max-height') ?? '', /var\(--vv-height\)/);
  assert.match(finalValue(gb, '.sheet-content-workspace', 'height') ?? '', /var\(--vv-height\)/);
  assert.equal(finalValue(gb, '.sheet-content-full', 'height'), 'var(--vv-height)');
  assert.equal(finalValue(gb, '.sheet-content-full', 'max-height'), 'var(--vv-height)');
  assert.match(finalValue(gb, 'html', 'scroll-padding-bottom') ?? '', /var\(--keyboard-inset\)/);
});

test('sticky screen headers pad the status bar of the installed web app', () => {
  for (const selector of ['.screen-header', '.community-header']) {
    assert.match(finalValue(gb, selector, 'padding-top') ?? '', /var\(--safe-top\)/, selector);
    assert.equal(
      finalValue(gb, selector, 'top'),
      'var(--vv-top)',
      `${selector} follows the visible top edge`,
    );
  }
});

test('module footers stuck to the bottom follow the keyboard inset too', () => {
  const quiz = blocks(read('src/components/study/quiz-setup.module.css'));
  assert.equal(finalValue(quiz, '.footer', 'bottom'), 'var(--keyboard-inset)');
  const lesson = blocks(read('src/components/study/first-learning.module.css'));
  assert.equal(finalValue(lesson, '.lessonFooter', 'bottom'), 'var(--keyboard-inset)');
});

test('the app root installs the keyboard model once', () => {
  const app = read('src/components/app.tsx');
  assert.match(app, /import \{[^}]*installKeyboardInset[^}]*\} from '@\/lib\/keyboard-inset';/);
  assert.match(app, /useEffect\(\(\) => installKeyboardInset\(window\), \[\]\);/);
});

test('module surfaces size from the shared viewport properties instead of measuring their own', () => {
  const sheet = blocks(read('src/components/social/attachment-sheet.module.css'));
  assert.equal(finalValue(sheet, '.sheet', 'bottom'), 'var(--keyboard-inset)');
  assert.match(finalValue(sheet, '.sheet', 'max-height') ?? '', /var\(--vv-height\)/);
  const editor = blocks(read('src/components/social/community-editor.module.css'));
  assert.equal(finalValue(editor, '.page', 'top'), 'var(--vv-top)');
  assert.equal(finalValue(editor, '.page', 'height'), 'var(--vv-height)');
  const messages = blocks(read('src/components/social/community-messages.module.css'));
  assert.equal(finalValue(messages, '.thread', 'top'), 'var(--vv-top)');
  assert.equal(finalValue(messages, '.thread', 'height'), 'var(--vv-height)');
  const comments = blocks(read('src/components/social/community-comments.module.css'));
  assert.equal(
    finalValue(comments, ":global(html[data-keyboard='open']) .composer:not(.embedded)", 'bottom'),
    'var(--keyboard-inset)',
  );
});

test('surface components no longer measure the visual viewport themselves', () => {
  for (const path of [
    'src/components/social/attachment-sheet.tsx',
    'src/components/social/community-editor-page.tsx',
    'src/components/social/community-comments.tsx',
  ]) {
    assert.doesNotMatch(read(path), /visualViewport/, `${path} uses the shared CSS variables`);
  }
  const messages = read('src/components/social/community-messages.tsx');
  const thread = messages.slice(messages.lastIndexOf('data-dm-thread'));
  assert.doesNotMatch(thread, /visualViewport/, 'the DM thread follows the shared variables');
});

test('editable text stays at least 16px so iOS does not zoom on focus', () => {
  const files = [
    'src/app/globals.css',
    'src/app/layout-system.css',
    ...readdirSync(join(root, 'src/components'), { recursive: true })
      .filter((f): f is string => typeof f === 'string' && f.endsWith('.module.css'))
      .map((f) => join('src/components', f)),
  ];
  const small: string[] = [];
  for (const file of files) {
    for (const b of blocks(read(file))) {
      if (!/(^|[\s>+~,.])(input|textarea)(?=[\s>+~,.:\[]|$)/.test(b.selector)) continue;
      const size = value(b, 'font-size');
      const px = size?.match(/^([0-9.]+)px$/);
      if (px && parseFloat(px[1]) < 16) small.push(`${file}: ${b.selector} (${size})`);
    }
  }
  assert.deepEqual(small, [], `text fields under 16px: ${small.join(', ')}`);
});

test('focused fields keep their scroll margin and adaptive sheets do not animate against the keyboard', () => {
  assert.equal(finalValue(gb, 'input', 'scroll-margin-block'), 'var(--space-6)');
  assert.equal(finalValue(gb, 'textarea', 'scroll-margin-block'), 'var(--space-6)');
  assert.equal(
    finalValue(gb, "html[data-keyboard='open'] .sheet-content-adaptive", 'transition'),
    'none',
  );
});
