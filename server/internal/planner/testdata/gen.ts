// Golden generator for the Go port of the planner rules (server/internal/planner and
// server/internal/textmatch). Run from the repository root:
//   npx tsx server/internal/planner/testdata/gen.ts
// It calls the real TypeScript functions and records their results. A seeded generator
// keeps golden.json byte-identical between runs: no Date.now(), no Math.random().
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DAY_END,
  eveningWindow,
  findFreeSlot,
  formatMinutes,
  freeWindows,
  scheduleGaps,
  timeString,
} from '../../../../src/lib/schedule';
import {
  conflict,
  gradeEssay,
  hasCitation,
  proposePlans,
  validDate,
  type PlanSubject,
} from '../../../testdata/reference/algorithms';
import { validateAiGrade, validateAiPlans } from '../../../testdata/reference/ai';
import { ApiError } from '../../../testdata/reference/errors';

type Interval = { start: string; end: string };
type Dated = { date: string; start: string; end: string };
type Ref = Dated & { id: string };
type Case = { name: string; input: unknown; expected: unknown };

const suites: Record<string, Case[]> = {};
function add(suite: string, name: string, input: unknown, run: () => unknown) {
  const cases = (suites[suite] ??= []);
  if (cases.some((existing) => existing.name === name)) throw new Error(`duplicate case ${suite}/${name}`);
  let expected: unknown;
  try {
    expected = run();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    expected = { error: { status: error.status, message: error.message } };
  }
  cases.push({ name, input, expected });
}

