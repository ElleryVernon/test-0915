// Mutation check for the PDF extractor: each rule is reverted in a throwaway copy of the sources and
// tests/pdf-extract.test.ts must fail by name; the unmutated copy must pass. The working tree is untouched.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TEST = 'tests/pdf-extract.test.ts';
const FILE = 'src/lib/server/pdf-extract.ts';
const MUTATIONS = [
  { name: 'tabs and runs of spaces kept in a line', from: "text: text.replace(/\\s+/g, ' ').trim(),", to: 'text: text.trim(),' },
  { name: 'every glyph gap becomes a space', from: 'gap > Math.max(piece.size, 1) * 0.2', to: 'gap > 0' },
  { name: 'text left decomposed', from: ".normalize('NFC')", to: ".normalize('NFD')" },
  { name: 'soft wraps kept as line breaks', from: 'else parts.push(wrapJoin(last, text, lexicon) + text);', to: "else parts.push('\\n' + text);" },
  { name: 'list markers do not start a paragraph', from: '      LIST_MARKER.test(text) ||\n', to: '' },
  { name: 'a short line does not end a paragraph', from: '      previous.right < blockLeft + (blockRight - blockLeft) * 0.8 ||\n', to: '' },
  { name: 'running headers kept', from: 'count >= 3 && count >= pages.length * 0.5', to: 'count >= 99' },
  { name: 'bare page numbers kept', from: ' || PAGE_NUMBER.test(line.text.trim())', to: '' },
  { name: 'TOC leaders kept', from: 'const TOC_LEADER = /^(.*?\\S)\\s*(?:[.·…‥⋯・]\\s*){3,}(\\d{1,4})$/;', to: 'const TOC_LEADER = /^(.*?\\S)\\s*(?:[.·…‥⋯・]\\s*){99,}(\\d{1,4})$/;' },
  { name: 'a particle may start a word', from: "  if (BOUND_START.test(after)) return '';\n", to: '' },
  { name: 'a lone syllable keeps its space', from: "  if (lastWord === tail && tail.length === 1 && !LONE_WORD.has(tail)) return '';\n", to: '' },
  { name: "the document's own spelling ignored", from: "  if (lexicon.has(joined) || (stem.length >= 3 && [...lexicon].some((word) => word.startsWith(stem)))) return '';\n", to: '' },
  { name: 'page starts recorded before the separator', from: "    if (text && blocks.length) text += '\\n\\n';\n    pageBreaks.push(text.length);", to: "    pageBreaks.push(text.length);\n    if (text && blocks.length) text += '\\n\\n';" },
  { name: 'an image follows the paragraph below it', from: '(paragraph.page === p.page && paragraph.top < top)', to: '(paragraph.page === p.page && paragraph.top > top)' },
  { name: 'tiny icons kept', from: 'Math.min(p.width, p.height) >= 48', to: 'Math.min(p.width, p.height) >= 0' },
  { name: 'logos on most pages kept', from: '!(repeatedOn >= 3 && repeatedOn >= pageCount * 0.5)', to: 'true' },
  { name: 'full-page backgrounds kept', from: 'area <= 0.85', to: 'area <= 1.5' },
  { name: 'every page sent to OCR', from: '0) < 16 ? i + 1 : 0)', to: '0) < 100000 ? i + 1 : 0)' },
];

const root = resolve('.');
function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'memoryz-pdf-mutation-'));
  for (const entry of ['src', 'tests', 'prisma']) cpSync(join(root, entry), join(dir, entry), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json']) cpSync(join(root, file), join(dir, file));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}
function run(dir) {
  const result = spawnSync('npx', ['tsx', '--test', TEST], { cwd: dir, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  return {
    status: result.status,
    failed: [...new Set([...output.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]))],
    passed: [...output.matchAll(/^✔ /gm)].length,
  };
}

let ok = true;
const control = copy();
try {
  const clean = run(control);
  console.log(`unmutated copy: exit=${clean.status} · passed=${clean.passed} · failed=${clean.failed.length}`);
  if (clean.status !== 0 || clean.failed.length || !clean.passed) ok = false;
} finally {
  rmSync(control, { recursive: true, force: true });
}
const source = readFileSync(join(root, FILE), 'utf8');
for (const m of MUTATIONS) {
  if (source.split(m.from).length !== 2) {
    console.log(`ANCHOR · ${m.name} · expected exactly one match`);
    ok = false;
    continue;
  }
  const dir = copy();
  try {
    writeFileSync(join(dir, FILE), source.replace(m.from, m.to));
    const mutated = run(dir);
    const killed = mutated.status !== 0 && mutated.failed.length > 0;
    console.log(`${killed ? 'KILLED' : 'SURVIVED'} · ${m.name} · failing: ${mutated.failed.join(' | ') || '-'}`);
    if (!killed) ok = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (!ok) process.exit(1);
console.log(`PDF_EXTRACT_MUTATIONS_KILLED (${MUTATIONS.length}/${MUTATIONS.length})`);
