// Mutation check for the study review: each core fix is reverted in a throwaway copy of the sources and the
// focused tests must fail by name; the unmutated copy must pass. The working tree is never modified.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TEST = 'tests/study-review.test.ts';
const MUTATIONS = [
  {
    name: 'D-day on the UTC calendar',
    file: 'src/components/study/insights.ts',
    from: 'dayNumber(subject.examDate) - dayNumber(seoulDateKey(now))',
    to: 'dayNumber(subject.examDate) - dayNumber(now.toISOString().slice(0, 10))',
  },
  {
    name: 'next review counts same-day cards',
    file: 'src/components/study/insights.ts',
    from: 'if (day > today) counts.set',
    to: 'if (day >= today) counts.set',
  },
  {
    name: 'explanation folds at 70 characters',
    file: 'src/components/study/insights.ts',
    from: 'answer.length > 140',
    to: 'answer.length > 70',
  },
  {
    name: 'stale essay drafts count as in progress',
    file: 'src/components/study/insights.ts',
    from: '(e) => e.id === draft.essayId && essayRevision(e) === draft.revision,',
    to: '(e) => e.id === draft.essayId,',
  },
  {
    name: 'today pill is orange even with nothing due',
    file: 'src/components/study/subjects.tsx',
    from: "className={`study-today-pill${due ? ' is-primary' : ''}`}",
    to: 'className="study-today-pill is-primary"',
  },
  {
    name: 'today row keeps the mock\'s "시작" instead of "바로 가기"',
    file: 'src/components/study/subjects.tsx',
    from: "{due ? '바로 가기' : hasCards ? '카드 보기' : '만들기'}",
    to: "{due ? '시작' : hasCards ? '카드 보기' : '만들기'}",
  },
  {
    name: 'review session in creation order instead of the "오늘" list order',
    file: 'src/components/study/cards.tsx',
    from: 'libraryGroups(initial).today.map((c) => c.id)',
    to: 'initial.filter((c) => libraryGroups([c]).today.length).map((c) => c.id)',
  },
];

const root = resolve('.');
function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'memoryz-mutation-'));
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
  if (clean.status !== 0 || clean.failed.length) ok = false;
} finally {
  rmSync(control, { recursive: true, force: true });
}
for (const m of MUTATIONS) {
  const source = readFileSync(join(root, m.file), 'utf8');
  if (source.split(m.from).length !== 2) {
    console.log(`ANCHOR · ${m.name} · expected exactly one "${m.from}" in ${m.file}`);
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
console.log(`STUDY_REVIEW_MUTATIONS_KILLED (${MUTATIONS.length}/${MUTATIONS.length})`);