// Deterministic PRNG so the golden never changes between runs.
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20260915);
const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
const pick = <T>(items: readonly T[]): T => items[between(0, items.length - 1)];
const chance = (probability: number) => random() < probability;
function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = between(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const DATE = '2026-09-15';
const NEXT = '2026-09-16';
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const NL = cp(10);
const TAB = cp(9);
const t = timeString;
const ref = (id: string, start: string, end: string, date = DATE): Ref => ({ id, date, start, end });
const dated = (start: string, end: string, date = DATE): Dated => ({ date, start, end });
const strip = ({ date, start, end }: Dated): Dated => ({ date, start, end });
const withAfter = (after: string | undefined) => (after === undefined ? {} : { after });

function randomDay(prefix: string, date = DATE): Ref[] {
  const count = between(1, 5);
  const schedules: Ref[] = [];
  for (let i = 0; i < count; i++) {
    const start = between(7 * 12, 21 * 12) * 5; // 07:00–21:00 on a 5-minute grid
    const end = Math.min(start + between(6, 36) * 5, DAY_END); // 30–180 minutes
    schedules.push(ref(`${prefix}-${i}`, t(start), t(end), date));
  }
  return schedules;
}

// ---------------------------------------------------------------- freeWindows
{
  const fw = (name: string, schedules: Ref[], opts: { after?: string; min?: number } = {}) =>
    add('freeWindows', name, { schedules, ...opts }, () => freeWindows(schedules, opts));
  const school = ref('school', '08:30', '16:00');
  const academy = ref('academy', '18:00', '19:30');
  fw('empty day', []);
  fw('school only: evening after 16:00', [school]);
  fw('school then academy: gap and evening', [school, academy]);
  fw('full day leaves nothing', [ref('all', '00:00', '23:59')]);
  fw('day ending at 21:00 keeps a one-hour evening', [ref('late', '19:00', '21:00')]);
  fw('day ending at 21:01 loses the evening', [ref('late', '19:00', '21:01')]);
  fw('day ending after 22:00 has no evening', [school, ref('night', '20:00', '22:30')]);
  fw('unsorted input is sorted by start', [academy, school]);
  fw('nested schedule does not split the gap', [school, ref('nested', '09:00', '10:00'), academy]);
  fw('partial overlap extends occupied time', [ref('a', '13:00', '15:00'), ref('b', '14:00', '16:30'), ref('c', '18:00', '19:00')]);
  fw('short gap under an hour is skipped', [ref('a', '13:00', '15:00'), ref('b', '15:45', '17:00')]);
  fw('gap of exactly 60 minutes counts', [ref('a', '13:00', '15:00'), ref('b', '16:00', '17:00')]);
  fw('after before the gap leaves it whole', [school, academy], { after: '12:00' });
  fw('after inside the gap clips it', [school, academy], { after: '16:30' });
  fw('after leaving under an hour drops the gap', [school, academy], { after: '17:10' });
  fw('after past the last schedule clips the evening', [school, academy], { after: '20:15' });
  fw('after past 22:00 leaves nothing', [school, academy], { after: '22:10' });
  fw('after at 21:00 leaves exactly the last hour', [school], { after: '21:00' });
  fw('after as an empty string means none', [school, academy], { after: '' });
  fw('min 15 exposes short gaps', [ref('a', '13:00', '15:00'), ref('b', '15:20', '17:00'), ref('c', '17:10', '18:00')], { min: 15 });
  fw('min 30', [ref('a', '13:00', '15:00'), ref('b', '15:20', '17:00'), ref('c', '17:45', '18:00')], { min: 30 });
  fw('min 120 keeps only long windows', [ref('a', '09:00', '12:00'), ref('b', '13:30', '15:00'), ref('c', '17:30', '18:00')], { min: 120 });
  fw('other dates form no gaps but their ends shape the evening', [school, ref('tomorrow', '16:00', '17:00', NEXT), ref('later', '20:00', '21:30', '2026-09-17')]);
  fw('date with a time suffix is cut to the day', [ref('a', '09:00', '10:00', `${DATE}T00:00:00.000Z`), ref('b', '12:00', '13:00', DATE)]);
  fw('two days each with a gap', [ref('a', '09:00', '10:00'), ref('b', '12:00', '13:00'), ref('c', '09:00', '10:00', NEXT), ref('d', '11:30', '12:30', NEXT)]);
  fw('same start twice keeps the first as the gap owner', [ref('x', '09:00', '10:00'), ref('y', '12:00', '13:00'), ref('z', '12:00', '12:30')]);
  fw('touching schedules leave no gap', [ref('a', '09:00', '10:00'), ref('b', '10:00', '11:00'), ref('c', '11:00', '12:00')]);
  for (let i = 0; i < 10; i++) {
    const schedules = randomDay(`r${i}`);
    const after = chance(0.5) ? t(between(8 * 12, 21 * 12) * 5) : undefined;
    fw(`random timetable ${i}`, schedules, withAfter(after));
  }
}

// --------------------------------------------------------------- scheduleGaps
{
  const sg = (name: string, schedules: Ref[], opts: { after?: string; min?: number } = {}) =>
    add('scheduleGaps', name, { schedules, ...opts }, () => scheduleGaps(schedules, opts));
  const fixture = [
    ref('later', '12:00', '13:00'),
    ref('nested', '09:15', '09:45'),
    ref('morning', '09:00', '11:00'),
    ref('tomorrow', '16:00', '17:00', NEXT),
    ref('adjacent', '13:00', '13:30'),
    ref('short-gap', '13:40', '14:00'),
    ref('quarter-hour', '14:15', '15:00'),
  ];
  sg('social fixture with the default 15-minute minimum', fixture);
  sg('empty', []);
  sg('single schedule invents no boundary', [fixture[0]]);
  sg('after clips the first gap', fixture, { after: '11:30' });
  sg('after past the first gap removes it', fixture, { after: '11:50' });
  sg('min 60', fixture, { min: 60 });
  sg('min 5 exposes the ten-minute gap', fixture, { min: 5 });
  sg('same start keeps input order for the gap owner', [ref('b', '12:00', '13:00'), ref('a', '12:00', '12:30'), ref('first', '09:00', '10:00')]);
  sg('time suffix on the date groups by day', [ref('a', '09:00', '10:00', `${DATE}T09:00:00Z`), ref('b', '11:00', '12:00', `${DATE}T11:00:00Z`), ref('c', '10:00', '11:00', `${NEXT}T10:00:00Z`)]);
  sg('gaps on two dates', [ref('a', '09:00', '10:00'), ref('b', '12:00', '13:00'), ref('c', '08:00', '09:00', NEXT), ref('d', '09:30', '10:00', NEXT)]);
  for (let i = 0; i < 5; i++) {
    const schedules = [...randomDay(`g${i}`), ...(chance(0.4) ? randomDay(`g${i}n`, NEXT) : [])];
    sg(`random gaps ${i}`, schedules, withAfter(chance(0.5) ? t(between(8 * 12, 20 * 12) * 5) : undefined));
  }
}

// -------------------------------------------------------------- eveningWindow
{
  const ev = (name: string, schedules: Interval[], opts: { after?: string; min?: number; end?: string } = {}) =>
    add('eveningWindow', name, { schedules, ...opts }, () => eveningWindow(schedules, opts));
  ev('empty day has no evening', []);
  ev('school ends 16:00', [{ start: '08:30', end: '16:00' }]);
  ev('ends 21:00 leaves exactly an hour', [{ start: '19:00', end: '21:00' }]);
  ev('ends 21:01 leaves too little', [{ start: '19:00', end: '21:01' }]);
  ev('after later than the last end starts the evening', [{ start: '08:30', end: '16:00' }], { after: '18:30' });
  ev('after earlier than the last end is ignored', [{ start: '08:30', end: '16:00' }], { after: '12:00' });
  ev('after past the end leaves nothing', [{ start: '08:30', end: '16:00' }], { after: '22:30' });
  ev('min 30 accepts a short evening', [{ start: '19:00', end: '21:15' }], { min: 30 });
  ev('end 23:00 extends the evening', [{ start: '19:00', end: '21:30' }], { end: '23:00' });
  ev('latest end wins regardless of order', [{ start: '18:00', end: '20:00' }, { start: '09:00', end: '21:00' }, { start: '10:00', end: '11:00' }]);
  ev('schedule past midnight-ish end 23:59', [{ start: '08:00', end: '23:59' }]);
}

// --------------------------------------------------------------- findFreeSlot
{
  const ffs = (name: string, others: Interval[], from: number, duration: number, limit?: number) =>
    add('findFreeSlot', name, { others, from, duration, limit: limit ?? DAY_END }, () =>
      limit === undefined ? findFreeSlot(others, from, duration) : findFreeSlot(others, from, duration, limit),
    );
  const academy = { start: '17:30', end: '19:00' };
  ffs('social: after the academy', [academy], 17 * 60, 60);
  ffs('social: before the academy', [academy], 16 * 60, 60);
  ffs('social: full day', [{ start: '00:00', end: '23:59' }], 0, 25);
  ffs('no others', [], 9 * 60, 45);
  ffs('limit blocks the slot after the academy', [academy], 17 * 60, 60, 19 * 60 + 30);
  ffs('limit equals the slot end', [academy], 16 * 60, 60, 17 * 60);
  ffs('limit before from', [], 16 * 60, 30, 16 * 60);
  ffs('from inside a block jumps to its end', [academy], 18 * 60, 30);
  ffs('chained blocks', [academy, { start: '19:00', end: '19:40' }], 17 * 60, 60);
  ffs('gap between blocks fits', [academy, { start: '19:30', end: '21:00' }], 17 * 60, 30);
  ffs('gap between blocks too small', [academy, { start: '19:20', end: '21:00' }], 17 * 60, 30);
  ffs('ends before from are not candidates', [{ start: '08:00', end: '09:00' }, academy], 16 * 60, 60);
  ffs('overlapping others', [{ start: '17:00', end: '18:00' }, { start: '17:30', end: '19:00' }], 16 * 60 + 30, 45);
  ffs('zero duration at a boundary', [academy], 17 * 60 + 30, 0);
  ffs('slot ending exactly at day end', [], 23 * 60, 59);
  ffs('slot past day end', [], 23 * 60, 60);
  ffs('from at midnight', [{ start: '00:00', end: '06:00' }], 0, 30);
  for (let i = 0; i < 8; i++) {
    const others = randomDay(`f${i}`).slice(0, between(0, 3)).map(({ start, end }) => ({ start, end }));
    const from = between(6 * 12, 22 * 12) * 5;
    const duration = between(3, 18) * 5;
    const limit = pick([undefined, undefined, 22 * 60, 21 * 60, from + duration, from + duration - 5]);
    ffs(`random slot ${i}`, others, from, duration, limit);
  }
}

// --------------------------------------------------------------- proposePlans
const pool: PlanSubject[] = [
  { id: 'math', name: '수학' },
  { id: 'bio', name: '생명과학' },
  { id: 'history', name: '한국사' },
  { id: 'english', name: '영어' },
];
{
  const pp = (name: string, date: string, existing: Dated[], subjects: PlanSubject[], after?: string) =>
    add('proposePlans', name, { date, existing, subjects, ...withAfter(after) }, () => proposePlans(date, existing, subjects, after));
  const bio = { id: 'bio', name: '생명과학' };
  const math = { id: 'math', name: '수학' };
  const three = [dated('16:00', '17:30'), dated('18:00', '19:30'), dated('20:00', '20:30')];
  const four = [dated('09:10', '13:30'), dated('13:30', '14:30'), dated('17:00', '19:00'), dated('20:00', '22:10')];
  const subjects3 = [
    { id: 'math', name: '수학II', dueCards: 0 },
    { id: 'bio', name: '생명과학', dueCards: 18 },
    { id: 'history', name: '한국사', dueCards: 4 },
  ];
  pp('backend: three occupied blocks, two subjects', DATE, three, [bio, math]);
  pp('backend: full day', DATE, [dated('00:00', '23:59')], []);
  pp('backend: four occupied, three subjects', DATE, four, subjects3);
  pp('backend: after 15:40', DATE, four, subjects3, '15:40');
  pp('backend: single subject without due cards', DATE, four, [{ id: 'bio', name: '생명과학', dueCards: 0 }]);
  pp('backend: single subject with 3 due cards', DATE, four, [{ id: 'bio', name: '생명과학', dueCards: 3 }]);
  pp('backend: bare day and no subjects', DATE, [], []);
  pp('backend: after school', DATE, [dated('08:30', '16:00')], subjects3);
  pp('backend: evening with after 18:30', DATE, [dated('08:30', '16:00'), dated('18:00', '20:00')], subjects3, '18:30');
  pp('empty day, one subject', DATE, [], [bio]);
  pp('empty day, four subjects with a tie', DATE, [], [
    { id: 'math', name: '수학', dueCards: 3 },
    { id: 'bio', name: '생명과학', dueCards: 0 },
    { id: 'history', name: '한국사', dueCards: 7 },
    { id: 'english', name: '영어', dueCards: 7 },
  ]);
  pp('empty day, after 20:30 leaves 90 minutes', DATE, [], [bio], '20:30');
  pp('empty day, after 21:40 leaves under 25 minutes', DATE, [], [bio], '21:40');
  pp('empty day, after 22:30 is past the study day', DATE, [], [bio], '22:30');
  pp('empty day, after before 16:00 still starts at 16:00', DATE, [], [bio], '09:00');
  pp('after as an empty string', DATE, [], [bio], '');
  pp('other-date schedules are ignored', DATE, [dated('16:00', '22:00', NEXT)], [bio]);
  pp('due cards all zero', DATE, [], [{ ...bio, dueCards: 0 }, { ...math, dueCards: 0 }]);
  pp('one subject with due cards: no 가장 많이', DATE, [], [{ ...bio, dueCards: 0 }, { ...math, dueCards: 5 }]);
  pp('two subjects with due cards: 가장 많이', DATE, [], [{ ...bio, dueCards: 2 }, { ...math, dueCards: 5 }]);
  pp('due card ties keep input order', DATE, [], [{ ...bio, dueCards: 5 }, { ...math, dueCards: 5 }]);
  pp('subject with an empty id has no activity suffix', DATE, [], [{ id: '', name: '자율', dueCards: 2 }]);
  pp('overlapping existing schedules', DATE, [dated('16:00', '18:00'), dated('17:00', '19:00'), dated('19:30', '20:00')], [bio, math]);
  pp('windows too short for 50 minutes fall back to 25', DATE, [dated('09:00', '16:00'), dated('16:40', '17:30'), dated('18:30', '20:00'), dated('21:00', '22:00')], [{ ...bio, dueCards: 0 }]);
  pp('long evening reaches the four-block limit', DATE, [dated('08:00', '12:00')], subjects3);
  pp('long evening without due cards uses 50-minute blocks', DATE, [dated('08:00', '12:00')], [{ ...bio, dueCards: 0 }, { ...math, dueCards: 0 }]);
  pp('four subjects cycle once', DATE, [], pool.map((subject) => ({ ...subject, dueCards: 0 })));
  pp('one subject cycles through activities', DATE, [], [{ id: 'x', name: 'X', dueCards: 0 }]);
  pp('one subject with due cards then cycles', DATE, [], [{ id: 'x', name: 'X', dueCards: 9 }]);
  pp('gap only fits one 25-minute block', DATE, [dated('08:00', '16:00'), dated('17:05', '22:00')], [bio, math]);
  pp('total minutes cap across many windows', DATE, [dated('07:00', '08:00'), dated('09:30', '10:00'), dated('11:30', '12:00'), dated('13:30', '14:00'), dated('15:30', '16:00'), dated('21:30', '22:00')], [{ ...bio, dueCards: 0 }]);
  pp('negative due cards sort last', DATE, [], [{ ...bio, dueCards: -1 }, { ...math, dueCards: 0 }]);
  for (let i = 0; i < 15; i++) {
    const existing = [...randomDay(`e${i}`).map(strip), ...(chance(0.3) ? [dated('10:00', '12:00', NEXT)] : [])];
    const subjects = pool.slice(0, between(0, 4)).map((subject) => (chance(0.7) ? { ...subject, dueCards: between(0, 20) } : subject));
    const after = chance(0.4) ? t(between(8 * 12, 22 * 12) * 5) : undefined;
    pp(`random day ${i}`, DATE, existing, subjects, after);
  }
}

// ------------------------------------------------------------ validateAiPlans
{
  const subjects = [{ id: 'bio', name: '생명과학', dueCards: 4 }];
  const existing = [dated('18:00', '19:30')];
  const block = { date: DATE, title: '개념 복습', start: '20:00', end: '20:30', kind: 'FLEXIBLE', subjectId: 'bio', done: false };
  const payload = (a: unknown[], b: unknown[] = [block]) => ({
    plans: [
      { name: 'A', reason: '근거', blocks: a },
      { name: 'B', reason: '근거', blocks: b },
    ],
  });
  type Opts = { date?: string; existing?: Dated[]; subjects?: PlanSubject[]; after?: string };
  const vp = (name: string, value: unknown, opts: Opts = {}) => {
    const date = opts.date ?? DATE;
    const ex = opts.existing ?? existing;
    const sub = opts.subjects ?? subjects;
    add('validateAiPlans', name, { value, date, existing: ex, subjects: sub, ...withAfter(opts.after) }, () =>
      validateAiPlans(value, date, ex, sub, opts.after),
    );
  };
  const spaced = (count: number, duration: number, rest = 10, from = 6 * 60) =>
    Array.from({ length: count }, (_, i) => {
      const start = from + i * (duration + rest);
      return { ...block, start: t(start), end: t(start + duration) };
    });
  vp('valid: both plans from AI', payload([block]));
  vp('overlaps existing (partial)', payload([{ ...block, start: '18:30', end: '19:00' }]));
  vp('overlaps existing (contains its start)', payload([{ ...block, start: '17:30', end: '18:30' }]));
  vp('touches the existing end', payload([{ ...block, start: '19:30', end: '20:00' }]));
  vp('touches the existing start', payload([{ ...block, start: '17:30', end: '18:00' }]));
  vp('unknown subject', payload([{ ...block, subjectId: 'unknown' }]));
  vp('null subject is allowed and omitted', payload([{ ...block, subjectId: null }]));
  vp('empty subject id is allowed and kept as empty', payload([{ ...block, subjectId: '' }]));
  vp('wrong date', payload([{ ...block, date: NEXT }]));
  vp('date must match even when it is not a date', payload([{ ...block, date: 'nonsense' }]));
  vp('starts before 06:00', payload([{ ...block, start: '05:30', end: '06:00' }]));
  vp('starts at 06:00', payload([{ ...block, start: '06:00', end: '06:30' }]));
  vp('ends after 23:00', payload([{ ...block, start: '22:40', end: '23:10' }]));
  vp('ends at 23:00', payload([{ ...block, start: '22:30', end: '23:00' }]));
  vp('start equals end', payload([{ ...block, start: '20:00', end: '20:00' }]));
  vp('start after end', payload([{ ...block, start: '20:30', end: '20:00' }]));
  vp('24 minutes', payload([{ ...block, end: '20:24' }]));
  vp('25 minutes', payload([{ ...block, end: '20:25' }]));
  vp('60 minutes', payload([{ ...block, end: '21:00' }]));
  vp('61 minutes', payload([{ ...block, end: '21:01' }]));
  vp('before after', payload([block]), { after: '20:05' });
  vp('exactly at after', payload([block]), { after: '20:00' });
  vp('after earlier than the block', payload([block]), { after: '19:55' });
  vp('after as an empty string', payload([block]), { after: '' });
  vp('rest of 9 minutes drops the second block', payload(spaced(2, 30, 9, 20 * 60)));
  vp('rest of 10 minutes keeps the second block', payload(spaced(2, 30, 10, 20 * 60)));
  vp('rest is measured from the last kept block', payload([block, { ...block, start: '20:35', end: '21:00' }, { ...block, start: '20:40', end: '21:10' }]));
  vp('duplicate block is dropped', payload([block, block]));
  vp('blocks are sorted by start before the rules', payload([{ ...block, start: '21:00', end: '21:30' }, block]));
  vp('unsorted input with a rest violation uses the sorted order', payload([{ ...block, start: '20:35', end: '21:00' }, block]));
  vp('fifth 25-minute block is dropped by the block limit', payload(spaced(5, 25)));
  vp('four 60-minute blocks reach 240 minutes', payload(spaced(4, 60)));
  vp('fifth 60-minute block would pass 240 minutes', payload(spaced(5, 60)));
  vp('five 48-minute blocks total exactly 240', payload(spaced(5, 48)));
  vp('eight blocks: the rules keep four', payload(spaced(8, 25)));
  vp('eight blocks in plan B too', payload(spaced(8, 25), spaced(8, 30, 15, 12 * 60)));
  vp('nine blocks fail the schema', payload(spaced(9, 25)));
  vp('plan A empty is replaced by the rule plan', payload([]));
  vp('both plans empty use the rule method', payload([], []));
  vp('both plans dropped entirely', payload([{ ...block, end: '20:15' }], [{ ...block, subjectId: 'x' }]));
  vp('plan B empty, plan A valid', payload([block], []));
  vp('rule replacement honours after', payload([], [block]), { after: '20:30' });
  vp('rule replacement with no existing and no subjects', payload([{ ...block, subjectId: null }], []), { existing: [], subjects: [] });
  vp('rule replacement on a full day yields empty rule blocks', payload([], []), { existing: [dated('00:00', '23:59')] });
  vp('multiple subjects', payload([block, { ...block, start: '21:00', end: '21:45', subjectId: 'math' }]), {
    subjects: [...subjects, { id: 'math', name: '수학', dueCards: 0 }],
  });
  vp('backend: reason missing', { plans: [{ name: 'A', blocks: [block] }, { name: 'B', blocks: [block] }] });
  vp('reason empty', { plans: [{ name: 'A', reason: '', blocks: [block] }, { name: 'B', reason: '근거', blocks: [block] }] });
  vp('reason of 80 characters', { plans: [{ name: 'A', reason: '가'.repeat(80), blocks: [block] }, { name: 'B', reason: '근거', blocks: [block] }] });
  vp('reason of 81 characters', { plans: [{ name: 'A', reason: '가'.repeat(81), blocks: [block] }, { name: 'B', reason: '근거', blocks: [block] }] });
  // zod 4 measures strings in code points: 41 astral emoji are 82 UTF-16 units but pass max(80).
  vp('reason of 40 astral emoji passes max(80)', { plans: [{ name: 'A', reason: cp(0x1f600).repeat(40), blocks: [block] }, { name: 'B', reason: '근거', blocks: [block] }] });
  vp('reason of 41 astral emoji (82 UTF-16 units) still passes max(80)', { plans: [{ name: 'A', reason: cp(0x1f600).repeat(41), blocks: [block] }, { name: 'B', reason: '근거', blocks: [block] }] });
  vp('reason of 81 astral emoji fails max(80)', { plans: [{ name: 'A', reason: cp(0x1f600).repeat(81), blocks: [block] }, { name: 'B', reason: '근거', blocks: [block] }] });
  vp('name of 80 characters', { plans: [{ name: 'n'.repeat(80), reason: '근거', blocks: [block] }, { name: 'B', reason: '근거', blocks: [block] }] });
  vp('name of 81 characters', { plans: [{ name: 'n'.repeat(81), reason: '근거', blocks: [block] }, { name: 'B', reason: '근거', blocks: [block] }] });
  vp('name empty', { plans: [{ name: '', reason: '근거', blocks: [block] }, { name: 'B', reason: '근거', blocks: [block] }] });
  vp('title of 100 characters', payload([{ ...block, title: '제'.repeat(100) }]));
  vp('title of 101 characters', payload([{ ...block, title: '제'.repeat(101) }]));
  vp('title empty', payload([{ ...block, title: '' }]));
  vp('title of 100 astral emoji passes max(100)', payload([{ ...block, title: cp(0x1f4da).repeat(100) }]));
  vp('one plan only', { plans: [{ name: 'A', reason: '근거', blocks: [block] }] });
  vp('three plans', { plans: [{ name: 'A', reason: '근거', blocks: [block] }, { name: 'B', reason: '근거', blocks: [block] }, { name: 'C', reason: '근거', blocks: [block] }] });
  vp('plans is not an array', { plans: { name: 'A', reason: '근거', blocks: [block] } });
  vp('plans missing', {});
  vp('top-level null', null);
  vp('top-level array', [payload([block])]);
  vp('top-level string', 'plans');
  vp('top-level number', 2);
  vp('plan is a string', { plans: ['A', 'B'] });
  vp('bad time 9:00', payload([{ ...block, start: '9:00', end: '9:30' }]));
  vp('bad time 24:00', payload([{ ...block, start: '23:30', end: '24:00' }]));
  vp('bad time 09:60', payload([{ ...block, start: '09:60', end: '10:30' }]));
  vp('time with seconds', payload([{ ...block, start: '20:00:00' }]));
  vp('time as number', payload([{ ...block, start: 1200 }]));
  vp('kind FIXED', payload([{ ...block, kind: 'FIXED' }]));
  vp('kind missing', payload([{ date: DATE, title: '개념 복습', start: '20:00', end: '20:30', subjectId: 'bio', done: false }]));
  vp('subjectId key missing', payload([{ date: DATE, title: '개념 복습', start: '20:00', end: '20:30', kind: 'FLEXIBLE', done: false }]));
  vp('subjectId number', payload([{ ...block, subjectId: 7 }]));
  vp('done true', payload([{ ...block, done: true }]));
  vp('done missing', payload([{ date: DATE, title: '개념 복습', start: '20:00', end: '20:30', kind: 'FLEXIBLE', subjectId: 'bio' }]));
  vp('done 0', payload([{ ...block, done: 0 }]));
  vp('done null', payload([{ ...block, done: null }]));
  vp('date number', payload([{ ...block, date: 20260915 }]));
  vp('blocks missing', { plans: [{ name: 'A', reason: '근거' }, { name: 'B', reason: '근거', blocks: [block] }] });
  vp('blocks null', { plans: [{ name: 'A', reason: '근거', blocks: null }, { name: 'B', reason: '근거', blocks: [block] }] });
  vp('block is null', payload([null]));
  vp('extra keys are stripped', { plans: [{ name: 'A', reason: '근거', blocks: [{ ...block, extra: 1 }], extra: 2 }, { name: 'B', reason: '근거', blocks: [block] }], extra: 3 });
  vp('title with collapsible whitespace is kept verbatim', payload([{ ...block, title: `개념${TAB}복습${NL}정리` }]));
  for (let i = 0; i < 15; i++) {
    const ex = randomDay(`x${i}`).map(strip);
    const sub = pool.slice(0, between(0, 3)).map((subject) => ({ ...subject, dueCards: between(0, 9) }));
    const ids: (string | null)[] = [...sub.map((subject) => subject.id), null, 'ghost'];
    const randomBlock = () => {
      const start = between(5 * 12, 22 * 12) * 5;
      const end = Math.min(start + between(3, 14) * 5, DAY_END);
      return { title: pick(['개념 복습', '문제 풀이', '핵심 정리']), date: chance(0.9) ? DATE : NEXT, start: t(start), end: t(end), kind: 'FLEXIBLE', subjectId: pick(ids), done: false };
    };
    const value = {
      plans: ['복습 우선', '골고루'].map((name) => ({ name, reason: '입력 데이터 기준', blocks: Array.from({ length: between(0, 6) }, randomBlock) })),
    };
    vp(`random ai plans ${i}`, value, { existing: ex, subjects: sub, after: chance(0.3) ? t(between(8 * 12, 21 * 12) * 5) : undefined });
  }
}

// ------------------------------------------------------------ validateAiGrade
{
  const kw = ['자극', '유입'];
  const good = { score: 75, matched: ['자극'], missing: ['유입'], feedback: '자극을 설명했어요. 이온 유입 과정도 연결해 보세요.' };
  const vg = (name: string, value: unknown, keywords: string[] = kw) =>
    add('validateAiGrade', name, { value, keywords }, () => validateAiGrade(value, keywords));
  vg('backend: good', good);
  vg('backend: score 101', { ...good, score: 101 });
  vg('backend: score 100 with something missing', { ...good, score: 100 });
  vg('backend: unknown keyword', { ...good, matched: ['없는 키워드'] });
  vg('backend: duplicate keyword', { ...good, matched: ['자극', '자극'] });
  vg('score 100 with everything matched', { ...good, score: 100, matched: kw, missing: [] });
  vg('score 0 with everything missing', { ...good, score: 0, matched: [], missing: kw });
  vg('score -1', { ...good, score: -1 });
  vg('score 75.5', { ...good, score: 75.5 });
  vg('score 75.0 written as integer', { ...good, score: 75.0 });
  vg('score as string', { ...good, score: '75' });
  vg('score missing', { matched: good.matched, missing: good.missing, feedback: good.feedback });
  vg('score null', { ...good, score: null });
  vg('matched key missing', { score: 75, missing: kw, feedback: good.feedback });
  vg('matched not an array', { ...good, matched: '자극' });
  vg('matched element is a number', { ...good, matched: [1] });
  vg('21 matched entries fail the schema', { ...good, matched: Array.from({ length: 21 }, (_, i) => `k${i}`), missing: [] });
  vg('20 entries pass the schema but not the partition', { ...good, matched: Array.from({ length: 20 }, (_, i) => `k${i}`), missing: [] });
  vg('feedback of 9 characters', { ...good, feedback: '아홉글자피드백입니' });
  vg('feedback of 10 characters', { ...good, feedback: '열글자짜리피드백이다' });
  vg('feedback of 3000 characters', { ...good, feedback: '평'.repeat(3000) });
  vg('feedback of 3001 characters', { ...good, feedback: '평'.repeat(3001) });
  // zod 4 measures strings in code points: 5 astral emoji are 10 UTF-16 units but fail min(10).
  vg('feedback of 5 astral emoji (10 UTF-16 units) fails min(10)', { ...good, feedback: cp(0x1f44d).repeat(5) });
  vg('feedback of 9 astral emoji plus one fails min(10)', { ...good, feedback: `${cp(0x1f44d).repeat(9)}` });
  vg('feedback of 10 astral emoji passes min(10)', { ...good, feedback: cp(0x1f44d).repeat(10) });
  vg('feedback missing', { score: 75, matched: good.matched, missing: good.missing });
  vg('partition missing a keyword', { ...good, missing: [] });
  vg('partition with an extra keyword', { ...good, missing: ['유입', '탈분극'] });
  vg('order inside the lists is free', { ...good, matched: ['유입'], missing: ['자극'] });
  vg('keywords with duplicates cannot be partitioned', { ...good, matched: ['자극'], missing: ['자극'] }, ['자극', '자극']);
  vg('empty keywords with empty lists', { ...good, matched: [], missing: [] }, []);
  vg('empty keywords but a word listed', { ...good, matched: ['자극'], missing: [] }, []);
  vg('extra keys are stripped', { ...good, extra: true, method: 'RULE' });
  vg('top-level null', null);
  vg('top-level array', [good]);
  vg('top-level string', 'good');
  vg('keyword with surrounding spaces is a different word', { ...good, matched: [' 자극'] });
  for (let i = 0; i < 8; i++) {
    const words = shuffle(['자극', '통로', '유입', '탈분극', '재분극']).slice(0, between(1, 4));
    const split = between(0, words.length);
    const matched = words.slice(0, split);
    const missing = words.slice(split);
    const corrupt = pick(['none', 'none', 'drop', 'dup', 'unknown']);
    const lists =
      corrupt === 'drop'
        ? { matched, missing: missing.slice(1) }
        : corrupt === 'dup'
          ? { matched: [...matched, ...matched.slice(0, 1)], missing }
          : corrupt === 'unknown'
            ? { matched, missing: [...missing, '없음'] }
            : { matched, missing };
    const score = chance(0.2) ? 100 : between(0, 99);
    vg(`random grade ${i} (${corrupt})`, { score, ...lists, feedback: '핵심 개념을 잘 설명했어요. 인과 관계를 더 보완해 보세요.' }, words);
  }
}

// ----------------------------------------------------------------- gradeEssay
{
  const keywords = ['자극', '통로', '유입', '탈분극'];
  const model = '역치 이상의 자극으로 나트륨 이온 통로가 열리고 나트륨 이온이 세포 안으로 유입되어 막전위가 상승하는 탈분극이 일어난다.';
  const ge = (name: string, answer: string, kws: string[] = keywords, modelAnswer: string = model) =>
    add('gradeEssay', name, { answer, keywords: kws, modelAnswer }, () => gradeEssay(answer, kws, modelAnswer));
  ge('backend: model answer scores 100', model);
  ge('backend: reversed keywords', '탈분극 유입 통로 자극');
  ge('backend: empty answer', '');
  ge('backend: two keywords', '자극이 오면 통로가 열린다.');
  ge('ordered but short', '자극 통로 유입 탈분극');
  ge('ordered and long', '자극이 도착하면 이온 통로가 열리고, 나트륨 이온의 유입이 이어지며, 그 결과로 막전위가 올라가는 탈분극이 관찰된다.');
  ge('all present but one out of order', '자극이 오면 유입이 먼저가 아니라 통로가 열리고 나서 탈분극이 온다는 설명을 길게 적어 본다.');
  ge('one keyword never counts as ordered', '자극만 언급하고 나머지는 빠뜨린 짧은 답안이라서 순서 점수는 받을 수 없다.');
  ge('keyword prefixes share a position', '탈분극이 일어난다', ['탈분극', '탈분극이']);
  ge('duplicate keyword occurrences use the first', '유입 자극 통로 유입 탈분극');
  ge('length threshold exactly 40', '자'.repeat(40), ['없음'], '짧은 모범답안');
  ge('length 39 is short', '자'.repeat(39), ['없음'], '짧은 모범답안');
  ge('45 percent of a 200-character model: 90 passes', '가'.repeat(90), ['없음'], '모'.repeat(200));
  ge('45 percent of a 200-character model: 89 fails', '가'.repeat(89), ['없음'], '모'.repeat(200));
  ge('45 percent of a 201-character model rounds up the need', '가'.repeat(90), ['없음'], '모'.repeat(201));
  ge('model whitespace is normalized before measuring', '가'.repeat(90), ['없음'], `${'모'.repeat(100)}${'  '.repeat(50)}${'모'.repeat(100)}`);
  ge('compat jamo keywords compose before matching', model, [cp(0x3147, 0x3160), cp(0x3148, 0x314f), '통로']);
  ge('compat jamo in the answer composes too', `${cp(0x3148, 0x314f)}극 ${cp(0x314c, 0x3157)}로`, ['자극', '통로']);
  ge('full-width answer matches ascii keywords', cp(0xff33, 0xff4f, 0xff44, 0xff49, 0xff55, 0xff4d) + ' ions', ['Sodium', 'ions']);
  ge('keyword whitespace collapses across newlines and tabs', `나트륨${NL}${TAB}이온이 이동한다`, ['나트륨 이온']);
  ge('nbsp in the answer folds to a space', `나트륨${cp(0xa0)}이온이 이동한다`, ['나트륨 이온']);
  ge('zwnbsp in the keyword is whitespace', '나트륨 이온이 이동한다', [`나트륨${cp(0xfeff)}이온`]);
  ge('nel in the keyword is not whitespace', '나트륨 이온이 이동한다', [`나트륨${cp(0x85)}이온`]);
  ge('zero keywords', model, []);
  ge('zero keywords and a short answer', '짧다', []);
  ge('one keyword found', model, ['자극']);
  ge('one of three keywords rounds 20', '자극', ['자극', '통로', '유입']);
  ge('two of three keywords rounds 40', '자극 통로', ['자극', '통로', '유입']);
  ge('three of seven keywords rounds 26', '가 나 다', ['가', '나', '다', '라', '마', '바', '사']);
  ge('one of six keywords rounds 10', '가', ['가', '나', '다', '라', '마', '바']);
  ge('five of six keywords rounds 50', '가 나 다 라 마', ['가', '나', '다', '라', '마', '바']);
  ge('empty keyword matches at position zero', 'abc', ['']);
  ge('two empty keywords share position zero', 'abc', ['', '']);
  ge('emoji answer counts UTF-16 units: 20 emoji reach 40', cp(0x1f600).repeat(20), [], '');
  ge('emoji answer counts UTF-16 units: 19 emoji fall short', cp(0x1f600).repeat(19), [], '');
  ge('keywords are case sensitive', 'abc def', ['ABC', 'def']);
  ge('answer padding does not count toward length', `${' '.repeat(30)}${'가'.repeat(39)}${' '.repeat(30)}`, ['없음'], '짧은 모범답안');
  ge('keyword is longer than the answer', '자극', ['자극이 오면 통로가']);
  for (let i = 0; i < 8; i++) {
    const order = shuffle(keywords).slice(0, between(0, 4));
    const filler = ['그래서', '이때', '결국', '먼저', '다음으로'];
    const parts = order.map((word) => `${pick(filler)} ${word}${pick(['이', '가', '은', '를'])} ${pick(['작용한다', '일어난다', '열린다', '이동한다'])}`);
    const answer = parts.join(' ') + (chance(0.5) ? ' 이 과정은 막전위 변화로 이어져 신경 신호가 전달된다.'.repeat(between(1, 3)) : '');
    ge(`random answer ${i}`, answer);
  }
}

// ---------------------------------------------------------------- hasCitation
{
  const source = '나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.';
  const hc = (name: string, src: string, citation: string) =>
    add('hasCitation', name, { source: src, citation }, () => hasCitation(src, citation));
  hc('backend: exact sentence', source, source);
  hc('backend: whitespace variant', source, `나트륨  이온이${NL}세포 안으로 유입되어 탈분극이 일어난다.`);
  hc('backend: hallucinated', source, '칼륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.');
  hc('backend: empty citation', source, '');
  hc('backend: too short', source, '나트륨');
  hc('six characters is too short', source, '이온이 세포');
  hc('seven characters is too short', source, '나트륨 이온이');
  hc('eight characters is enough', source, '나트륨 이온이 세');
  hc('nine characters', source, '나트륨 이온이 세포');
  hc('padding does not count toward the length', source, '   나트륨 이온이   ');
  hc('inner whitespace collapses before measuring', source, `나트륨${TAB}${TAB}이온이`);
  hc('needle longer than the source', source, `${source} 그리고 더`);
  hc('empty source', '', '나트륨 이온이 세포');
  hc('substring from the middle', source, '세포 안으로 유입되어');
  hc('substring at the end', source, '탈분극이 일어난다.');
  hc('case sensitive', 'Sodium ions enter the cell', 'sodium ions enter');
  hc('full-width citation matches an ascii source', 'sodium ions enter the cell', cp(0xff53, 0xff4f, 0xff44, 0xff49, 0xff55, 0xff4d) + ' ions');
  hc('ideographic space and nbsp fold to a space', source, `나트륨${cp(0x3000)}이온이${cp(0xa0)}세포`);
  hc('zwnbsp inside is whitespace', source, `나트륨${cp(0xfeff)}이온이 세포`);
  hc('nel is not whitespace', source, `나트륨${cp(0x85)}이온이 세포`);
  hc('zero-width space is not whitespace', source, `나트륨${cp(0x200b)}이온이 세포`);
  hc('compat jamo compose into syllables', '한국의 나트륨 이온 통로', `${cp(0x314e, 0x314f, 0x3134)}국의 나트륨 이온`);
  hc('decomposed hangul composes', source, '나트륨 이온이 세포'.normalize('NFD'));
  hc('decomposed source composes', source.normalize('NFD'), '나트륨 이온이 세포');
  hc('four astral emoji are eight units', `${cp(0x1f642).repeat(4)} 학습`, cp(0x1f642).repeat(4));
  hc('three astral emoji are six units', `${cp(0x1f642).repeat(4)} 학습`, cp(0x1f642).repeat(3));
  hc('multi-line source', `첫 줄${NL}나트륨 이온이${NL}세포 안으로`, '나트륨 이온이 세포 안으로');
  hc('tabs and spaces in the source', `나트륨${TAB}이온이   세포  안으로`, '나트륨 이온이 세포 안으로');
  hc('citation across a paragraph break', `유입되어${NL}${NL}탈분극이`, '유입되어 탈분극이');
  hc('ligature citation matches its letters', 'efficient transport', `e${cp(0xfb03)}cient`);
  for (let i = 0; i < 8; i++) {
    const start = between(0, source.length - 12);
    const length = between(5, 12);
    let citation = source.slice(start, start + length);
    if (chance(0.3)) citation = citation.split(' ').join(`${NL}  `);
    if (chance(0.2)) citation = citation.replace('이온', '이언');
    hc(`random slice ${i}`, source, citation);
  }
}

// ------------------------------------------------------------------ validDate
{
  const vd = (name: string, value: string) => add('validDate', name, { value }, () => validDate(value));
  vd('backend: ordinary date', '2026-09-15');
  vd('backend: leap day 2024', '2024-02-29');
  vd('backend: 2026-02-29 rolls over', '2026-02-29');
  vd('backend: month 13', '2026-13-01');
  vd('backend: slashes', '9/15/2026');
  vd('2026-02-30 rolls over', '2026-02-30');
  vd('2026-04-31 rolls over', '2026-04-31');
  vd('2026-04-30', '2026-04-30');
  vd('month 00', '2026-00-10');
  vd('day 00', '2026-01-00');
  vd('day 32', '2026-01-32');
  vd('wrong length: single-digit month', '2026-1-01');
  vd('wrong length: no separators', '20260915');
  vd('time suffix', '2026-09-15T00:00');
  vd('leading space', ' 2026-09-15');
  vd('trailing space', '2026-09-15 ');
  vd('trailing newline', `2026-09-15${NL}`);
  vd('full-width digit', `2026-09-1${cp(0xff15)}`);
  vd('empty', '');
  vd('year 0000', '0000-01-01');
  vd('year 9999', '9999-12-31');
  vd('1900 is not a leap year', '1900-02-29');
  vd('2000 is a leap year', '2000-02-29');
  vd('2100 is not a leap year', '2100-02-29');
  vd('december 31', '2026-12-31');
  vd('slashes in iso order', '2026/09/15');
}

// ------------------------------------------------------------------- conflict
{
  const cf = (name: string, a: Dated, b: Dated) => add('conflict', name, { a, b }, () => conflict(a, b));
  const fixed = dated('18:00', '19:30');
  cf('backend: touching end', fixed, { ...fixed, start: '19:30', end: '20:00' });
  cf('backend: touching start', fixed, { ...fixed, start: '17:00', end: '18:00' });
  cf('backend: contained', fixed, { ...fixed, start: '18:15', end: '18:30' });
  cf('backend: containing', fixed, { ...fixed, start: '17:00', end: '20:00' });
  cf('backend: other date', fixed, { ...fixed, date: NEXT });
  cf('identical', fixed, fixed);
  cf('partial overlap at the end', fixed, { ...fixed, start: '19:00', end: '20:00' });
  cf('zero-length inside', fixed, { ...fixed, start: '18:30', end: '18:30' });
  cf('date with suffix differs', fixed, { ...fixed, date: `${DATE}T00:00:00Z` });
}

// -------------------------------------------------------------- formatMinutes
{
  const fm = (total: number) => add('formatMinutes', `total ${total}`, { total }, () => formatMinutes(total));
  for (const total of [0, 1, 59, 60, 61, 75, 120, 310, 1440]) fm(total);
}

const here = dirname(fileURLToPath(import.meta.url));
const total = Object.values(suites).reduce((sum, cases) => sum + cases.length, 0);
writeFileSync(
  process.env.GOLDEN_OUT ?? join(here, 'golden.json'),
  JSON.stringify(
    {
      source: 'src/lib/schedule.ts, server/testdata/reference/algorithms.ts, server/testdata/reference/ai.ts (validateAiPlans, validateAiGrade) — frozen copies of the pre-Go TS server',
      generator: 'server/internal/planner/testdata/gen.ts (seed 20260915)',
      suites,
    },
    null,
    2,
  ) + NL,
);
console.log(`${Object.entries(suites).map(([name, cases]) => `${name}=${cases.length}`).join(' ')} total=${total}`);
