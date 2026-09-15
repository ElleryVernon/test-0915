import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { between, cooldown, fullJitter, retryDelay, sleep } from '../src/lib/jitter';
import { LOGIN_BUSY_MAX_SECONDS, loginBusyRetryAt, secondsLeft } from '../src/lib/retry-countdown';

const top = () => 1 - 2 ** -53;

test('between, fullJitter, retryDelay and cooldown have the designed ranges', () => {
  assert.equal(between(0, 10, () => 0), 0);
  assert.ok(between(0, 10, top) < 10);
  for (const [lo, hi] of [[10_000, 20_000], [1875, 3125], [0, 2500], [-5, 0], [30_000, 60_000]])
    assert.ok(between(lo, hi, top) < hi && between(lo, hi, top) >= lo, `[${lo}, ${hi}) holds at r→1 (no rounding up to hi)`);
  assert.equal(between(5, 5), 5);
  assert.equal(between(5, 3), 5);
  assert.equal(fullJitter(0, 2000, 60000, () => 0.5), 1000);
  assert.equal(fullJitter(5, 2000, 60000, () => 0.5), 30000);
  assert.equal(fullJitter(1100, 2000, 60000, () => 0.5), 30000, 'a huge attempt stays at the cap (not NaN)');
  assert.equal(fullJitter(-3, 2000, 60000, () => 0.5), 1000, 'a negative attempt is attempt 0');
  assert.equal(retryDelay(4000, null), 4000);
  assert.equal(retryDelay(4000, 30000, () => 0.5), 30500, 'never before the hint, plus smoothing');
  assert.equal(retryDelay(40000, 30000, () => 0.5), 40000, 'a longer backoff wins');
  assert.equal(cooldown({ status: 429 }, () => 0), 10000, 'a 429 without a hint waits 10–20 s');
  assert.ok(cooldown({ status: 429 }, top) < 20000);
  assert.equal(cooldown({ status: 503, retryAfterMs: 7000 }, () => 0), 7000);
  assert.equal(cooldown({ status: 503 }), 0);
  assert.equal(cooldown({ status: 429, code: 'AI_UNAVAILABLE' }), 0, 'a service that is off offers no timed retry');
  assert.equal(cooldown({ status: 503, code: 'PROVIDER_OFF' }), 0);
  assert.equal(cooldown({ status: 400 }), 0);
  // 100 000 draws from Math.random stay in range with the mean at the midpoint.
  let sum = 0;
  for (let i = 0; i < 100_000; i++) {
    const d = between(10_000, 20_000);
    assert.ok(d >= 10_000 && d < 20_000);
    sum += d;
  }
  assert.ok(Math.abs(sum / 100_000 - 15_000) < 150, 'uniform: mean at the midpoint within 1%');
});

test('a refused OAuth start waits what the server said, never more than the sign-in window allows', () => {
  const now = 1_000_000;
  assert.equal(loginBusyRetryAt('42', () => 0, now), now + 42_000);
  assert.equal(loginBusyRetryAt('999999999', () => 0, now), now + LOGIN_BUSY_MAX_SECONDS * 1000, 'a crafted link cannot lock sign-in');
  assert.ok(LOGIN_BUSY_MAX_SECONDS <= 90 && secondsLeft(loginBusyRetryAt('999999999', top, now), now) <= 91);
  assert.equal(loginBusyRetryAt('1e9', () => 0, now), now + 10_000, 'not digits: the 429 fallback');
  assert.equal(loginBusyRetryAt(null, () => 0, now), now + 10_000);
  assert.equal(loginBusyRetryAt('-5', () => 0, now), now + 10_000);
});

test('sleep resolves at exactly ms and an abort clears its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let done = false;
  const waiting = sleep(1000).then(() => (done = true));
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(done, false, 'not before ms');
  t.mock.timers.tick(1);
  await waiting;
  assert.equal(done, true, 'at exactly ms');
  const cleared = mock.method(globalThis, 'clearTimeout');
  const controller = new AbortController();
  const aborted = sleep(1000, controller.signal);
  t.mock.timers.tick(500);
  controller.abort(new Error('stopped by the learner'));
  await assert.rejects(aborted, /stopped by the learner/);
  assert.equal(cleared.mock.callCount(), 1, 'the abort clears the pending timer');
  cleared.mock.restore();
  await assert.rejects(sleep(10, controller.signal), /stopped by the learner/, 'an aborted signal rejects at once');
  console.log('JITTER_TS_OK');
});
