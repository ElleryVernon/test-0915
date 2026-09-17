import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recurrenceError,
  recurringBlocks,
  previewPlan,
  weeklyPlans,
  weeklyInputError,
  planConflict,
  remainingWeeklyNeeds,
  weeklyBatchPayload,
  weeklyDurationOptions,
  type WeeklyInput,
  type PlanBlock,
} from '../src/lib/planner-workspace';
const block: PlanBlock = {
  title: '학원',
  date: '2026-09-21',
  start: '18:00',
  end: '19:00',
  kind: 'FIXED',
};
const input: WeeklyInput = {
  from: '2026-09-21',
  start: '16:00',
  end: '22:00',
  needs: [
    {
      id: 'bio',
      title: '생명과학',
      minutes: 360,
      sessionMinutes: 60,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
  ],
  groups: [],
};
test('semester recurrence is inclusive and picks exact weekdays over year boundaries', () => {
  const rows = recurringBlocks(block, {
    from: '2026-09-21',
    until: '2027-01-10',
    weekdays: [0, 2, 4],
  });
  assert.equal(rows.length, 48);
  assert.equal(rows[0].date, '2026-09-21');
  assert.equal(rows.at(-1)?.date, '2027-01-08');
  assert.equal(new Set(rows.map((r) => r.date)).size, 48);
});
test('recurrence rejects impossible dates, reversed ranges, empty/duplicate weekdays and unbounded periods', () => {
  for (const value of [
    { from: '2026-02-30', until: '2026-03-01', weekdays: [0] },
    { from: '2026-09-21', until: '2026-09-20', weekdays: [0] },
    { from: '2026-09-21', until: '2027-09-21', weekdays: [0] },
    { from: '2026-09-21', until: '2026-10-01', weekdays: [] },
    { from: '2026-09-21', until: '2026-10-01', weekdays: [0, 0] },
  ]) {
    assert.ok(recurrenceError(value));
    assert.deepEqual(recurringBlocks(block, value), []);
  }
});
test('preview separates exact duplicates and real conflicts including differing subject', () => {
  assert.equal(previewPlan([block], [{ ...block }])[0].status, 'existing');
  assert.equal(previewPlan([block], [{ ...block, subjectId: 'another' }])[0].status, 'conflict');
  assert.equal(previewPlan([block], [{ ...block, start: '19:00', end: '20:00' }])[0].status, 'new');
});
test('weekly needs preserve every fixed and flexible event without mutating the input', () => {
  const existing = [
    block,
    { ...block, title: '이미 잡힌 공부', kind: 'FLEXIBLE' as const, start: '16:00', end: '18:00' },
  ];
  const snapshot = JSON.stringify(existing);
  const result = weeklyPlans(input, existing);
  assert.equal(result.error, '');
  assert.ok(result.plans.length >= 2);
  for (const plan of result.plans) {
    assert.equal(plan.allocated, 360);
    assert.deepEqual(plan.unmet, []);
    for (const [i, b] of plan.blocks.entries()) {
      assert.ok(!existing.some((s) => planConflict(s, b)));
      assert.ok(!plan.blocks.slice(0, i).some((s) => planConflict(s, b)));
    }
  }
  assert.equal(JSON.stringify(existing), snapshot);
});
test('academy alternatives choose exactly one option in each group and reject conflicting combinations', () => {
  const result = weeklyPlans(
    {
      ...input,
      needs: [],
      groups: [
        {
          id: 'math',
          title: '수학',
          options: [
            { id: 'm', title: '월수금', weekdays: [0, 2, 4], start: '18:00', end: '20:00' },
          ],
        },
        {
          id: 'science',
          title: '과학',
          options: [
            { id: 's1', title: '화목금', weekdays: [1, 3, 4], start: '19:00', end: '21:00' },
            { id: 's2', title: '월금토', weekdays: [0, 4, 5], start: '20:00', end: '22:00' },
          ],
        },
      ],
    },
    [],
  );
  assert.equal(result.rejected, 1);
  assert.equal(result.plans.length, 1);
  assert.deepEqual(result.plans[0].choices, ['수학: 월수금', '과학: 월금토']);
  assert.equal(result.plans[0].blocks.length, 6);
});
test('reports unallocated duration rather than extending availability or inventing success', () => {
  const result = weeklyPlans(
    {
      ...input,
      start: '16:00',
      end: '17:00',
      needs: [{ ...input.needs[0], weekdays: [0], minutes: 180 }],
    },
    [],
  );
  assert.equal(result.plans[0].allocated, 60);
  assert.deepEqual(result.plans[0].unmet, [{ title: '생명과학', minutes: 120, needId: 'bio' }]);
});
test('two social sessions can be required on distinct days, not silently same-day', () => {
  const result = weeklyPlans(
    {
      ...input,
      needs: [
        {
          id: 'social',
          title: '친구 약속',
          minutes: 240,
          sessionMinutes: 120,
          weekdays: [5, 6],
          differentDays: true,
        },
      ],
    },
    [],
  );
  for (const plan of result.plans) {
    assert.equal(plan.blocks.length, 2);
    assert.equal(new Set(plan.blocks.map((b) => b.date)).size, 2);
    assert.equal(plan.allocated, 240);
  }
});
test('elapsed times are not offered; all-days academy option cannot silently lose a passed day', () => {
  const now = { date: '2026-09-23', time: '17:07' };
  const result = weeklyPlans(input, [], now);
  for (const plan of result.plans)
    for (const b of plan.blocks) {
      assert.ok(b.date >= now.date);
      if (b.date === now.date) assert.ok(b.start >= '17:15');
    }
  const past = weeklyPlans(
    {
      ...input,
      needs: [],
      groups: [
        {
          id: 'g',
          title: '학원',
          options: [
            { id: 'o', title: '월수금', weekdays: [0, 2, 4], start: '18:00', end: '20:00' },
          ],
        },
      ],
    },
    [],
    now,
  );
  assert.equal(past.plans.length, 0);
  assert.equal(past.rejected, 1);
});
test('guardrails reject invalid time windows, fractional hours and excessive alternatives', () => {
  assert.ok(weeklyInputError({ ...input, end: '24:00' }));
  assert.ok(
    weeklyInputError({ ...input, needs: [{ ...input.needs[0], minutes: 90, sessionMinutes: 60 }] }),
  );
  assert.ok(weeklyInputError({ ...input, needs: [], groups: [] }));
});
test('batch limit never produces more than 200 writable rows and unmet time remains visible', () => {
  const result = weeklyPlans(
    {
      ...input,
      start: '00:00',
      end: '23:59',
      needs: [
        { ...input.needs[0], minutes: 2400, sessionMinutes: 15 },
        { ...input.needs[0], id: 'n2', minutes: 2400, sessionMinutes: 15 },
      ],
    },
    [],
  );
  for (const plan of result.plans) {
    assert.ok(plan.blocks.length <= 200);
    assert.ok(plan.unmet.length);
    assert.equal(plan.allocated + plan.unmet.reduce((n, u) => n + u.minutes, 0), 4800);
  }
});
test('partially saved distinct-day goals retain occupied days across later proposals', () => {
  const social: WeeklyInput = {
    ...input,
    needs: [
      {
        id: 'social',
        title: '친구 약속',
        minutes: 240,
        sessionMinutes: 120,
        weekdays: [5, 6],
        differentDays: true,
      },
    ],
  };
  const blocked: PlanBlock[] = [{ ...block, date: '2026-09-27', start: '16:00', end: '22:00' }];
  const first = weeklyPlans(social, blocked).plans[0];
  assert.equal(first.allocated, 120);
  const remaining = remainingWeeklyNeeds(social.needs, first);
  assert.deepEqual(remaining[0].scheduledDates, ['2026-09-26']);
  assert.equal(remaining[0].minutes, 120);
  const retry = weeklyPlans({ ...social, needs: remaining }, [...blocked, ...first.blocks]);
  assert.ok(retry.plans.every((plan) => plan.allocated === 0));
  const expanded = weeklyPlans({ ...social, needs: [{ ...remaining[0], weekdays: [4, 5, 6] }] }, [
    ...blocked,
    ...first.blocks,
  ]);
  assert.ok(
    expanded.plans.every(
      (plan) => plan.blocks.length === 1 && plan.blocks[0].date === '2026-09-25',
    ),
  );
});
test('remaining goals only inherit dates from their own blocks, even with identical names', () => {
  const source = {
    ...input,
    needs: [
      {
        ...input.needs[0],
        id: 'one',
        title: '공부',
        minutes: 180,
        weekdays: [0],
        differentDays: true,
      },
      {
        ...input.needs[0],
        id: 'two',
        title: '공부',
        minutes: 180,
        weekdays: [1],
        differentDays: true,
      },
    ],
  };
  const plan = weeklyPlans(source, []).plans[0];
  const remaining = remainingWeeklyNeeds(source.needs, plan);
  assert.deepEqual(
    remaining.map((need) => need.scheduledDates),
    [['2026-09-21'], ['2026-09-22']],
  );
});
test('recovery snapshot survives serialization and replays the original API payload without need metadata', () => {
  const source = { ...input, needs: [{ ...input.needs[0], minutes: 120 }] };
  const original = weeklyPlans(source, []).plans[0];
  const snapshot = JSON.parse(JSON.stringify({ input: source, plan: original }));
  // Recomputing against a committed batch would duplicate the goal in other time slots.
  const recomputed = weeklyPlans(source, original.blocks).plans[0];
  assert.notDeepEqual(weeklyBatchPayload(recomputed), weeklyBatchPayload(original));
  assert.deepEqual(weeklyBatchPayload(snapshot.plan), weeklyBatchPayload(original));
  assert.ok(weeklyBatchPayload(snapshot.plan).blocks.every((b) => !('needId' in b)));
  assert.deepEqual(remainingWeeklyNeeds(snapshot.input.needs, snapshot.plan), []);
});
test('partial duration remains visible even when it is not one of the initial total-hour presets', () => {
  const source = {
    ...input,
    start: '16:00',
    end: '17:30',
    needs: [{ ...input.needs[0], sessionMinutes: 90, weekdays: [0] }],
  };
  const plan = weeklyPlans(source, []).plans[0];
  const [remaining] = remainingWeeklyNeeds(source.needs, plan);
  assert.equal(remaining.minutes, 270);
  const options = weeklyDurationOptions(remaining.minutes);
  assert.ok(options.includes(270));
  assert.equal(new Set(options).size, options.length);
  assert.deepEqual(
    options,
    [...options].sort((a, b) => a - b),
  );
});
