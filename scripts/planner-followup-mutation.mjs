// Mutation check for the planner suggestion rules: each rule is reverted in a throwaway copy of the
// sources and tests/planner-suggestion.test.ts must fail by name; the unmutated copy must pass.
// The working tree is never modified. The screen behavior itself is proven by the browser capture.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TEST = 'tests/planner-suggestion.test.ts';
const POLICY = 'src/components/social/planner-suggestion.ts';
const STORE = 'src/lib/ai-task.ts';
const MUTATIONS = [
  { name: 'a past day stays live', file: POLICY, from: "  if (date < context.today) return { kind: 'stale', date, reason: 'past' };\n", to: '' },
  { name: 'nothing left to add still offered', file: POLICY, from: "  if (!blocks.length) return { kind: 'stale', date, reason: 'empty' };\n", to: '' },
  { name: "today's begun time ignored", file: POLICY, from: 'blocks.some((block) => block.start < context.now)', to: "blocks.some((block) => block.start < '00:00')" },
  { name: 'a block starting this minute counted as begun', file: POLICY, from: 'block.start < context.now', to: 'block.start <= context.now' },
  { name: 'overlapping schedules ignored', file: POLICY, from: 'overlapMinutes(block, schedule) > 0', to: 'overlapMinutes(block, schedule) > 9999' },
  { name: 'touching schedules counted as overlap', file: POLICY, from: 'overlapMinutes(block, schedule) > 0', to: 'overlapMinutes(block, schedule) >= 0' },
  { name: 'saved blocks counted against themselves', file: POLICY, from: 'recoverPlannerResult(task.result ?? { plans: [] }, date, context.schedules).plans.flatMap(', to: '(task.result ?? { plans: [] }).plans.flatMap(' },
  { name: 'another day is toasted as well as noticed', file: POLICY, from: '  if (date !== viewedDay) return null;\n', to: '' },
  { name: 'a seen result treated as unseen', file: POLICY, from: "return { kind: task.seenAt ? 'seen' : 'ready', date };", to: "return { kind: 'ready', date };" },
  { name: 'seen time rewritten on every view', file: STORE, from: '  if (!task || task.seenAt) return task;', to: '  if (!task) return task;' },
  { name: 'status updates drop the seen time', file: STORE, from: 'stored?.seenAt && stored.requestId === task.requestId ? { ...task, seenAt: stored.seenAt } : task', to: 'task' },
  { name: 'a new request inherits the old seen time', file: STORE, from: 'stored?.seenAt && stored.requestId === task.requestId ?', to: 'stored?.seenAt ?' },
  { name: 'acknowledged work stays listed', file: STORE, from: '        !task.acknowledged &&\n        (!lookup.match ||', to: '        (!lookup.match ||' },
  { name: "another account's work is listed", file: STORE, from: '        task.userId === lookup.userId &&\n        task.endpoint === lookup.endpoint &&\n        !task.acknowledged', to: '        task.endpoint === lookup.endpoint &&\n        !task.acknowledged' },
];

const root = resolve('.');
function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'memoryz-planner-mutation-'));
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
for (const m of MUTATIONS) {
  const source = readFileSync(join(root, m.file), 'utf8');
  if (source.split(m.from).length !== 2) {
    console.log(`ANCHOR · ${m.name} · expected exactly one match in ${m.file}`);
    ok = false;
    continue;
  }
  const dir = copy();
  try {
    writeFileSync(join(dir, m.file), source.replace(m.from, m.to));
    const mutated = run(dir);
    const killed = mutated.status !== 0 && mutated.failed.length > 0;
    console.log(`${killed ? 'KILLED' : 'SURVIVED'} · ${m.name} · failing: ${mutated.failed.join(' | ') || '-'}`);
    if (!killed) ok = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (!ok) process.exit(1);
console.log(`PLANNER_FOLLOWUP_MUTATIONS_KILLED (${MUTATIONS.length}/${MUTATIONS.length})`);
