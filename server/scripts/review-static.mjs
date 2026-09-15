// Gate V1: the Go server is clean under staticcheck and go vet, no function body is defined twice
// across packages, and no non-method function is a one-statement wrapper with a single call site
// (a pure indirection). Documented exceptions live in docs/SERVER_REVIEW.md under "허용 래퍼".
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const server = join(process.cwd(), 'server');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: server, encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
const problems = [];

const vet = run('go', ['vet', './...']);
if (vet.status !== 0) problems.push(`go vet: ${vet.stderr.trim()}`);
const sc = run('go', ['run', 'honnef.co/go/tools/cmd/staticcheck@v0.8.1', './...']);
const scLines = sc.stdout.split('\n').filter((l) => /\.go:\d+:\d+:/.test(l));
if (sc.status !== 0 || scLines.length) problems.push(`staticcheck: ${scLines.join(' | ') || sc.stderr.trim()}`);

// Collect Go sources (no tests, no generated store).
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (['store', 'bench', 'testdata'].includes(name)) continue;
      walk(p);
    } else if (p.endsWith('.go') && !p.endsWith('_test.go')) files.push(p);
  }
};
walk(join(server, 'internal'));
walk(join(server, 'cmd'));
const sources = files.map((f) => ({ file: relative(server, f), text: readFileSync(f, 'utf8') }));

// Duplicate bodies: the same non-trivial function body (whitespace-normalised) in two files.
const bodies = new Map();
for (const { file, text } of sources) {
  const re = /^func (?:\([^)]*\) )?([A-Za-z_]\w*)\s*\([^\n]*\{\n([\s\S]*?)\n\}/gm;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2].replace(/\s+/g, ' ').trim();
    if (body.split(';').length < 2 && body.length < 40) continue;
    const key = body;
    const list = bodies.get(key) ?? [];
    list.push(`${file}:${m[1]}`);
    bodies.set(key, list);
  }
}
for (const [, where] of bodies) {
  const pkgs = new Set(where.map((w) => w.split('/').slice(0, -1).join('/')));
  if (pkgs.size > 1) problems.push(`duplicate function body: ${where.join(', ')}`);
}

// One-statement, single-call-site, non-method functions.
const allowed = (() => {
  try {
    const doc = readFileSync(join(process.cwd(), 'docs', 'SERVER_REVIEW.md'), 'utf8');
    const section = doc.split('## 허용 래퍼')[1] ?? '';
    return new Set([...section.matchAll(/`([\w./]+):(\w+)`/g)].map((m) => `${m[1]}:${m[2]}`));
  } catch {
    return new Set();
  }
})();
const everything = sources.map((s) => s.text).join('\n');
for (const { file, text } of sources) {
  const re = /^func ([A-Za-z_]\w*)\s*\([^\n]*\{\n([\s\S]*?)\n\}/gm;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    if (name === 'main' || name === 'init') continue;
    const statements = m[2].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    if (statements.length !== 1) continue;
    const calls = (everything.match(new RegExp(`(?<![\\w.])${name}\\(`, 'g')) ?? []).length - 1; // minus the definition
    const exported = /^[A-Z]/.test(name);
    const key = `${file}:${name}`;
    if (calls <= 1 && !exported && !allowed.has(key)) problems.push(`single-use one-line wrapper: ${key} (${calls} call)`);
  }
}
if (problems.length) {
  for (const p of problems) console.log(p);
  console.log(`REVIEW_STATIC_PROBLEMS ${problems.length}`);
  process.exit(1);
}
console.log(`REVIEW_STATIC_OK files=${sources.length}`);
