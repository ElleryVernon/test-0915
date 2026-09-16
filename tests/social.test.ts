import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { AppData, Post, Schedule } from '../src/lib/contracts';
import { recoverPlannerResult } from '../src/components/social/planner';
import {
  conflictFixes,
  findFreeSlot,
  formatMinutes,
  moveScheduleStart,
  scheduleMatchesDraft,
} from '../src/lib/schedule';
import {
  ceilTime,
  dateKey,
  durationLabel,
  josa,
  monthGrid,
  plannerRows,
  defaultSlot,
  recentSchedules,
  relativeTime,
  studyProgress,
  scheduleConflicts,
  scheduleError,
  scheduleGaps,
  selectPosts,
  shiftDate,
  subjectAccuracy,
  weekDates,
} from '../src/components/social/helpers';

const schedule = (id: string, start: string, end: string, date = '2026-09-15'): Schedule => ({
  id,
  title: id,
  date,
  start,
  end,
  kind: 'FLEXIBLE',
  done: false,
});
const post = (
  id: string,
  role: Post['role'],
  likes: number,
  createdAt: string,
  extra: Partial<Post> = {},
): Post => ({
  id,
  role,
  likes,
  createdAt,
  author: id,
  authorId: id,
  title: `${id} 미분 질문`,
  body: '함께 배우기',
  category: '질문',
  anonymous: false,
  liked: false,
  saved: false,
  commentCount: 0,
  ...extra,
});

test('schedule collision distinguishes shared boundaries, nested blocks, and separate days', () => {
  const values = [
    schedule('fixed', '09:00', '10:00'),
    schedule('adjacent', '10:00', '11:00'),
    schedule('nested', '09:15', '09:45'),
    schedule('tomorrow', '09:00', '10:00', '2026-09-16'),
  ];
  assert.deepEqual(
    scheduleConflicts(values).map((pair) => pair.map((s) => s.id)),
    [['fixed', 'nested']],
  );
  assert.equal(
    scheduleConflicts([
      schedule('positive-a', '12:00', '13:00'),
      schedule('positive-b', '12:00', '13:00'),
    ]).length,
    1,
  );
  assert.equal(scheduleConflicts([values[0], values[1]]).length, 0);
});

test('schedule validation rejects impossible and overnight values while accepting legal day blocks', () => {
  assert.equal(scheduleError(schedule('normal', '08:05', '09:45')), null);
  assert.match(scheduleError(schedule('', '08:05', '09:45'))!, /이름/);
  assert.match(scheduleError(schedule('bad', '24:00', '25:00'))!, /시간/);
  assert.match(scheduleError(schedule('bad', '08:80', '09:45'))!, /시간/);
  assert.match(scheduleError(schedule('equal', '09:00', '09:00'))!, /늦어야/);
  assert.match(scheduleError(schedule('overnight', '23:00', '01:00'))!, /늦어야/);
  assert.match(scheduleError(schedule('date', '09:00', '10:00', '2026-02-30'))!, /날짜/);
  assert.equal(durationLabel('09:15', '10:45'), '1시간 30분');
  assert.equal(durationLabel('09:15', '09:45'), '30분');
});

test('free time merges overlapping schedules, keeps completed time occupied and isolates dates', () => {
  const values = [
    schedule('later', '12:00', '13:00'),
    schedule('nested', '09:15', '09:45'),
    { ...schedule('morning', '09:00', '11:00'), done: true },
    schedule('tomorrow', '16:00', '17:00', '2026-09-16'),
    schedule('adjacent', '13:00', '13:30'),
    schedule('short-gap', '13:40', '14:00'),
    schedule('quarter-hour', '14:15', '15:00'),
  ];
  assert.deepEqual(scheduleGaps(values), [
    { beforeId: 'later', date: '2026-09-15', start: '11:00', end: '12:00' },
    { beforeId: 'quarter-hour', date: '2026-09-15', start: '14:00', end: '14:15' },
  ]);
  assert.equal(values[0].id, 'later', 'gap detection must not reorder shared schedules');
  assert.deepEqual(scheduleGaps([]), []);
  assert.deepEqual(scheduleGaps([values[0]]), [], 'day boundaries must not be invented');
});

