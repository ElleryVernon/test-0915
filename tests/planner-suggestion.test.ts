import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeAiTask,
  clearAiTasks,
  findAiTask,
  inspectAiTask,
  listAiTasks,
  markAiTaskSeen,
  runAiTask,
} from '../src/lib/ai-task';
import {
  readyToast,
  suggestionState,
  type PlannerResult,
  type PlannerTask,
} from '../src/components/social/planner-suggestion';
import type { Schedule } from '../src/lib/contracts';

const DAY = '2026-09-17';
const TODAY = '2026-09-17';
const block = (start: string, end: string, date = DAY) => ({
  title: `${start} 복습`,
  date,
  start,
  end,
  kind: 'FLEXIBLE' as const,
  subjectId: 'bio',
  done: false,
});
const result: PlannerResult = {
  plans: [
    { name: '복습 우선', reason: '카드가 가장 많아요', blocks: [block('17:00', '17:25'), block('17:35', '18:00')] },
    { name: '골고루', blocks: [block('18:10', '18:35')] },
  ],
  method: '규칙 기반 일정 추천',
};
const school: Schedule = { id: 's1', title: '학교', date: DAY, start: '08:40', end: '16:00', kind: 'FIXED', done: false };
const task = (overrides: Partial<PlannerTask> = {}): PlannerTask => ({
  key: 'k',
  userId: 'u',
  endpoint: '/planner/suggest',
  payload: { date: DAY },
  requestId: 'r1',
  status: 'COMPLETED',
  result,
  error: null,
  acknowledged: false,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});
const at = (now: string, schedules: Schedule[] = [school], today = TODAY) => ({ today, now, schedules });

test('a stored suggestion is ready until it is seen, then only the button brings it back', () => {
  assert.deepEqual(suggestionState(task(), at('16:30')), { kind: 'ready', date: DAY });
  assert.deepEqual(suggestionState(task({ seenAt: 1 }), at('16:30')), { kind: 'seen', date: DAY });
  // A future day never goes stale by the clock.
  const tomorrow = { plans: [{ name: '복습 우선', blocks: [block('17:00', '17:25', '2026-09-18')] }] };
  assert.equal(suggestionState(task({ payload: { date: '2026-09-18' }, result: tomorrow }), at('23:50')).kind, 'ready');
});

test('a finished request is toasted only on its own day; other days get the notice row instead', () => {
  assert.equal(readyToast('2026-09-17', '2026-09-17', '2026-09-17'), '빈 시간 추천이 준비됐어요');
  assert.equal(readyToast('2026-09-19', '2026-09-19', '2026-09-17'), '9월 19일 토 추천이 준비됐어요');
  assert.equal(readyToast('2026-09-19', '2026-09-17', '2026-09-17'), null);
});

test('running requests are polled, failed or unconfirmed ones stay quiet', () => {
  assert.deepEqual(suggestionState(task({ status: 'RUNNING', result: null }), at('16:30')), { kind: 'running', date: DAY });
  for (const status of ['FAILED', 'INTERRUPTED', 'READY'] as const)
    assert.equal(suggestionState(task({ status, result: null }), at('16:30')).kind, 'quiet', status);
});

test('a past day is stale whatever its status', () => {
  for (const status of ['COMPLETED', 'RUNNING', 'FAILED'] as const)
    assert.deepEqual(suggestionState(task({ status, payload: { date: '2026-09-16' } }), at('09:00')), {
      kind: 'stale',
      date: '2026-09-16',
      reason: 'past',
    });
  assert.equal(suggestionState(task({ payload: { date: 'soon' } }), at('09:00')).kind, 'stale');
});

test('nothing left to add is stale: empty plans or every block already saved', () => {
  const empty = task({ result: { plans: [{ name: '복습 우선', blocks: [] }, { name: '골고루', blocks: [] }] } });
  assert.deepEqual(suggestionState(empty, at('16:30')), { kind: 'stale', date: DAY, reason: 'empty' });
  const saved = [...result.plans.flatMap((plan) => plan.blocks)].map((b, i) => ({ ...b, id: `saved-${i}` }));
  assert.equal(suggestionState(task(), at('16:30', [school, ...saved])).kind, 'stale');
  assert.equal(suggestionState(task({ result: null }), at('16:30')).kind, 'stale');
});

