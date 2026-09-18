import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Onboarding is a viewport-height column: the header and step rail stay put under the status bar,
// the step content scrolls inside, and the footer is a flex child instead of a document-sticky
// bar, so the on-screen keyboard shrinks the column rather than pushing the header off screen.
const css = readFileSync(
  join(import.meta.dirname, '..', 'src/components/onboarding.module.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');
function block(selector: string) {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.()[\]:]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  assert.ok(m, `block ${selector}`);
  return m![1];
}
const prop = (body: string, name: string) =>
  body.match(new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`))?.[1].trim() ?? null;

test('the screen covers exactly the visible area, follows its offset, pads the status bar, and never scrolls as a document', () => {
  const screen = block('.screen');
  assert.equal(prop(screen, 'position'), 'fixed', 'follows the visual viewport, not the document');
  assert.equal(prop(screen, 'top'), 'var(--vv-top, 0px)');
  assert.equal(prop(screen, 'height'), 'var(--vv-height, 100dvh)');
  assert.equal(prop(screen, 'max-width'), 'var(--app-width)');
  assert.equal(
    prop(screen, 'min-height'),
    null,
    'no min-height: 100dvh (it would overflow under the keyboard)',
  );
  assert.equal(prop(screen, 'overflow'), 'hidden');
  assert.equal(prop(screen, 'padding-top'), 'var(--safe-top)');
  assert.equal(prop(screen, 'display'), 'flex');
  assert.equal(prop(screen, 'flex-direction'), 'column');
});

test('the step content is the scroll container', () => {
  const content = block('.content');
  assert.equal(prop(content, 'flex'), '1');
  assert.equal(prop(content, 'min-height'), '0');
  assert.equal(prop(content, 'overflow-y'), 'auto');
  assert.equal(prop(content, 'overscroll-behavior'), 'contain');
});

test('the footer is a fixed-size flex child, and its hint yields to the keyboard', () => {
  const footer = block('.footer');
  assert.equal(prop(footer, 'position'), null, 'footer is not sticky/fixed');
  assert.equal(prop(footer, 'flex'), '0 0 auto');
  const hint = block(":global(html[data-keyboard='open']) .footer > p");
  assert.equal(prop(hint, 'display'), 'none');
  const rail = block(":global(html[data-keyboard='open']) .steps");
  assert.equal(prop(rail, 'display'), 'none', 'the step rail folds away while typing');
  const searching = block(
    ":global(html[data-keyboard='open']) .screen[data-searching='true'] .footer",
  );
  assert.equal(
    prop(searching, 'display'),
    'none',
    'results outrank the footer during a school query',
  );
});

test('the school query lives in a modal picker pinned to the visible viewport, so the field can never slide under the keyboard', () => {
  const tsx = readFileSync(
    join(import.meta.dirname, '..', 'src/components/onboarding.tsx'),
    'utf8',
  );
  assert.doesNotMatch(
    tsx,
    /visualViewport|pinFocusedField|KEYBOARD_THRESHOLD|contentRef/,
    'no manual pinning or viewport measurement: the fixed structure keeps the field visible',
  );
  assert.match(tsx, /Dialog\.Root\s+open=\{schoolPickerOpen\}/);
  assert.match(tsx, /data-school-picker/);
  assert.match(tsx, /className=\{styles\.schoolSearchHeader\}/);
  assert.match(tsx, /className=\{styles\.schoolPickerResults\}/);
  assert.match(tsx, /aria-haspopup="dialog"/);
  assert.match(tsx, /ref=\{schoolTriggerRef\}/);
  assert.match(tsx, /ref=\{schoolInputRef\}/);
  assert.match(
    tsx,
    /flushSync\(\(\) => setSchoolPickerOpen\(true\)\)/,
    'the picker mounts inside the tap so the keyboard focus keeps user activation',
  );
  assert.match(tsx, /data-searching=\{schoolPickerOpen \? 'true' : undefined\}/);
  assert.match(
    tsx,
    /if \(!schoolPickerOpen \|\| schoolSearch\.trim\(\)\.length < 2 \|\| draft\.step !== 2\)/,
    'queries only run while the picker is open',
  );
  assert.match(
    tsx,
    /school: next\.schoolId \? next\.school : '', schoolId: next\.schoolId/,
    'an unconfirmed query never saves as the school',
  );
});

test('the picker keeps its search header fixed and lets only the results scroll', () => {
  const picker = block('.schoolPicker');
  assert.equal(prop(picker, 'position'), 'fixed');
  assert.equal(prop(picker, 'top'), 'var(--vv-top)');
  assert.equal(prop(picker, 'height'), 'var(--vv-height)');
  assert.equal(prop(picker, 'display'), 'flex');
  assert.equal(prop(picker, 'flex-direction'), 'column');
  assert.equal(prop(picker, 'overflow'), 'hidden');
  assert.equal(prop(picker, 'padding-top'), 'var(--safe-top)');
  const header = block('.schoolSearchHeader');
  assert.equal(prop(header, 'flex'), '0 0 auto', 'the search region never scrolls away');
  const results = block('.schoolPickerResults');
  assert.equal(prop(results, 'flex'), '1');
  assert.equal(prop(results, 'min-height'), '0');
  assert.equal(prop(results, 'overflow-y'), 'auto');
  assert.equal(prop(results, 'overscroll-behavior'), 'contain');
  const list = block('.schoolResults');
  assert.equal(prop(list, 'list-style'), 'none');
  const row = block('.schoolResults button');
  assert.equal(prop(row, 'min-height'), '76px');
  assert.equal(prop(row, 'background'), null, 'flat rows, not nested cards');
  const name = block('.schoolResults strong');
  assert.equal(prop(name, 'overflow-wrap'), 'anywhere', 'long school names wrap inside the row');
  const footer = block('.footer');
  assert.match(prop(footer, 'padding') ?? '', /var\(--safe-bottom\)/);
});

test('the grade row and its fieldset can shrink to the column instead of overflowing on WebKit', () => {
  const grades = block('.grades');
  assert.equal(prop(grades, 'grid-template-columns'), 'repeat(4, minmax(0, 1fr))');
  for (const selector of ['.fields', '.schoolField']) {
    assert.equal(
      prop(block(selector), 'grid-template-columns'),
      'minmax(0, 1fr)',
      `${selector} cannot be pushed wider by an item`,
    );
  }
  const name = block('.schoolResults button > span');
  assert.equal(prop(name, 'min-width'), '0');
  const address = block('.schoolResults small');
  assert.equal(prop(address, 'overflow-wrap'), 'anywhere', 'long addresses wrap inside the row');
  const globals = readFileSync(join(import.meta.dirname, '..', 'src/app/globals.css'), 'utf8');
  assert.match(
    globals,
    /\nfieldset \{\n  min-inline-size: 0;\n\}/,
    'fieldsets lose the UA min-content minimum',
  );
});
