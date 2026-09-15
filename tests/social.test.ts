import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import type { AppData, Post, Schedule } from '../src/lib/contracts';
import { recoverPlannerResult } from '../src/components/social/planner';
import {
  dateKey,
  durationLabel,
  relativeTime,
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
