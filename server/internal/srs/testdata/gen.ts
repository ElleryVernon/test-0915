// Golden generator for memoryz/server/internal/srs.
//
// It runs the real scheduler the browser and the TypeScript server share (src/lib/srs.ts on
// ts-fsrs 5.4.2 = FSRS-6) over deterministic rating sequences and writes golden.json next to this
// file. Nothing depends on the wall clock: every timestamp derives from BASE and every random
// choice comes from a seeded PRNG, so two runs produce identical bytes.
//
//   npx tsx server/internal/srs/testdata/gen.ts     (from the repository root)
//
// Shape: { engine, generatedWith, base, cases, previews, dueChecks }
//   cases[i]    = { name, mode, retention, initial: Snapshot, steps: Step[], results: Snapshot[] }
//   Step        = { rating, at, mode?, retention? }  — mode/retention override the case values for
//                 that step only (FIXED→FSRS switches, retention sweeps on the same card)
//   Snapshot    = { consecutiveEasy, bucket, nextReviewAt, fsrs: SerializedFsrs | null }
//   previews[i] = { name, mode, retention, initial, at, intervals: [{ rating, due }] }
//   dueChecks[i]= { name, deleted, bucket, fsrs, nextReviewAt, at, due }
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FSRSVersion } from 'ts-fsrs';
import type { Bucket, Card, SerializedFsrs } from '../../../../src/lib/contracts';
import {
  isDue,
  previewIntervals,
  scheduleCard,
  SRS_VERSION,
  type ReviewRating,
  type SrsMode,
} from '../../../../src/lib/srs';

if (SRS_VERSION !== 'ts-fsrs@5.4.2 / FSRS-6') throw new Error(`unexpected SRS_VERSION ${SRS_VERSION}`);
if (!FSRSVersion.startsWith('v5.4.2 '))
  throw new Error(`ts-fsrs ${FSRSVersion} is installed; the golden must come from 5.4.2`);
const ENGINE = SRS_VERSION.split(' ')[0]; // ts-fsrs@5.4.2

