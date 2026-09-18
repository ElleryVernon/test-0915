import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guard for the text-field focus ring: every input, textarea, search box, compose field and
// field wrapper draws the one token ring (--focus-ring / --focus-ring-offset) when it takes focus,
// instead of the old mix of brand outlines, brand borders and inset shadows. Buttons keep their own
// ring. The guard reads the stylesheets as text so it stays independent of a browser.
const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const globals = read('src/app/globals.css');

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
/** Every value declared for `prop` in a block, in source order. */
const values = (b: Block, prop: string) =>
  [...b.body.matchAll(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`, 'gm'))].map((m) =>
    m[1].trim(),
  );
function modules(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? modules(join(dir, entry.name))
      : entry.name.endsWith('.module.css')
        ? [join(dir, entry.name)]
        : [],
  );
}

// A selector that focuses a text field or its wrapper: the element itself, a `.field`/`.input*`
// class, anything named after search, the compose fields, the time boxes and the school time inputs.
const FIELD =
  /(?:^|[\s,>])(?:input|textarea|\.field|\.choice-field|\.input|\.?[\w-]*search[\w-]*|\.compose-title|\.compose-body|\.time-box|\.school-time-input[^,{]*)[^,{]*:(?:focus|focus-visible|focus-within)/;
// Chrome around a control is not a text field: `label:has(input:focus-visible)`,
// `input:focus-visible + span`, and `:has()` wrappers such as `.role` or `.planner-date-chip`.
const CONTROL_CHROME = /(?:^|[\s>+~])(?:label|button|span)(?:[.:#[][^\s>+~]*)?$/;
function isTextFieldFocus(selector: string): boolean {
  if (!FIELD.test(selector) || CONTROL_CHROME.test(selector)) return false;
  const wrapper = selector.match(/([^\s>+~]+):has\(/);
  return !wrapper || /search|field|input/.test(wrapper[1]);
}

const files = ['src/app/globals.css', ...modules('src/components')];
const found = files.flatMap((file) =>
  blocks(read(file))
    .filter((b) => b.selector.split(',').some((s) => isTextFieldFocus(s.trim())))
    .map((b) => ({ file, ...b, where: `${file} → ${b.selector.replace(/\s+/g, ' ')}` })),
);

test('the text-field matcher sees fields and wrappers but not the chrome around a control', () => {
  for (const selector of [
    '.choice-field:focus-visible', // the field-shaped option control shares the ring
    'input:focus-visible',
    '.field:focus',
    '.curriculum-search:focus-within',
    '.search:focus-within',
    '.inputShell:focus-within',
    '.generationField input:focus-visible',
    '.fields :global(.search-field):has(input:focus-visible)',
    '.scroll :is(button, input):focus-visible',
  ]) {
    assert.ok(isTextFieldFocus(selector), selector);
  }
  for (const selector of [
    'button:focus-visible',
    '.scroll button:focus-visible',
    '.options label:has(input:focus-visible)',
    '.options input:focus-visible + span',
    '.role:has(input:focus-visible)',
    '.planner-date-chip:has(input:focus-visible)',
  ]) {
    assert.ok(!isTextFieldFocus(selector), selector);
  }
});

test('the root declares the focus ring tokens', () => {
  const roots = blocks(globals).filter((b) => b.selector === ':root');
  assert.ok(roots.length > 0, ':root block in globals.css');
  const token = (prop: string) => roots.flatMap((b) => values(b, prop));
  assert.deepEqual(token('--focus-ring'), ['2px solid var(--text-primary)']);
  assert.deepEqual(
    token('--focus-ring-offset'),
    ['-2px'],
    'the ring sits inside the control so it is never clipped',
  );
});

test('every text-field focus rule draws the token ring and nothing brand-coloured', () => {
  for (const b of found) {
    for (const outline of values(b, 'outline')) {
      assert.ok(
        ['var(--focus-ring)', 'none', '0'].includes(outline),
        `${b.where}: outline is "${outline}"`,
      );
    }
    for (const offset of values(b, 'outline-offset')) {
      assert.equal(offset, 'var(--focus-ring-offset)', `${b.where}: outline-offset`);
    }
    for (const prop of ['border-color', 'outline', 'box-shadow']) {
      for (const v of values(b, prop)) {
        assert.doesNotMatch(v, /var\(--(?:brand|accent)\b/, `${b.where}: ${prop} is "${v}"`);
      }
    }
  }
});

test('the scan proves it sees the known text-field focus rules', () => {
  assert.ok(found.length >= 8, `expected at least 8 text-field focus rules, found ${found.length}`);
  const selectors = new Set(found.flatMap((b) => b.selector.split(',').map((s) => s.trim())));
  for (const selector of [
    'input:focus-visible',
    'textarea:focus-visible',
    '.field:focus',
    '.compose-body:focus-visible',
    '.curriculum-search:focus-within',
    '.time-box:focus-within',
    '.school-time-input input:focus',
    '.community-search:focus-within',
    '.input:focus-within',
    '.generationField input:focus-visible',
  ]) {
    assert.ok(selectors.has(selector), `${selector} is scanned`);
  }
});

test('the weekly-plan sheet keeps its button ring and leaves inputs to the global one', () => {
  const planner = blocks(read('src/components/social/planner-workspace.module.css'));
  const inputRules = planner.filter((b) =>
    b.selector.split(',').some((s) => /\binput\b[^,]*:focus/.test(s)),
  );
  assert.deepEqual(
    inputRules.map((b) => b.selector),
    [],
    'no planner-local input focus rule',
  );
  const buttons = planner.find((b) => b.selector === '.scroll button:focus-visible');
  assert.ok(buttons, '.scroll button:focus-visible keeps its own ring');
  assert.deepEqual(values(buttons, 'outline'), ['2px solid var(--brand-strong)']);
});