test('calendar navigation keeps local dates and crosses month, year and leap-day boundaries', () => {
  assert.equal(dateKey(new Date(2026, 8, 15, 0, 1)), '2026-09-15');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
  assert.deepEqual(weekDates('2026-09-20'), [
    '2026-09-14',
    '2026-09-15',
    '2026-09-16',
    '2026-09-17',
    '2026-09-18',
    '2026-09-19',
    '2026-09-20',
  ]);
});

test('feeds isolate roles before sorting, filtering or searching', () => {
  const records = [
    post('student-old', 'STUDENT', 3, '2026-09-10T12:00:00Z', { saved: true }),
    post('parent-secret', 'PARENT', 100, '2026-09-15T12:00:00Z'),
    post('student-new', 'STUDENT', 1, '2026-09-14T12:00:00Z'),
    post('other-topic', 'STUDENT', 2, '2026-09-12T12:00:00Z', { category: '자유' }),
  ];
  assert.deepEqual(
    selectPosts(records, 'STUDENT', { sort: 'latest' }).map((p) => p.id),
    ['student-new', 'other-topic', 'student-old'],
  );
  assert.deepEqual(
    selectPosts(records, 'STUDENT', { sort: 'popular' }).map((p) => p.id),
    ['student-old', 'other-topic', 'student-new'],
  );
  assert.equal(selectPosts(records, 'PARENT', {}).length, 1);
  assert.equal(selectPosts(records, 'STUDENT', { query: 'parent-secret' }).length, 0);
  assert.deepEqual(
    selectPosts(records, 'STUDENT', { saved: true }).map((p) => p.id),
    ['student-old'],
  );
  assert.deepEqual(
    selectPosts(records, 'STUDENT', { mine: 'student-new' }).map((p) => p.id),
    ['student-new'],
  );
  assert.equal(selectPosts(records, 'STUDENT', { category: '질문', query: ' 미분 ' }).length, 2);
  assert.equal(records[0].id, 'student-old', 'sorting must not mutate shared bootstrap data');
});

test('subject aggregates count real attempts, omit missing scores, and respect parent privacy', () => {
  const data = {
    profile: { role: 'PARENT' },
    child: { privacy: { accuracy: true } },
    subjects: [
      { id: 'bio', name: '생명과학' },
      { id: 'history', name: '한국사' },
    ],
    questions: [{ id: 'q', subjectId: 'bio' }],
    essays: [{ id: 'e', subjectId: 'bio' }],
    attempts: [
      { questionId: 'q', score: 100 },
      { essayId: 'e', score: 50 },
      { questionId: 'unrelated', score: 0 },
    ],
  } as unknown as AppData;
  assert.deepEqual(subjectAccuracy(data), [
    { id: 'bio', name: '생명과학', count: 2, accuracy: 75 },
    { id: 'history', name: '한국사', count: 0, accuracy: null },
  ]);
  data.child!.privacy.accuracy = false;
  assert.deepEqual(subjectAccuracy(data), []);
  delete data.child;
  assert.deepEqual(subjectAccuracy(data), []);
});

test('relative time never invents negative elapsed time', () => {
  const now = Date.parse('2026-09-15T09:00:00Z');
  assert.equal(relativeTime('2026-09-15T08:35:00Z', now), '25분 전');
  assert.equal(relativeTime('2026-09-15T11:35:00Z', now), '방금');
  assert.equal(relativeTime('invalid', now), '');
});
after(() => console.log('social behavioral verification passed'));

test('planner recovery preserves original date and resumes only unsaved blocks', () => {
  const originalDate = '2026-10-01';
  const first = schedule('saved-first', '16:00', '17:00', originalDate);
  const second = schedule('pending-second', '17:00', '18:00', originalDate);
  const alternative = schedule('alternative', '19:00', '20:00', originalDate);
  const result = {
    plans: [
      { name: 'A', blocks: [first, second] },
      { name: 'B', blocks: [alternative] },
    ],
  };
  const resumed = recoverPlannerResult(result, originalDate, [first]);
  assert.equal(resumed.date, originalDate);
  assert.equal(resumed.selectedIndex, 0);
  assert.equal(resumed.savedCount, 1);
  assert.deepEqual(
    resumed.plans[0].blocks.map((block) => block.title),
    ['pending-second'],
  );
  assert.equal(result.plans[0].blocks.length, 2, 'recovery must preserve the durable result');

  const completed = recoverPlannerResult(result, originalDate, [first, second]);
  assert.equal(
    completed.plans[0].blocks.length,
    0,
    'a reload after all writes must not write duplicates',
  );
  assert.equal(completed.savedCount, 2);

  const conflict = recoverPlannerResult(result, originalDate, [{ ...first, title: '다른 일정' }]);
  assert.equal(
    conflict.plans[0].blocks.length,
    2,
    'a different schedule at the same time is a real conflict',
  );
  const wrongDate = recoverPlannerResult(result, originalDate, [{ ...first, date: '2026-10-02' }]);
  assert.equal(wrongDate.savedCount, 0);
  const wrongSubject = recoverPlannerResult(result, originalDate, [
    { ...first, subjectId: 'another-subject' },
  ]);
  assert.equal(wrongSubject.savedCount, 0);
  assert.throws(() => recoverPlannerResult(result, '2026-10-02', []), /추천 날짜/);
  assert.equal(
    recoverPlannerResult(result, originalDate, [alternative]).selectedIndex,
    1,
    'recover the plan whose persisted blocks identify the previous selection',
  );
  console.log('planner recovery verification passed');
});