test("today's suggestion goes stale once any of its time has begun", () => {
  assert.equal(suggestionState(task(), at('16:59')).kind, 'ready');
  assert.equal(suggestionState(task(), at('17:00')).kind, 'ready', 'a block starting this minute can still be added');
  assert.deepEqual(suggestionState(task(), at('17:01')), { kind: 'stale', date: DAY, reason: 'started' });
  assert.equal(suggestionState(task(), at('17:40')).kind, 'stale');
});

test('a schedule that takes suggested time makes it stale; saved blocks and other days do not', () => {
  const overlap: Schedule = { id: 'o', title: '학원', date: DAY, start: '17:10', end: '17:30', kind: 'FIXED', done: false };
  assert.deepEqual(suggestionState(task(), at('16:30', [school, overlap])), { kind: 'stale', date: DAY, reason: 'conflict' });
  const touching: Schedule = { ...overlap, start: '16:30', end: '17:00' };
  assert.equal(suggestionState(task(), at('16:10', [school, touching])).kind, 'ready', 'ending as a block starts is not an overlap');
  const otherDay: Schedule = { ...overlap, date: '2026-09-18' };
  assert.equal(suggestionState(task(), at('16:30', [school, otherDay])).kind, 'ready');
  // One block was already saved from this result: it is not a conflict with itself.
  const savedFirst: Schedule = { ...result.plans[0].blocks[0], id: 'saved' };
  assert.equal(suggestionState(task(), at('16:30', [school, savedFirst])).kind, 'ready');
});

test('seen time is recorded once, survives older status copies, and never carries to a new request', async () => {
  const originalFetch = globalThis.fetch;
  const userId = 'planner-seen-user';
  const other = 'planner-other-user';
  const endpoint = '/planner/suggest' as const;
  await clearAiTasks(userId);
  await clearAiTasks(other);
  const records = new Map<string, { requestId: string; status: string; result: unknown; error: null; updatedAt: string }>();
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      records.set(body.requestId, { requestId: body.requestId, status: 'COMPLETED', result, error: null, updatedAt: new Date().toISOString() });
      return Response.json({ data: result });
    }
    const record = records.get(String(input).split('/').pop()!);
    return record ? Response.json({ data: record }) : Response.json({ error: 'missing' }, { status: 404 });
  };
  try {
    const first = { date: '2099-01-10' };
    const second = { date: '2099-01-11' };
    await runAiTask({ userId, endpoint, payload: first });
    await new Promise((r) => setTimeout(r, 5));
    await runAiTask({ userId, endpoint, payload: second });
    await runAiTask({ userId: other, endpoint, payload: first });
    await runAiTask({ userId, endpoint: '/generate', payload: { materialId: 'm', mode: 'quiz', count: 1 } });
    const listed = await listAiTasks<PlannerResult>({ userId, endpoint });
    assert.deepEqual(listed.map((t) => t.payload.date), ['2099-01-11', '2099-01-10'], 'own planner tasks only, newest first');
    assert.equal((await listAiTasks({ userId, endpoint, match: { date: '2099-01-11' } })).length, 1);

    const olderCopy = listed[1];
    const seen = await markAiTaskSeen({ userId, endpoint, payload: first });
    assert.ok(seen?.seenAt, 'seen time recorded');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await markAiTaskSeen({ userId, endpoint, payload: first }))?.seenAt, seen.seenAt, 'recorded once');
    await inspectAiTask(olderCopy);
    assert.equal((await findAiTask({ userId, endpoint, payload: first }))?.seenAt, seen.seenAt, 'a status update from an older copy keeps it');

    await acknowledgeAiTask({ userId, endpoint, payload: first });
    assert.deepEqual((await listAiTasks({ userId, endpoint })).map((t) => t.payload.date), ['2099-01-11'], 'acknowledged work leaves the list');
    await runAiTask({ userId, endpoint, payload: first });
    const fresh = await findAiTask({ userId, endpoint, payload: first });
    assert.ok(fresh && fresh.requestId !== seen.requestId, 'a new request under the same key');
    assert.equal(fresh?.seenAt, undefined, 'a new request is not seen yet');
  } finally {
    globalThis.fetch = originalFetch;
    await clearAiTasks(userId);
    await clearAiTasks(other);
  }
  console.log('PLANNER_SUGGESTION_VERIFIED');
});
