import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/lib/api';
import { cancelSync, pendingReviews, queueReview, syncNow, syncReviews, syncSoon } from '../src/lib/offline';
import type { Card } from '../src/lib/contracts';

const top = () => 1 - 2 ** -53;
const card: Card = {
  id: 'card-1',
  subjectId: 'subject-1',
  front: '삼투가 일어나는 조건은?',
  back: '선택적 투과성 막과 농도 차이',
  type: 'CONCEPT',
  bucket: 'AGAIN',
  consecutiveEasy: 0,
  nextReviewAt: new Date(0).toISOString(),
  deleted: false,
};
let online = true;
Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => online });

// IndexedDB (fake-indexeddb) runs on setImmediate, which the mocked timers leave alone.
const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
};

/** A device with one queued review and a send that follows a script of failures. */
async function device(userId: string, script: unknown[] = []) {
  await queueReview(userId, card, 'GOOD', `${userId}-review`);
  const sends: number[] = [];
  const errors: unknown[] = [];
  const plan = [...script];
  const run = async () => {
    sends.push(Date.now());
    const next = plan.shift();
    if (next) throw next;
  };
  return { sends, errors, run, onError: (e: unknown) => errors.push(e) };
}

test('the review sync scheduler: window, cancel, backoff, Retry-After floor and permanent stops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const advance = async (ms: number, step = 100) => {
    for (let at = 0; at < ms; at += step) {
      await settle();
      t.mock.timers.tick(Math.min(step, ms - at));
    }
    await settle();
  };
  // A window of 10 s at rand 0.5: nothing at 4999 ms, the send at 5000 ms.
  let d = await device('u-window');
  syncSoon('u-window', d.run, { windowMs: 10_000, rand: () => 0.5 });
  await advance(4999, 1);
  assert.equal(d.sends.length, 0, 'not before the drawn point');
  await advance(1, 1);
  assert.deepEqual(d.sends, [5000]);
  // Cancelled at 3 s: nothing is sent.
  const cancelled = await device('u-cancel');
  const t0 = Date.now();
  syncSoon('u-cancel', cancelled.run, { windowMs: 10_000, rand: () => 0.5 });
  await advance(3000);
  cancelSync('u-cancel');
  await advance(20_000, 500);
  assert.equal(cancelled.sends.length, 0, `cancelled at ${Date.now() - t0 - 20_000} ms: zero sends`);
  // Two calls inside the window make one drain (the earlier point wins).
  d = await device('u-twice');
  const t1 = Date.now();
  syncSoon('u-twice', d.run, { windowMs: 10_000, rand: () => 0.2 });
  syncSoon('u-twice', d.run, { windowMs: 10_000, rand: () => 0.9 });
  await advance(12_000, 250);
  assert.deepEqual(d.sends.map((s) => s - t1), [2000], 'one drain, at the earlier point');
  // A 503 with a 30 s hint: the next send is 30 s + 0.5 s later (rand 0.5), not at the 2 s backoff.
  d = await device('u-hinted', [new ApiError('잠시 후', 503, null, 30_000)]);
  const t2 = Date.now();
  await syncNow('u-hinted', d.run, { onError: d.onError, rand: () => 0.5 });
  await advance(31_000, 250);
  assert.deepEqual(d.sends.map((s) => s - t2), [0, 30_500]);
  // Six network failures in a row: full jitter under caps of 4, 8, 16, 32, 60 and 60 s — exactly
  // half of each at rand 0.5, and at most the cap at rand → 1.
  for (const [rand, check] of [
    [() => 0.5, (gap: number, cap: number) => gap === cap / 2],
    [top, (gap: number, cap: number) => gap <= cap && gap > cap - 1000],
  ] as const) {
    const id = `u-backoff-${rand()}`;
    d = await device(id, Array.from({ length: 6 }, () => new TypeError('fetch failed')));
    await syncNow(id, d.run, { onError: d.onError, rand });
    await advance(185_000, 100);
    const gaps = d.sends.slice(1).map((s, i) => s - d.sends[i]);
    assert.equal(gaps.length, 6, `six retries (${gaps})`);
    for (const [i, cap] of [4000, 8000, 16_000, 32_000, 60_000, 60_000].entries())
      assert.ok(check(gaps[i], cap), `gap ${i + 1} under the ${cap} ms cap at rand ${rand()} (${gaps[i]})`);
  }
  // A 409 is permanent: no timer, onError once, the queue untouched.
  d = await device('u-permanent', [new ApiError('이미 기록된 복습이에요.', 409)]);
  await syncNow('u-permanent', d.run, { onError: d.onError });
  await advance(120_000, 1000);
  assert.equal(d.sends.length, 1, 'no retry of a permanent refusal');
  assert.equal(d.errors.length, 1);
  assert.equal((await pendingReviews('u-permanent')).length, 1, 'the queue is untouched');
  // TypeError, success, TypeError: the attempt count resets after a success.
  d = await device('u-reset', [new TypeError('a'), undefined, new TypeError('b')]);
  await syncNow('u-reset', d.run, { onError: d.onError, rand: top });
  await advance(5000, 100);
  await syncNow('u-reset', d.run, { onError: d.onError, rand: top });
  const third = Date.now();
  await advance(5000, 100);
  assert.equal(d.sends.length, 4);
  assert.ok(d.sends[3] - third <= 4000, `after a success the backoff starts over (${d.sends[3] - third} ms)`);
  // A timer that fires with nothing pending sends nothing; offline sends nothing.
  const empty = { sends: [] as number[], run: async () => void empty.sends.push(Date.now()) };
  syncSoon('u-empty', empty.run, { windowMs: 1000, rand: () => 0.5 });
  await advance(2000, 100);
  assert.equal(empty.sends.length, 0, 'no pending reviews: no send');
  d = await device('u-offline');
  online = false;
  syncSoon('u-offline', d.run, { windowMs: 1000, rand: () => 0.5 });
  await advance(2000, 100);
  online = true;
  assert.equal(d.sends.length, 0, 'offline: no send');
  // syncNow while a backoff timer is armed sends at once and clears the timer.
  d = await device('u-now', [new TypeError('a')]);
  await syncNow('u-now', d.run, { onError: d.onError, rand: top });
  const armed = Date.now();
  await advance(500, 100);
  await syncNow('u-now', d.run, { onError: d.onError, rand: top });
  assert.equal(d.sends.length, 2);
  assert.ok(d.sends[1] - armed <= 600, 'sent at once');
  await advance(10_000, 500);
  assert.equal(d.sends.length, 2, 'the armed backoff timer was cleared');
  console.log('SYNC_SCHEDULER_OK');
});