const item = (id: string, start: string, end: string, extra: Partial<Schedule> = {}): Schedule => ({
  ...schedule(id, start, end),
  ...extra,
});

test('timetable rows place now, >=60 minute gaps and inline conflicts before the block they precede', () => {
  const day = [
    item('math-1', '07:00', '07:25', { done: true }),
    item('english-1', '08:45', '09:10'),
    item('school', '09:10', '13:30', { kind: 'FIXED' }),
    item('math-2', '13:30', '13:55'),
    item('history-2', '14:05', '14:30'),
    item('bio', '17:00', '18:00'),
    item('academy', '17:30', '19:00', { kind: 'FIXED', title: '영어 학원' }),
    item('math-3', '20:00', '20:25'),
    item('history-3', '20:35', '21:00'),
    item('english-3', '21:10', '21:35'),
    item('bio-3', '21:45', '22:10'),
  ];
  const rows = plannerRows(day, { now: '08:52' });
  const shape = rows.map((row) =>
    row.type === 'item'
      ? row.schedule.id
      : row.type === 'gap'
        ? `gap ${row.start}-${row.end}`
        : row.type,
  );
  assert.deepEqual(shape, [
    'math-1',
    'now',
    'english-1',
    'school',
    'math-2',
    'history-2',
    'gap 14:30-17:00',
    'bio',
    'conflict',
    'academy',
    'gap 19:00-20:00',
    'math-3',
    'history-3',
    'english-3',
    'bio-3',
  ]);
  assert.equal(
    rows.some((row) => row.type === 'gap' && row.start === '07:25'),
    false,
    'a gap that has already passed is not offered for filling',
  );
  assert.equal(rows.find((row) => row.type === 'item' && row.current)?.type, 'item');
  assert.equal(
    (rows.find((row) => row.type === 'item' && row.current) as { schedule: Schedule }).schedule.id,
    'english-1',
  );
  const conflict = rows.find((row) => row.type === 'conflict')!;
  assert.ok(conflict.type === 'conflict');
  assert.equal(conflict.movable?.id, 'bio', 'the self-study block moves, the fixed academy stays');
  assert.equal(conflict.other.id, 'academy');
  assert.equal(conflict.overlap, 30);
  assert.deepEqual(conflict.fix, { start: '19:00', end: '20:00', kind: 'move' });
  assert.equal(
    rows
      .filter((row) => row.type === 'gap')
      .reduce((sum, row) => sum + (row.type === 'gap' ? row.minutes : 0), 0),
    210,
    'free time shown on the CTA is the sum of the listed gaps (3h30m)',
  );

  const afternoon = plannerRows(day, { now: '15:00' });
  const gap = afternoon.find((row) => row.type === 'gap');
  assert.deepEqual(
    gap && gap.type === 'gap' ? [gap.start, gap.end, gap.minutes] : null,
    ['15:00', '17:00', 120],
    'only the unpassed part of a gap counts',
  );
  assert.equal(afternoon.findIndex((row) => row.type === 'now') + 1, afternoon.indexOf(gap!));
  const night = plannerRows(day, { now: '23:00' });
  assert.equal(night.at(-1)?.type, 'now', 'after the last block the line closes the list');
  const otherDay = plannerRows(day);
  assert.equal(
    otherDay.some((row) => row.type === 'now'),
    false,
  );
  assert.deepEqual(
    otherDay.flatMap((row) => (row.type === 'gap' ? [row.minutes] : [])),
    [80, 150, 60],
    'without a clock every gap of at least an hour is listed',
  );
  const schoolOnly = [item('school', '08:30', '16:00', { kind: 'FIXED' })];
  assert.deepEqual(
    plannerRows(schoolOnly).map((row) =>
      row.type === 'gap' ? [row.start, row.end, row.minutes] : row.type,
    ),
    ['item', ['16:00', '22:00', 360]],
    'the evening after school is free time to fill',
  );
  assert.deepEqual(
    plannerRows(schoolOnly, { now: '17:10' }).map((row) =>
      row.type === 'gap' ? `gap ${row.start}` : row.type,
    ),
    ['item', 'now', 'gap 17:10'],
  );
  assert.equal(
    plannerRows([item('late', '20:00', '21:30')]).some((row) => row.type === 'gap'),
    false,
    'less than an hour before 22:00 is not offered',
  );
  assert.equal(plannerRows(schoolOnly, { now: '22:30' }).at(-1)?.type, 'now');
  console.log('schedule review rows verified');
});