const BASE = Date.parse('2026-09-15T00:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const RATINGS: ReviewRating[] = ['AGAIN', 'HARD', 'GOOD', 'EASY'];
const RETENTIONS = [0.8, 0.85, 0.9, 0.95, 0.97];
const LETTER: Record<string, ReviewRating> = { A: 'AGAIN', H: 'HARD', G: 'GOOD', E: 'EASY' };
const iso = (ms: number) => new Date(ms).toISOString();

/** When a step happens relative to the previous review (prevAt) and the previous due time (prevNext). */
type Timing = 'same' | 'due' | 'dayedge' | `plus:${number}` | `late:${number}` | `early:${number}`;
interface Plan {
  rating: ReviewRating;
  timing: Timing;
  mode?: SrsMode;
  retention?: number;
}
interface Snapshot {
  consecutiveEasy: number;
  bucket: Bucket;
  nextReviewAt: string;
  fsrs: SerializedFsrs | null;
}
interface Step {
  rating: ReviewRating;
  at: string;
  mode?: SrsMode;
  retention?: number;
}
interface GoldenCase {
  name: string;
  mode: SrsMode;
  retention: number;
  initial: Snapshot;
  steps: Step[];
  results: Snapshot[];
}
interface PreviewCase {
  name: string;
  mode: SrsMode;
  retention: number;
  initial: Snapshot;
  at: string;
  intervals: { rating: ReviewRating; due: string }[];
}
interface DueCheck {
  name: string;
  deleted: boolean;
  bucket: Bucket;
  fsrs: SerializedFsrs | null;
  nextReviewAt: string;
  at: string;
  due: boolean;
}

function timeFor(timing: Timing, prevAt: number, prevNext: number): number {
  if (timing === 'same') return prevAt;
  if (timing === 'due') return Math.max(prevAt, prevNext);
  // 10 seconds past the next UTC midnight: minutes pass but the calendar day changes.
  if (timing === 'dayedge') return Math.floor(prevAt / DAY) * DAY + DAY + 10_000;
  const [kind, amount] = timing.split(':');
  const n = Number(amount);
  if (kind === 'plus') return prevAt + n * MINUTE;
  if (kind === 'late') return Math.max(prevAt, prevNext) + n * DAY;
  if (kind === 'early') return Math.max(prevAt, prevNext - n * HOUR);
  throw new Error(`unknown timing ${timing}`);
}

const FSRS_KEYS = [
  'due',
  'stability',
  'difficulty',
  'elapsed_days',
  'scheduled_days',
  'learning_steps',
  'reps',
  'lapses',
  'state',
  'last_review',
].sort();
function snapshot(card: Card): Snapshot {
  let fsrs: SerializedFsrs | null = null;
  if (card.fsrs) {
    const keys = Object.keys(card.fsrs).sort();
    if (keys.join() !== FSRS_KEYS.join())
      throw new Error(`${card.id}: unexpected fsrs keys ${keys.join()}`);
    const f = card.fsrs;
    fsrs = {
      due: f.due,
      stability: f.stability,
      difficulty: f.difficulty,
      elapsed_days: f.elapsed_days,
      scheduled_days: f.scheduled_days,
      learning_steps: f.learning_steps,
      reps: f.reps,
      lapses: f.lapses,
      state: f.state,
      last_review: f.last_review,
    };
  }
  return {
    consecutiveEasy: card.consecutiveEasy,
    bucket: card.bucket,
    nextReviewAt: card.nextReviewAt,
    fsrs,
  };
}

function cardFrom(name: string, snap: Snapshot): Card {
  return {
    id: name,
    subjectId: 'golden',
    front: 'q',
    back: 'a',
    type: 'CONCEPT',
    deleted: false,
    ...JSON.parse(JSON.stringify(snap)),
  };
}

function run(
  name: string,
  mode: SrsMode,
  retention: number,
  start: number,
  plan: Plan[],
  initial?: Partial<Snapshot>,
): GoldenCase {
  const init: Snapshot = {
    consecutiveEasy: 0,
    bucket: 'AGAIN',
    nextReviewAt: iso(start),
    fsrs: null,
    ...initial,
  };
  let card = cardFrom(name, init);
  let prevAt = start;
  let prevNext = Date.parse(init.nextReviewAt);
  const steps: Step[] = [];
  const results: Snapshot[] = [];
  for (const p of plan) {
    const at = timeFor(p.timing, prevAt, prevNext);
    if (at < prevAt) throw new Error(`${name}: review time went backwards`);
    // The browser persists JSON between reviews; replaying through JSON keeps the golden honest.
    const next: Card = JSON.parse(
      JSON.stringify(scheduleCard(card, p.rating, p.mode ?? mode, p.retention ?? retention, at)),
    );
    const step: Step = { rating: p.rating, at: iso(at) };
    if (p.mode) step.mode = p.mode;
    if (p.retention !== undefined) step.retention = p.retention;
    steps.push(step);
    results.push(snapshot(next));
    card = next;
    prevAt = at;
    prevNext = Date.parse(next.nextReviewAt);
  }
  return { name, mode, retention, initial: init, steps, results };
}

/** Letters A/H/G/E separated by spaces; one timing for all steps or one per step. */
function seq(letters: string, timing: Timing | Timing[] = 'due'): Plan[] {
  return letters.split(' ').map((l, i) => {
    const rating = LETTER[l];
    if (!rating) throw new Error(`bad rating letter ${l}`);
    return { rating, timing: Array.isArray(timing) ? timing[i] : timing };
  });
}

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const TIMINGS: Timing[] = [
  'same',
  'due',
  'due',
  'due',
  'plus:1',
  'plus:3',
  'plus:12',
  'plus:45',
  'plus:130',
  'late:1',
  'late:2.5',
  'late:7',
  'late:30',
  'late:120',
  'early:2',
  'early:12',
  'early:36',
  'dayedge',
];

/** A stored state produced by the real scheduler, to start cases from Learning/Review/Relearning. */
function stateAfter(plan: Plan[], start = BASE, retention = 0.9): { snap: Snapshot; at: number } {
  const c = run('seed', 'FSRS', retention, start, plan);
  return { snap: c.results[c.results.length - 1], at: Date.parse(c.steps[c.steps.length - 1].at) };
}

const cases: GoldenCase[] = [];

// A. Every rating on an empty card at every retention.
for (const r of RATINGS)
  for (const ret of RETENTIONS)
    cases.push(run(`fsrs-single-${r}-r${ret}`, 'FSRS', ret, BASE, [{ rating: r, timing: 'same' }]));

// B. Every pair, reviewed when due and reviewed again at the same instant.
for (const r1 of RATINGS)
  for (const r2 of RATINGS) {
    cases.push(run(`fsrs-pair-${r1}-${r2}-due`, 'FSRS', 0.9, BASE, seq(`${r1[0]} ${r2[0]}`, 'due')));
    cases.push(
      run(`fsrs-pair-${r1}-${r2}-same`, 'FSRS', 0.9, BASE, seq(`${r1[0]} ${r2[0]}`, 'same')),
    );
  }

// C. Every triple when due: learning steps, graduation, first lapses.
for (const r1 of RATINGS)
  for (const r2 of RATINGS)
    for (const r3 of RATINGS)
      cases.push(
        run(
          `fsrs-triple-${r1}-${r2}-${r3}-due`,
          'FSRS',
          0.9,
          BASE,
          seq(`${r1[0]} ${r2[0]} ${r3[0]}`, 'due'),
        ),
      );

// D. Hand-written transitions at three retentions.
const transitions: Array<[string, string, Timing | Timing[]]> = [
  ['learn-good-graduate', 'G G G G', 'due'],
  ['learn-again-loop', 'A A A G G G', 'due'],
  ['learn-hard-stays', 'H H H H H H', 'due'],
  ['learn-hard-then-good', 'H G G G', 'due'],
  ['easy-graduate-lapse', 'E A G G G', 'due'],
  ['relearn-hard', 'E A H H G G', 'due'],
  ['relearn-again-again', 'E A A A E', 'due'],
  ['relearn-easy-exit', 'G G A E G', 'due'],
  ['review-lapse-cycle', 'G G G A G A G G A G G G', 'due'],
  ['long-good-12', 'G G G G G G G G G G G G', 'due'],
  ['long-easy-12', 'E E E E E E E E E E E E', 'due'],
  ['long-hard-12', 'H H H H H H H H H H H H', 'due'],
  ['alternate-good-hard-12', 'G H G H G H G H G H G H', 'due'],
  ['alternate-easy-again-12', 'E A E A E A E A E A E A', 'due'],
  ['same-instant-good-6', 'G G G G G G', 'same'],
  ['same-instant-easy-6', 'E E E E E E', 'same'],
  ['same-instant-again-6', 'A A A A A A', 'same'],
  ['same-instant-hard-6', 'H H H H H H', 'same'],
  ['same-instant-mixed', 'G A H E G A', 'same'],
  ['late-reviews', 'G G G G G', ['due', 'late:30', 'late:200', 'late:1000', 'late:5000']],
  ['early-reviews', 'G G G G G', ['due', 'due', 'early:12', 'early:47', 'early:200']],
  ['minutes-apart', 'G G A G G G', ['plus:3', 'plus:15', 'plus:2', 'plus:11', 'plus:1400', 'plus:1441']],
  ['very-late-learning', 'G A G', ['due', 'late:3', 'late:400']],
];
for (const [name, letters, timing] of transitions)
  for (const ret of [0.8, 0.9, 0.97])
    cases.push(run(`fsrs-${name}-r${ret}`, 'FSRS', ret, BASE, seq(letters, timing)));

// Reviews that cross a UTC midnight within minutes (elapsed_days counts calendar days).
const nearMidnight = BASE + 23 * HOUR + 58 * MINUTE + 30_000;
for (const ret of [0.8, 0.9, 0.97]) {
  cases.push(
    run(`fsrs-dayedge-learning-r${ret}`, 'FSRS', ret, nearMidnight, seq('G G G G', ['same', 'plus:1', 'dayedge', 'due'])),
  );
  cases.push(run(`fsrs-dayedge-review-r${ret}`, 'FSRS', ret, nearMidnight, seq('E G G', ['same', 'dayedge', 'dayedge'])));
}

// The same card scheduled with different retentions from one state (the TS test's scenario).
cases.push(
  run('fsrs-retention-sweep', 'FSRS', 0.9, BASE, [
    ...seq('G G G G G G', 'due'),
    { rating: 'GOOD', timing: 'due', retention: 0.8 },
    { rating: 'GOOD', timing: 'due', retention: 0.97 },
    { rating: 'GOOD', timing: 'due', retention: 0.85 },
    { rating: 'GOOD', timing: 'due', retention: 0.95 },
    { rating: 'EASY', timing: 'same', retention: 0.8 },
    { rating: 'AGAIN', timing: 'same', retention: 0.97 },
  ]),
);

// E. Seeded random sequences of 1–12 ratings with mixed timings and retentions.
for (let i = 0; i < 100; i++) {
  const rng = mulberry32(1000 + i);
  const len = 1 + Math.floor(rng() * 12);
  const plan: Plan[] = Array.from({ length: len }, () => ({
    rating: pick(rng, RATINGS),
    timing: pick(rng, TIMINGS),
  }));
  const retention = pick(rng, RETENTIONS);
  const start = BASE + Math.floor(rng() * 48) * HOUR + Math.floor(rng() * 60) * MINUTE;
  cases.push(run(`fsrs-random-${String(i).padStart(3, '0')}`, 'FSRS', retention, start, plan));
}

// F. FIXED mode: constant intervals, consecutiveEasy → MASTERED, fsrs stays null.
for (const r of RATINGS) cases.push(run(`fixed-single-${r}`, 'FIXED', 0.9, BASE, [{ rating: r, timing: 'same' }]));
const fixedSequences: Array<[string, string]> = [
  ['mastered-easy-easy', 'E E'],
  ['mastered-easy-x3', 'E E E'],
  ['easy-good-easy-easy', 'E G E E'],
  ['reset-after-mastered', 'E E A E E H'],
  ['all-ratings', 'A H G E'],
  ['mastered-then-more', 'E E E G A E E E'],
];
for (const [name, letters] of fixedSequences) cases.push(run(`fixed-${name}`, 'FIXED', 0.9, BASE, seq(letters, 'due')));
for (let i = 0; i < 10; i++) {
  const rng = mulberry32(5000 + i);
  const len = 1 + Math.floor(rng() * 12);
  const plan: Plan[] = Array.from({ length: len }, () => ({
    rating: pick(rng, RATINGS),
    timing: pick(rng, TIMINGS),
  }));
  cases.push(run(`fixed-random-${i}`, 'FIXED', 0.9, BASE + i * HOUR, plan));
}
// FIXED never validates retention and drops whatever fsrs state was stored.
cases.push(run('fixed-retention-unchecked', 'FIXED', 0.5, BASE, seq('G E', 'due')));
const reviewState = stateAfter(seq('G G'));
cases.push(run('fixed-ignores-stored-fsrs', 'FIXED', 0.9, reviewState.at, seq('G E E', 'due'), reviewState.snap));

// G. Mode switches inside one card's history (FIXED leaves fsrs null, so FSRS restarts empty).
cases.push(
  run('switch-fixed-then-fsrs', 'FIXED', 0.9, BASE, [
    ...seq('G E', 'due'),
    { rating: 'GOOD', timing: 'due', mode: 'FSRS' },
    { rating: 'GOOD', timing: 'due', mode: 'FSRS' },
    { rating: 'AGAIN', timing: 'due', mode: 'FSRS' },
  ]),
);
cases.push(
  run('switch-fixed-mastered-then-fsrs', 'FIXED', 0.9, BASE, [
    ...seq('E E', 'due'),
    { rating: 'GOOD', timing: 'due', mode: 'FSRS' },
    { rating: 'EASY', timing: 'due', mode: 'FSRS' },
    { rating: 'EASY', timing: 'due', mode: 'FSRS' },
  ]),
);
cases.push(
  run('switch-fsrs-fixed-fsrs', 'FSRS', 0.9, BASE, [
    ...seq('G G', 'due'),
    { rating: 'GOOD', timing: 'due', mode: 'FIXED' },
    { rating: 'GOOD', timing: 'due' },
    { rating: 'EASY', timing: 'due' },
  ]),
);
cases.push(
  run('switch-mid-learning', 'FSRS', 0.95, BASE, [
    { rating: 'AGAIN', timing: 'same' },
    { rating: 'HARD', timing: 'plus:1', mode: 'FIXED' },
    { rating: 'GOOD', timing: 'plus:10' },
    { rating: 'GOOD', timing: 'due' },
  ]),
);
cases.push(
  run('switch-alternating', 'FIXED', 0.85, BASE, [
    { rating: 'GOOD', timing: 'due', mode: 'FSRS' },
    { rating: 'GOOD', timing: 'due', mode: 'FIXED' },
    { rating: 'EASY', timing: 'due', mode: 'FSRS' },
    { rating: 'EASY', timing: 'due', mode: 'FIXED' },
    { rating: 'EASY', timing: 'due', mode: 'FSRS' },
  ]),
);

// H. MASTERED in FSRS mode keeps scheduling.
cases.push(run('fsrs-mastered-then-good', 'FSRS', 0.9, BASE, seq('E E G E E A', 'due')));
cases.push(run('fsrs-mastered-same-instant', 'FSRS', 0.9, BASE, seq('E E E', 'same')));
cases.push(run('fsrs-mastered-hard-resets', 'FSRS', 0.97, BASE, seq('E E H E E', 'due')));

// I. Cases that start from a stored state (restore of each FSRS state).
const learning1 = stateAfter(seq('G'));
const learning0 = stateAfter(seq('A'));
const relearning = stateAfter(seq('E A'));
const mastered = stateAfter(seq('E E'));
cases.push(run('restore-learning-step1', 'FSRS', 0.9, learning1.at, seq('G G'), learning1.snap));
cases.push(run('restore-learning-step0', 'FSRS', 0.8, learning0.at, seq('H G G'), learning0.snap));
cases.push(run('restore-review', 'FSRS', 0.9, reviewState.at, seq('A G G'), reviewState.snap));
cases.push(run('restore-relearning', 'FSRS', 0.97, relearning.at, seq('G G'), relearning.snap));
cases.push(run('restore-mastered', 'FSRS', 0.9, mastered.at, seq('G'), mastered.snap));
cases.push(run('restore-far-future', 'FSRS', 0.9, reviewState.at, seq('G G', ['late:3000', 'due']), reviewState.snap));
cases.push(
  run('restore-explicit-new', 'FSRS', 0.9, BASE, seq('G G'), {
    fsrs: {
      due: iso(BASE),
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      state: 0,
    },
  }),
);
{
  // A stored Review card without last_review: elapsed_days is 0, so the short-term formula applies.
  const { last_review: _dropped, ...noLast } = reviewState.snap.fsrs!;
  cases.push(
    run('restore-review-no-last-review', 'FSRS', 0.9, reviewState.at, seq('G G'), {
      ...reviewState.snap,
      fsrs: noLast as SerializedFsrs,
    }),
  );
}

// Previews: previewIntervals over representative states.
const previews: PreviewCase[] = [];
function preview(name: string, mode: SrsMode, retention: number, snap: Snapshot, at: number) {
  const card = cardFrom(name, snap);
  previews.push({
    name,
    mode,
    retention,
    initial: snap,
    at: iso(at),
    intervals: previewIntervals(card, mode, retention, at),
  });
}
const empty: Snapshot = { consecutiveEasy: 0, bucket: 'AGAIN', nextReviewAt: iso(BASE), fsrs: null };
for (const ret of RETENTIONS) preview(`preview-new-r${ret}`, 'FSRS', ret, empty, BASE);
preview('preview-new-fixed', 'FIXED', 0.9, empty, BASE);
preview('preview-learning-step1', 'FSRS', 0.9, learning1.snap, Date.parse(learning1.snap.nextReviewAt));
preview('preview-learning-step0-same', 'FSRS', 0.9, learning0.snap, learning0.at);
preview('preview-review-r0.85', 'FSRS', 0.85, reviewState.snap, Date.parse(reviewState.snap.nextReviewAt));
preview('preview-review-late', 'FSRS', 0.95, reviewState.snap, Date.parse(reviewState.snap.nextReviewAt) + 40 * DAY);
preview('preview-relearning', 'FSRS', 0.9, relearning.snap, Date.parse(relearning.snap.nextReviewAt));
preview('preview-mastered', 'FSRS', 0.9, mastered.snap, Date.parse(mastered.snap.nextReviewAt));
preview('preview-review-fixed', 'FIXED', 0.9, reviewState.snap, reviewState.at);

// isDue over the same states: 1ms early, exactly due, 1ms late, deleted, MASTERED with/without fsrs.
const dueChecks: DueCheck[] = [];
function due(name: string, snap: Snapshot, deleted = false, bucket: Bucket = snap.bucket) {
  const next = Date.parse(snap.nextReviewAt);
  for (const [suffix, offset] of [
    ['early', -1],
    ['exact', 0],
    ['late', 1],
  ] as const) {
    const at = next + offset;
    const card = cardFrom(name, { ...snap, bucket });
    card.deleted = deleted;
    dueChecks.push({
      name: `${name}-${suffix}`,
      deleted,
      bucket,
      fsrs: snap.fsrs,
      nextReviewAt: snap.nextReviewAt,
      at: iso(at),
      due: isDue(card, at),
    });
  }
}
due('due-new', empty);
due('due-learning', learning1.snap);
due('due-review', reviewState.snap);
due('due-review-deleted', reviewState.snap, true);
due('due-mastered-fsrs', mastered.snap);
const fixedMastered = cases.find((c) => c.name === 'fixed-mastered-easy-easy')!;
due('due-mastered-fixed', fixedMastered.results[1]);
due('due-mastered-fixed-deleted', fixedMastered.results[1], true);
due('due-fixed-good', cases.find((c) => c.name === 'fixed-single-GOOD')!.results[0]);
due('due-mastered-bucket-without-fsrs', { ...empty, bucket: 'MASTERED' });

// Coverage self-check, so the file cannot silently drift below the gate.
const ratingsSeen = new Set<string>();
const retentionsSeen = new Set<number>();
const statesSeen = new Set<number>();
let sameInstant = 0;
let fixed = 0;
let masteredResults = 0;
let switches = 0;
let maxLen = 0;
for (const c of cases) {
  maxLen = Math.max(maxLen, c.steps.length);
  if (c.mode === 'FIXED') fixed++;
  retentionsSeen.add(c.retention);
  let prevAt = '';
  for (const [i, s] of c.steps.entries()) {
    ratingsSeen.add(s.rating);
    if (s.retention !== undefined) retentionsSeen.add(s.retention);
    if (s.mode && s.mode !== c.mode) switches++;
    if (s.at === prevAt) sameInstant++;
    prevAt = s.at;
    const f = c.results[i].fsrs;
    if (f) statesSeen.add(f.state);
    if (c.results[i].bucket === 'MASTERED') masteredResults++;
  }
}
const names = new Set(cases.map((c) => c.name));
if (names.size !== cases.length) throw new Error('duplicate case names');
if (cases.length < 200) throw new Error(`only ${cases.length} cases`);
if (ratingsSeen.size !== 4) throw new Error('not every rating is covered');
if (RETENTIONS.some((r) => !retentionsSeen.has(r))) throw new Error('not every retention is covered');
if ([1, 2, 3].some((s) => !statesSeen.has(s))) throw new Error('learning/review/relearning not all covered');
if (!sameInstant || !fixed || !masteredResults || !switches || maxLen < 12) throw new Error('coverage gap');

const golden = { engine: ENGINE, generatedWith: 'scheduleCard', base: iso(BASE), cases, previews, dueChecks };
// GOLDEN_OUT lets a check regenerate into a scratch file and compare bytes with the committed golden.
const out = process.env.GOLDEN_OUT ?? join(dirname(fileURLToPath(import.meta.url)), 'golden.json');
writeFileSync(out, JSON.stringify(golden, null, 1) + '\n');
console.log(
  `wrote ${out}: ${cases.length} cases (${fixed} FIXED, ${switches} mode switches, ${sameInstant} same-instant steps, ${masteredResults} MASTERED results, max ${maxLen} steps), ${previews.length} previews, ${dueChecks.length} due checks`,
);
