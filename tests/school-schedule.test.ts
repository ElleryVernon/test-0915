import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSchoolTime,
  previewSchoolRegistration,
  schoolPeriodEnd,
  schoolRegistrationError,
  type SchoolRegistration,
} from '../src/lib/school-schedule';
import type { Schedule } from '../src/lib/contracts';
const form: SchoolRegistration = {
  title: '학교',
  from: '2026-09-17',
  weeks: 1,
  weekdays: [0, 1, 2, 3, 4],
  hours: { start: '08:30', end: '16:00' },
  differentHours: false,
  byDay: {},
};
const today = '2026-09-16';
test('school time input accepts quick digits without inventing invalid hours', () => {
  for (const [input, expected] of [
    ['830', '08:30'],
    ['0830', '08:30'],
    ['8:30', '08:30'],
    ['2359', '23:59'],
    ['2400', ''],
    ['0860', ''],
    ['83', ''],
    ['8:3', ''],
  ])
    assert.equal(normalizeSchoolTime(input), expected);
});
test('one week means seven dates from the chosen date, including crossing a year', () => {
  assert.equal(schoolPeriodEnd(form), '2026-09-23');
  assert.deepEqual(
    previewSchoolRegistration(form, [], today).map((row) => row.date),
    ['2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23'],
  );
  assert.equal(schoolPeriodEnd({ ...form, from: '2026-12-30' }), '2027-01-05');
  assert.equal(previewSchoolRegistration({ ...form, weeks: 4 }, [], today).length, 20);
});
test('weekday-specific hours and weekend attendance generate only the selected intervals', () => {
  const rows = previewSchoolRegistration(
    {
      ...form,
      weekdays: [2, 5],
      differentHours: true,
      byDay: { 2: { start: '815', end: '1430' } },
    },
    [],
    today,
  );
  assert.deepEqual(
    rows.map(({ date, start, end }) => ({ date, start, end })),
    [
      { date: '2026-09-19', start: '08:30', end: '16:00' },
      { date: '2026-09-23', start: '08:15', end: '14:30' },
    ],
  );
});
test('registration distinguishes existing school blocks, conflicts, and a free boundary', () => {
  const values: Schedule[] = [
    {
      id: 'school',
      date: '2026-09-17',
      title: '학교',
      start: '08:30',
      end: '16:00',
      kind: 'FIXED',
      done: false,
    },
    {
      id: 'lesson',
      date: '2026-09-18',
      title: '학원',
      start: '15:00',
      end: '17:00',
      kind: 'FIXED',
      done: false,
    },
    {
      id: 'adjacent',
      date: '2026-09-21',
      title: '복습',
      start: '16:00',
      end: '17:00',
      kind: 'FLEXIBLE',
      done: false,
    },
  ];
  assert.deepEqual(
    previewSchoolRegistration(form, values, today).map((row) => row.status),
    ['existing', 'conflict', 'new', 'new', 'new'],
  );
  assert.equal(previewSchoolRegistration(form, values, today)[1].conflicts[0].title, '학원');
});
test('invalid or empty registration never produces writable dates', () => {
  for (const patch of [
    { weekdays: [] },
    { from: '2026-02-30' },
    { from: '2026-09-15' },
    { hours: { start: '1600', end: '0830' } },
    { differentHours: true, byDay: { 3: { start: '8', end: '1600' } } },
  ]) {
    const invalid = { ...form, ...patch };
    assert.ok(schoolRegistrationError(invalid, today));
    assert.deepEqual(previewSchoolRegistration(invalid, [], today), []);
  }
});