test('conflict fixes shrink before the blocker or move to the next time that overlaps nothing', () => {
  const academy = { start: '17:30', end: '19:00' };
  const evening = { start: '19:00', end: '19:40' };
  assert.deepEqual(conflictFixes({ start: '17:00', end: '18:00' }, [academy]), {
    shrink: { start: '17:00', end: '17:30' },
    move: { start: '19:00', end: '20:00' },
  });
  assert.deepEqual(
    conflictFixes({ start: '17:00', end: '18:00' }, [academy, evening]).move,
    { start: '19:40', end: '20:40' },
    'the move skips every other schedule, not only the blocker',
  );
  assert.deepEqual(
    conflictFixes({ start: '18:30', end: '19:30' }, [academy]).shrink,
    { start: '19:00', end: '19:30' },
    'when the start is covered, keep the end instead',
  );
  assert.equal(
    conflictFixes({ start: '17:25', end: '18:00' }, [academy]).shrink,
    undefined,
    'a remainder shorter than 10 minutes is not offered',
  );
  assert.deepEqual(
    conflictFixes({ start: '17:00', end: '17:30' }, [academy]),
    {},
    'touching is not overlapping',
  );
  assert.equal(
    conflictFixes({ start: '22:30', end: '23:30' }, [{ start: '22:00', end: '23:50' }]).move,
    undefined,
    'no move past the end of the day',
  );
  assert.deepEqual(findFreeSlot([academy], 17 * 60, 60), { start: '19:00', end: '20:00' });
  assert.deepEqual(findFreeSlot([academy], 16 * 60, 60), { start: '16:00', end: '17:00' });
  assert.equal(findFreeSlot([{ start: '00:00', end: '23:59' }], 0, 25), null);
  console.log('schedule review fixes verified');
});

test('study progress counts self-study only and particles follow the final consonant', () => {
  const day = [
    item('a', '07:00', '07:25', { done: true }),
    item('b', '07:35', '08:00', { done: true }),
    item('c', '08:10', '08:35', { done: true }),
    item('d', '17:00', '18:00'),
    item('school', '09:00', '13:30', { kind: 'FIXED', done: true }),
  ];
  assert.deepEqual(studyProgress(day), { count: 4, doneCount: 3, minutes: 135, doneMinutes: 75 });
  assert.equal(formatMinutes(310), '5시간 10분');
  assert.equal(formatMinutes(75), '1시간 15분');
  assert.equal(formatMinutes(120), '2시간');
  assert.equal(josa('영어 학원', '과'), '영어 학원과');
  assert.equal(josa('학교', '과'), '학교와');
  assert.equal(josa('복습 우선', '으로'), '복습 우선으로');
  assert.equal(josa('골고루', '으로'), '골고루로');
  assert.equal(josa('서울', '으로'), '서울로', 'ㄹ final takes 로');
  assert.equal(josa('19:00', '으로'), '19:00으로');
  assert.equal(josa('17:00–17:30', '으로'), '17:00–17:30으로');
  assert.equal(josa('3시간 30분', '을'), '3시간 30분을');
  assert.equal(josa('학교', '을'), '학교를');
  assert.equal(josa('Plan B', '으로'), 'Plan B로');
  assert.equal(ceilTime(new Date(2026, 8, 15, 8, 52)), '08:55');
  assert.equal(ceilTime(new Date(2026, 8, 15, 8, 55)), '08:55');
  assert.equal(ceilTime(new Date(2026, 8, 15, 23, 58)), '23:59');
  console.log('schedule review copy verified');
});

