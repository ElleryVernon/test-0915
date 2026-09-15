// Full-suite regression check by test NAME, not by totals: every test that existed before the study
// review (base commit) must still pass, and nothing may fail.
import { execFileSync, spawnSync } from 'node:child_process';

const BASE = '0f14f1e';
const files = execFileSync('git', ['ls-tree', '--name-only', `${BASE}`, 'tests/'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f.endsWith('.test.ts'));
const baseline = new Set();
for (const file of files) {
  const src = execFileSync('git', ['show', `${BASE}:${file}`], { encoding: 'utf8' });
  for (const m of src.matchAll(/(?:^|\n)\s*test\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g))
    baseline.add(m[2].replace(/\\(.)/g, '$1'));
}
const run = spawnSync('npm', ['test'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const output = `${run.stdout}\n${run.stderr}`;
const passed = new Set([...output.matchAll(/^\s*✔ (.+?) \([\d.]+m?s\)$/gm)].map((m) => m[1]));
const failed = [...output.matchAll(/^\s*✖ (.+?) \([\d.]+m?s\)$/gm)].map((m) => m[1]);
const missing = [...baseline].filter((name) => !passed.has(name));
const added = [...passed].filter((name) => !baseline.has(name));
console.log(`npm test exit=${run.status} · baseline names=${baseline.size} · passed=${passed.size} · failed=${failed.length}`);
console.log(`new passing tests: ${added.length}`);
for (const name of failed) console.log(`  FAILED ${name}`);
for (const name of missing) console.log(`  BASELINE NOT PASSING ${name}`);
if (run.status !== 0 || failed.length || missing.length || !baseline.size) process.exit(1);
console.log('STUDY_REVIEW_NO_REGRESSION');