test('the scheduler: a cancel stops an attempt in flight, and callers joining one drain count its failure once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const advance = async (ms: number, step = 100) => {
    for (let at = 0; at < ms; at += step) {
      await settle();
      t.mock.timers.tick(Math.min(step, ms - at));
    }
    await settle();
  };
  // Cancelled (the screen unmounted) while its send is in flight: the late 503 arms no retry.
  await queueReview('u-inflight', card, 'GOOD', 'u-inflight-review');
  const sends: number[] = [];
  let reject!: (e: unknown) => void;
  const attempt = syncNow('u-inflight', () => {
    sends.push(Date.now());
    return new Promise((_, no) => (reject = no));
  }, { rand: () => 0.5 });
  await settle();
  cancelSync('u-inflight');
  reject(new ApiError('잠시 후', 503));
  await attempt;
  await advance(120_000, 1000);
  assert.equal(sends.length, 1, `no retry after the cancel (${sends})`);
  // Two syncNow calls while one drain is in flight share syncReviews' single drain: its one network
  // failure is reported once and the first retry uses the first backoff step (under 4 s).
  const userId = 'u-joined';
  await queueReview(userId, card, 'GOOD', `${userId}-review`);
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const run = () =>
    syncReviews(userId, async () => {
      calls++;
      if (calls === 1) {
        await held;
        throw new TypeError('fetch failed');
      }
      return card;
    });
  const errors: unknown[] = [];
  const a = syncNow(userId, run, { onError: (e) => errors.push(e), rand: top });
  const b = syncNow(userId, run, { onError: (e) => errors.push(e), rand: top });
  await settle();
  const failedAt = Date.now();
  release();
  await Promise.all([a, b]);
  assert.equal(errors.length, 1, 'one failure, reported once');
  await advance(5_000, 100);
  assert.equal(calls, 2, 'one retry');
  assert.ok(Date.now() - failedAt >= 4_000 && (await pendingReviews(userId)).length === 0, 'the retry sent the review');
  console.log('SYNC_SCHEDULER_JOIN_OK');
});

test('room simulation: 50 devices whose Wi-Fi comes back together start over the 10 s window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const room = async (windowMs: number) => {
    const firsts: number[] = [];
    const start = Date.now();
    for (let i = 0; i < 50; i++) {
      const userId = `room-${windowMs}-${i}`;
      await queueReview(userId, card, 'GOOD', `${userId}-review`);
      syncSoon(userId, async () => void firsts.push(Date.now() - start), { windowMs, rand: () => (i + 0.5) / 50 });
    }
    for (let at = 0; at <= 11_000; at += 50) {
      await settle();
      t.mock.timers.tick(50);
    }
    await settle();
    return firsts;
  };
  const spread = await room(10_000);
  assert.equal(spread.length, 50);
  assert.ok(!spread.some((at) => at === 0), 'none at t=0');
  const buckets = new Map<number, number>();
  for (const at of spread) buckets.set(Math.floor(at / 1000), (buckets.get(Math.floor(at / 1000)) ?? 0) + 1);
  assert.ok(Math.max(...buckets.values()) <= 5, `no 1 s bucket above 5 (${[...buckets.values()]})`);
  const expected = Array.from({ length: 50 }, (_, i) => (i + 0.5) * 200);
  // Measured at the 50 ms tick that fires it (IndexedDB answers between ticks).
  const sorted = [...spread].sort((a, b) => a - b);
  assert.ok(sorted.every((at, i) => at >= expected[i] - 1e-6 && at <= expected[i] + 50), `device i starts at (i + 0.5)·200 ms (${sorted.slice(0, 6)}…)`);
  // Control: without the window every device drains in the same instant.
  const together = await room(0);
  assert.equal(together.filter((at) => at < 100).length, 50, 'without a window all 50 start at once');
  console.log('ROOM_SPREAD_OK');
});
