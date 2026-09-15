#!/usr/bin/env node
// Mutation control for the planner golden. It copies the planner and textmatch
// packages into a throwaway package directory inside the Go module, changes one
// rule per copy, and expects TestParity to fail on every mutant. An unmutated
// control copy must pass first, so a failure is proof of detection and not of a
// broken copy. Run from anywhere:
//   node server/internal/planner/testdata/mutation.mjs
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const plannerDir = resolve(here, '..');
const internalDir = resolve(plannerDir, '..');
const serverDir = resolve(internalDir, '..');
const sources = { planner: plannerDir, textmatch: join(internalDir, 'textmatch') };
const textmatchImport = 'memoryz/server/internal/textmatch';

const mutations = [
  { name: 'rest 10 -> 5 minutes', pkg: 'planner', file: 'rules.go', from: 'Rest: 10', to: 'Rest: 5' },
  { name: 'block limit 4 -> 5', pkg: 'planner', file: 'rules.go', from: 'Blocks: 4', to: 'Blocks: 5' },
  { name: 'citation min length 8 -> 6', pkg: 'textmatch', file: 'textmatch.go', from: 'MinCitationLen = 8', to: 'MinCitationLen = 6' },
];

const tempRoot = join(internalDir, `mutant_${randomBytes(4).toString('hex')}`);
const cleanup = () => rmSync(tempRoot, { recursive: true, force: true });
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

function goFiles(dir) {
  return readdirSync(dir).filter((name) => name.endsWith('.go'));
}

// copyPackages writes planner and textmatch under tempRoot/<label>/ and points the
// planner copy at the copied textmatch so a textmatch mutation is what it tests.
function copyPackages(label) {
  const target = join(tempRoot, label);
  const copiedImport = `memoryz/server/internal/${basename(tempRoot)}/${label}/textmatch`;
  for (const [name, dir] of Object.entries(sources)) {
    const dest = join(target, name);
    mkdirSync(dest, { recursive: true });
    for (const file of goFiles(dir)) {
      const text = readFileSync(join(dir, file), 'utf8').split(textmatchImport).join(copiedImport);
      writeFileSync(join(dest, file), text);
    }
  }
  mkdirSync(join(target, 'planner', 'testdata'), { recursive: true });
  copyFileSync(join(here, 'golden.json'), join(target, 'planner', 'testdata', 'golden.json'));
  return target;
}

function mutate(target, mutation) {
  const path = join(target, mutation.pkg, mutation.file);
  const text = readFileSync(path, 'utf8');
  const count = text.split(mutation.from).length - 1;
  if (count !== 1) throw new Error(`${mutation.file}: expected exactly one "${mutation.from}", found ${count}`);
  writeFileSync(path, text.replace(mutation.from, mutation.to));
}

function runParity(target) {
  const pkg = `./internal/${basename(tempRoot)}/${basename(target)}/planner/`;
  // -v keeps the PLANNER_PARITY_OK line visible: go test hides a passing test's stdout otherwise.
  const result = spawnSync('go', ['test', pkg, '-count=1', '-v', '-run', 'TestParity'], { cwd: serverDir, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { passed: result.status === 0 && output.includes('PLANNER_PARITY_OK'), parityFailed: output.includes('--- FAIL: TestParity'), output };
}

const tail = (output) => output.trim().split(/\r?\n/).slice(-4).join(' | ');

try {
  mkdirSync(tempRoot, { recursive: true });
  const control = runParity(copyPackages('control'));
  if (!control.passed) {
    console.log(`CONTROL_FAILED unmutated copy did not pass: ${tail(control.output)}`);
    process.exit(1);
  }
  console.log('CONTROL_OK unmutated copy passes the golden');
  let caught = 0;
  mutations.forEach((mutation, index) => {
    const target = copyPackages(`m${index + 1}`);
    mutate(target, mutation);
    const result = runParity(target);
    if (!result.passed && result.parityFailed) {
      caught++;
      console.log(`CAUGHT ${mutation.name}: ${tail(result.output)}`);
    } else {
      console.log(`SURVIVED ${mutation.name}: ${tail(result.output)}`);
    }
  });
  console.log(`PLANNER_MUTATIONS_CAUGHT ${caught}/${mutations.length}`);
  process.exit(caught === mutations.length ? 0 : 1);
} finally {
  cleanup();
}
