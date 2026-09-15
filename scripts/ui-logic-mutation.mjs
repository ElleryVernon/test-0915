// Mutation check for the shared-control logic: each rule is broken in a throwaway copy and
// tests/ui-logic.test.ts must fail by name; the unmutated copy must pass. The tree is untouched.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TEST = 'tests/ui-logic.test.ts';
const FILE = 'src/lib/ui-logic.ts';
const MUTATIONS = [
  { name: 'grid starts on the 1st instead of the week start', from: 'const start = new Date(Date.UTC(year, month - 1, 1 - first));', to: 'const start = new Date(Date.UTC(year, month - 1, 1));' },
  { name: 'range limits ignored', from: 'disabled: (!!options.min && date < options.min) || (!!options.max && date > options.max),', to: 'disabled: false,' },
  { name: 'month shift does not wrap the year', from: 'return { year: Math.floor(index / 12), month: (index % 12) + 1 };', to: 'return { year, month: month + delta };' },
  { name: 'rounding wraps past midnight', from: 'return fromMinutes(Math.min(rounded, Math.floor((23 * 60 + 59) / step) * step));', to: 'return fromMinutes(rounded % (24 * 60));' },
  { name: 'stepper truncates instead of rounding', from: 'const snapped = options.min + Math.round((value - options.min) / step) * step;', to: 'const snapped = options.min + Math.floor((value - options.min) / step) * step;' },
  { name: 'page keys move one step', from: "      return clampStep(value + step * 10, options);", to: '      return clampStep(value + step, options);' },
  { name: 'Home goes to max', from: "    case 'Home':\n      return options.min;", to: "    case 'Home':\n      return options.max;" },
  { name: 'required check ignores whitespace', from: "if (rule.required && !trimmed) return", to: 'if (rule.required && !value) return' },
  { name: 'particle is always 을', from: "export const objectParticle = (word: string) => (hasBatchim(word) ? '을' : '를');", to: "export const objectParticle = (word: string) => '을';" },
];

const root = resolve('.');
function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'memoryz-ui-mutation-'));
  for (const entry of ['src', 'tests']) cpSync(join(root, entry), join(dir, entry), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json']) cpSync(join(root, file), join(dir, file));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}
function run(dir) {
  const result = spawnSync('npx', ['tsx', '--test', TEST], { cwd: dir, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  return { status: result.status, failed: [...new Set([...output.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))], passed: [...output.matchAll(/^✔ /gm)].length };
}

let ok = true;
const control = copy();
try {
  const clean = run(control);
  console.log(`unmutated copy: exit=${clean.status} · passed=${clean.passed} · failed=${clean.failed.length}`);
  if (clean.status !== 0 || clean.failed.length) ok = false;
} finally {
  rmSync(control, { recursive: true, force: true });
}
const source = readFileSync(join(root, FILE), 'utf8');
let killed = 0;
for (const m of MUTATIONS) {
  if (source.split(m.from).length !== 2) {
    console.log(`ANCHOR · ${m.name} · expected exactly one occurrence in ${FILE}`);
    ok = false;
    continue;
  }
  const dir = copy();
  try {
    writeFileSync(join(dir, FILE), source.replace(m.from, m.to));
    const mutated = run(dir);
    const dead = mutated.status !== 0 && mutated.failed.length > 0;
    if (dead) killed++;
    console.log(`${dead ? 'KILLED' : 'SURVIVED'} · ${m.name} · failing: ${mutated.failed.join(' | ') || '-'}`);
    if (!dead) ok = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (!ok) process.exit(1);
console.log(`UI_MUTATIONS_CAUGHT ${killed}/${MUTATIONS.length}`);
