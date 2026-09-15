#!/usr/bin/env node
// Mutation control for the SRS golden (gate R3).
//
// The parity test is only worth something if the golden actually distinguishes scheduler
// parameters. This script copies the srs package into a sibling directory inside the Go module
// (server/internal/srs_mut_<id>, removed afterwards), first unchanged — the baseline must pass —
// then three times with one parameter mutated, and expects TestParity to fail each time:
//   1. relearning step 10 minutes -> 5 minutes
//   2. maximum interval 36500 days -> 365 days
//   3. enable_short_term true -> false
// It prints SRS_MUTATIONS_CAUGHT 3/3 and exits 0 only when the baseline passes and every mutant
// fails with a genuine test failure (a copy that does not compile is not a catch).
//
//   node server/internal/srs/testdata/mutation.mjs
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // server/internal/srs/testdata
const pkgDir = resolve(here, '..'); // server/internal/srs
const internalDir = dirname(pkgDir); // server/internal
const serverDir = dirname(internalDir); // server
const importPath = 'memoryz/server/internal/srs';

const mutations = [
  {
    name: 'relearning step 10m -> 5m',
    file: 'params.go',
    from: 'p.RelearningSteps = []float64{10}',
    to: 'p.RelearningSteps = []float64{5}',
  },
  {
    name: 'maximum interval 36500 -> 365',
    file: 'params.go',
    from: 'p.MaximumInterval = 36500',
    to: 'p.MaximumInterval = 365',
  },
  {
    name: 'enable_short_term true -> false',
    file: 'params.go',
    from: 'p.EnableShortTerm = true',
    to: 'p.EnableShortTerm = false',
  },
];

const created = new Set();
function cleanup() {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.clear();
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

/** Copies the package next to itself under a fresh name, keeping it importable as its own path. */
function copyPackage() {
  const id = `${process.pid.toString(36)}_${randomBytes(4).toString('hex')}`;
  const dir = join(internalDir, `srs_mut_${id}`);
  rmSync(dir, { recursive: true, force: true });
  created.add(dir);
  cpSync(pkgDir, dir, { recursive: true, filter: (src) => !basename(src).startsWith('srs_mut_') });
  const newImport = `memoryz/server/internal/${basename(dir)}`;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.go')) continue;
    const p = join(dir, f);
    const src = readFileSync(p, 'utf8');
    const out = src.split(`"${importPath}"`).join(`"${newImport}"`);
    if (out !== src) writeFileSync(p, out);
  }
  return dir;
}

function mutate(dir, m) {
  const p = join(dir, m.file);
  const src = readFileSync(p, 'utf8');
  const count = src.split(m.from).length - 1;
  if (count !== 1) throw new Error(`${m.name}: expected exactly one occurrence of ${JSON.stringify(m.from)} in ${m.file}, found ${count}`);
  writeFileSync(p, src.replace(m.from, m.to));
}

function goTest(dir, verbose) {
  const args = ['test', `./internal/${basename(dir)}/`, '-count=1', '-run', '^TestParity$'];
  if (verbose) args.push('-v');
  const r = spawnSync('go', args, { cwd: serverDir, encoding: 'utf8', env: process.env });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { status: r.status, out, built: !/\[build failed\]|\[setup failed\]|cannot find package/.test(out) };
}

let caught = 0;
let baselineOk = false;
try {
  const base = copyPackage();
  const baseline = goTest(base, true);
  baselineOk = baseline.status === 0 && baseline.built && /SRS_PARITY_OK cases=\d+/.test(baseline.out);
  console.log(`BASELINE ${baselineOk ? 'PASS' : 'FAIL'}: unmutated copy ${basename(base)}`);
  if (!baselineOk) console.log(baseline.out);
  rmSync(base, { recursive: true, force: true });
  created.delete(base);

  for (const m of mutations) {
    const dir = copyPackage();
    mutate(dir, m);
    const r = goTest(dir, false);
    const failed = r.status !== 0 && r.built && /--- FAIL: TestParity/.test(r.out) && !/SRS_PARITY_OK/.test(r.out);
    if (failed) caught++;
    const firstMismatch = (r.out.match(/^\s+srs_test\.go:\d+: .*$/m) ?? [''])[0].trim();
    console.log(`MUTANT ${failed ? 'caught' : 'SURVIVED'}: ${m.name}${r.built ? '' : ' (build failed)'}${firstMismatch ? `\n    ${firstMismatch}` : ''}`);
    if (!failed) console.log(r.out);
    rmSync(dir, { recursive: true, force: true });
    created.delete(dir);
  }
} finally {
  cleanup();
}

console.log(`SRS_MUTATIONS_CAUGHT ${caught}/${mutations.length}${baselineOk ? '' : ' (baseline failed)'}`);
process.exit(baselineOk && caught === mutations.length ? 0 : 1);
