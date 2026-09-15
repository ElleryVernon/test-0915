// Static audit for the study review (S series) rules. It must find nothing in the current sources and
// must find violations in the pre-review sources (positive control), otherwise the checker proves nothing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASE = '0f14f1e';
const TSX = [
  'src/components/study/subjects.tsx',
  'src/components/study/cards.tsx',
  'src/components/study/insights.ts',
  'src/components/study/study-header.tsx',
];
const read = (file, rev) =>
  rev
    ? execFileSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    : readFileSync(file, 'utf8');
const exists = (file, rev) => {
  try {
    read(file, rev);
    return true;
  } catch {
    return false;
  }
};

/** Innermost CSS rules with their selector, ignoring @media wrappers. */
function cssRules(css) {
  const rules = [];
  const stack = [];
  let buffer = '';
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (char === '}') {
      const selector = stack.pop() ?? '';
      if (!selector.startsWith('@')) rules.push({ selector, body: buffer });
      buffer = '';
    } else buffer += char;
  }
  return rules;
}
const STUDY_SELECTOR = /\.(study-|subject-|material-library|recall-)/;
// Brand colour may fill icons and surfaces, never text on white (2.79:1).
const BRAND_ICON_SELECTORS = new Set(['.subject-insight > svg', '.recall-sparkle']);
// The header element itself (and its modifiers), not the title wrapper or descendants.
const HEADER_ELEMENT = /\.study-header(?:-(?:large|center))?(?![\w-])[^\s>+~]*$/;
// The 44px header the first pass shipped: flush with the top of the page on the web.
const SHORT_HEADER = '.study-header {\n  min-height: 44px;\n  padding-top: 0;\n  padding-bottom: 0;\n}';

function auditCss(text, add) {
  const css = cssRules(text).filter((r) => STUDY_SELECTOR.test(r.selector));
  for (const { selector, body } of css) {
    for (const m of body.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g))
      if (Number(m[1]) < 12) add('min-12px', selector, m[0]);
    const colour = /(?:^|;)\s*color:\s*([^;]+)/.exec(body)?.[1]?.trim();
    if (colour && /--brand|#ff6f0f|#c94d09/i.test(colour) && !BRAND_ICON_SELECTORS.has(selector))
      add('orange-text', selector, `color: ${colour}`);
    if (/--danger|#fff4f2|#c73d32/i.test(body)) add('danger-for-state', selector, 'danger colour');
    // Study screens keep the shared 64px header so titles and buttons sit on the same line as other tabs.
    if (
      selector.split(',').some((part) => HEADER_ELEMENT.test(part.trim())) &&
      /(?:^|;)\s*(?:min-height|height|padding(?:-top|-bottom)?)\s*:/.test(body)
    )
      add('shared-header', selector, 'resizes the shared header');
  }
}

function audit(rev) {
  const findings = [];
  const add = (rule, where, detail) => findings.push(`${rule} · ${where} · ${detail}`);
  for (const file of TSX) {
    if (!exists(file, rev)) continue;
    const src = read(file, rev);
    for (const phrase of ['카드가 기다려요', '기억에 가까워졌어요', '작은 반복이 오래 남아요', '장의 카드'])
      if (src.includes(phrase)) add('personification', file, phrase);
    for (const m of src.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g))
      if (Number(m[1]) < 12) add('min-12px', file, m[0]);
    for (const m of src.matchAll(/\b(text-(?:brand(?:-text)?|primary|accent))\b/g))
      add('orange-text', file, m[1]);
    if (/#(?:ff6f0f|c94d09|fff4f2|c73d32)/i.test(src)) add('hard-coded-colour', file, 'palette literal');
    if (file.endsWith('cards.tsx') && src.includes('primary-surface'))
      add('flip-inversion', file, 'primary-surface on the review flow');
  }
  auditCss(read('src/app/globals.css', rev), add);
  return findings;
}

const current = audit();
const control = audit(BASE);
// The pre-review sources had no study header, so the header rule gets its own control: the 44px rule.
auditCss(SHORT_HEADER, (rule, where, detail) => control.push(`${rule} · ${where} · ${detail}`));
const controlRules = new Set(control.map((f) => f.split(' · ')[0]));
console.log(`current findings: ${current.length}`);
for (const f of current) console.log(`  ${f}`);
console.log(`control (${BASE} + 44px header) findings: ${control.length} · rules: ${[...controlRules].join(', ')}`);
const required = ['personification', 'min-12px', 'flip-inversion', 'shared-header'];
const missed = required.filter((rule) => !controlRules.has(rule));
if (current.length || missed.length) {
  if (missed.length) console.log(`positive control did not trigger: ${missed.join(', ')}`);
  process.exit(1);
}
console.log('STUDY_REVIEW_AUDIT_OK');
