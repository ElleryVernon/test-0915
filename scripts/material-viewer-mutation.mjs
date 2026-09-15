// Mutation check for the material viewer's layout rules: each rule is broken in a throwaway copy of
// the sources and tests/material-viewer.test.ts must fail by name; the unmutated copy must pass.
// The working tree is never modified.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TEST = 'tests/material-viewer.test.ts';
const FILE = 'src/components/study/material-layout.ts';
const MUTATIONS = [
  { name: 'page 1 does not start at 0 when the first offset is later', from: 'const starts = breaks.length ? [...(breaks[0] === 0 ? [] : [0]), ...breaks] : [0];', to: 'const starts = breaks.length ? breaks : [0];' },
  { name: 'paragraph offsets ignore leading whitespace', from: 'out.push({ start: base + from + leading, end: base + to - trailing, text: raw.trim() });', to: 'out.push({ start: base + from, end: base + to - trailing, text: raw.trim() });' },
  { name: 'images go before their paragraph', from: "      layouts[pageIndex].blocks.push({ kind: 'paragraph', paragraph: slot.paragraph, index: slot.index });\n      for (const image of slot.images) layouts[pageIndex].blocks.push({ kind: 'image', image });", to: "      for (const image of slot.images) layouts[pageIndex].blocks.push({ kind: 'image', image });\n      layouts[pageIndex].blocks.push({ kind: 'paragraph', paragraph: slot.paragraph, index: slot.index });" },
  { name: 'anchors are trusted even after the text was edited', from: 'let target = anchored && image.anchor >= 0 ?', to: 'let target = image.anchor >= 0 ?' },
  { name: 'context matching is whitespace-sensitive', from: 'const normalise = (s: string) => s.replace(/\\s+/g, \' \').trim();', to: 'const normalise = (s: string) => s.trim();' },
  { name: 'citation search is whitespace-sensitive', from: "const needle = citation.replace(/\\s+/g, '');", to: 'const needle = citation.trim();' },
  { name: 'the citation page is always 1', from: "const page = splitPages(content, pageBreaks).find((p) => start >= p.start && start < Math.max(p.end, p.start + 1))?.page ?? 1;", to: 'const page = 1;' },
  { name: 'a missing original offers a retry', from: "if (failure.status === 410) return { message: '원본 파일이 더 이상 없어요. 추출한 본문은 그대로 볼 수 있어요.', retry: false };", to: "if (failure.status === 410) return { message: '원본 파일이 더 이상 없어요. 추출한 본문은 그대로 볼 수 있어요.', retry: true };" },
  { name: 'the extension stays in the title', from: "return trimmed.replace(/\\.(pdf|txt|md|png|jpe?g|webp|gif|heic)$/i, '') || trimmed;", to: 'return trimmed;' },
];

const root = resolve('.');
function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'memoryz-viewer-mutation-'));
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
console.log(`VIEWER_MUTATIONS_CAUGHT ${killed}/${MUTATIONS.length}`);