test('month grid starts on Monday and recent titles are distinct, newest first', () => {
  const grid = monthGrid('2026-09-15');
  assert.equal(grid[0][0], null, '1 September 2026 is a Tuesday');
  assert.equal(grid[0][1], '2026-09-01');
  assert.equal(grid.flat().filter(Boolean).length, 30);
  assert.ok(grid.every((week) => week.length === 7));
  assert.equal(monthGrid('2026-02-01')[0][6], '2026-02-01', '1 February 2026 is a Sunday');
  const recent = recentSchedules([
    item('old', '09:00', '10:00', { title: '수학', date: '2026-09-01' }),
    item('new', '09:00', '10:00', { title: '수학', date: '2026-09-14' }),
    item('bio', '11:00', '12:00', { title: '생명과학', date: '2026-09-10' }),
    item('blank', '11:00', '12:00', { title: '  ', date: '2026-09-15' }),
  ]);
  assert.deepEqual(
    recent.map((s) => s.id),
    ['new', 'bio'],
  );
  console.log('schedule review pickers verified');
});

test('a new schedule starts where the day frees up, not an hour later', () => {
  const school = item('school', '08:30', '16:00', { kind: 'FIXED' });
  assert.deepEqual(defaultSlot([school]), { start: '16:00', end: '17:00' });
  assert.deepEqual(defaultSlot([school, item('academy', '16:00', '17:30', { kind: 'FIXED' })]), {
    start: '17:30',
    end: '18:30',
  });
  assert.deepEqual(defaultSlot([school], '18:10'), { start: '18:10', end: '19:10' });
  assert.deepEqual(defaultSlot([]), { start: '16:00', end: '17:00' });
  assert.deepEqual(defaultSlot([], '19:20'), { start: '19:20', end: '20:20' });
  assert.deepEqual(
    defaultSlot([item('a', '07:00', '08:00'), item('b', '10:00', '11:00')]),
    { start: '08:00', end: '09:00' },
    'the first free window between schedules comes first',
  );
  console.log('schedule review default slot verified');
});

test('moving a schedule start preserves duration and never wraps into the next day', () => {
  assert.deepEqual(moveScheduleStart({ start: '16:00', end: '17:00' }, '18:00'), {
    start: '18:00',
    end: '19:00',
  });
  assert.deepEqual(moveScheduleStart({ start: '16:00', end: '16:25' }, '15:30'), {
    start: '15:30',
    end: '15:55',
  });
  assert.deepEqual(moveScheduleStart({ start: '16:00', end: '17:00' }, '23:30'), {
    start: '23:30',
    end: '23:59',
  });
});

test('late-night defaults do not silently move a new schedule into the past', () => {
  assert.deepEqual(defaultSlot([], '23:20'), { start: '23:20', end: '23:45' });
  assert.deepEqual(defaultSlot([], '23:50'), { start: '23:50', end: '23:55' });
  assert.deepEqual(defaultSlot([], '23:59'), { start: '23:59', end: '23:59' });
});

test('a 25-minute study gap can be offered without claiming adjacent occupied time', () => {
  const rows = plannerRows(
    [schedule('school', '08:30', '16:00'), schedule('lesson', '16:25', '22:00')],
    { minGap: 25 },
  );
  assert.deepEqual(
    rows.filter((row) => row.type === 'gap'),
    [{ type: 'gap', start: '16:00', end: '16:25', minutes: 25 }],
  );
});

test('draft reconciliation requires the exact saved schedule, including kind and subject', () => {
  const saved = { ...schedule('study', '16:25', '16:50'), subjectId: 'biology' };
  assert.equal(scheduleMatchesDraft(saved, { ...saved, title: ' study ' }), true);
  assert.equal(scheduleMatchesDraft(saved, { ...saved, start: '16:00' }), false);
  assert.equal(scheduleMatchesDraft(saved, { ...saved, subjectId: 'math' }), false);
  assert.equal(scheduleMatchesDraft(saved, { ...saved, kind: 'FIXED' }), false);
  assert.equal(scheduleMatchesDraft(saved, { ...saved, date: '2026-09-16' }), false);
});
