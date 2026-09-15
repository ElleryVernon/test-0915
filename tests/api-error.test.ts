import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, parseRetryAfter, retryTransient, transient } from '../src/lib/api';

test('parseRetryAfter prefers the body, reads seconds and dates, and clamps', () => {
  const now = Date.UTC(2026, 8, 16, 0, 50);
  assert.equal(parseRetryAfter('15', undefined), 15000);
  assert.equal(parseRetryAfter(new Date(now + 30_000).toUTCString(), undefined, now), 30000);
  assert.equal(parseRetryAfter('-3', undefined), null);
  assert.equal(parseRetryAfter('soon', undefined), null);
  assert.equal(parseRetryAfter(null, undefined), null);
  assert.equal(parseRetryAfter(new Date(now - 30_000).toUTCString(), undefined, now), null, 'a date in the past');
  assert.equal(parseRetryAfter('7', 6400), 6400, 'the millisecond body beats the whole-second header');
  assert.equal(parseRetryAfter(null, 90_000_000), 86_400_000, 'clamped to a day');
  assert.equal(parseRetryAfter('7', -1), 7000, 'a negative body value is ignored');
});

test('api() throws ApiError with the status, code and wait; other failures keep their type', async () => {
  const original = globalThis.fetch;
  let next: () => Promise<Response> = async () => Response.json({ data: 1 });
  globalThis.fetch = async () => next();
  try {
    next = async () =>
      Response.json({ error: '요청이 많아요. 잠시 후 다시 시도해 주세요.' }, { status: 429, headers: { 'Retry-After': '15' } });
    await assert.rejects(api('/generate', {}), (e: unknown) => e instanceof ApiError && e.status === 429 && e.retryAfterMs === 15000 && e.message === '요청이 많아요. 잠시 후 다시 시도해 주세요.');
    next = async () => Response.json({ error: 'AI 연결이 준비되지 않았어요.', code: 'AI_UNAVAILABLE' }, { status: 503 });
    await assert.rejects(api('/generate', {}), (e: unknown) => e instanceof ApiError && e.code === 'AI_UNAVAILABLE' && e.retryAfterMs === null);
    next = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(api('/bootstrap'), (e: unknown) => e instanceof TypeError);
    next = async () => new Response('<html>Service Unavailable</html>', { status: 503, headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(api('/bootstrap'), (e: unknown) => e instanceof ApiError && e.status === 503 && e.retryAfterMs === null && e.message === '응답을 읽을 수 없어요. 다시 시도해 주세요.');
    next = async () => Response.json({ error: '로그인이 필요해요.' }, { status: 401 });
    await assert.rejects(api('/bootstrap'), (e: unknown) => e instanceof ApiError && e.message.includes('로그인'));
  } finally {
    globalThis.fetch = original;
  }
  for (const status of [400, 401, 404, 409]) assert.equal(transient(new ApiError('x', status)), false, `${status} is permanent`);
  for (const status of [408, 429, 500, 503]) assert.equal(transient(new ApiError('x', status)), true, `${status} may pass`);
  assert.equal(transient(new TypeError('fetch failed')), true);
  assert.equal(transient(new DOMException('timed out', 'TimeoutError')), true);
  assert.equal(transient(new Error('plain')), false);
});

test('retryTransient retries only transient failures, with full jitter floored by Retry-After', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const run = async (failures: unknown[], until = 60_000) => {
    const calls: number[] = [];
    let outcome: unknown = 'pending';
    const plan = [...failures];
    retryTransient(
      async () => {
        calls.push(Date.now());
        if (plan.length) throw plan.shift();
        return 'ok';
      },
      { retries: 3, baseMs: 2000, capMs: 16000, rand: () => 0.5 },
    ).then(
      (v) => (outcome = v),
      (e) => (outcome = e),
    );
    for (let at = 0; at <= until && outcome === 'pending'; at += 250) {
      await settle();
      t.mock.timers.tick(250);
    }
    await settle();
    return { calls, outcome };
  };
  const start = Date.now();
  let r = await run([new TypeError('x'), new TypeError('x')]);
  assert.equal(r.outcome, 'ok');
  assert.deepEqual(r.calls.map((c) => c - r.calls[0]), [0, 2000, 6000], 'waits of 2000 and 4000 (rand 0.5)');
  r = await run([new ApiError('로그인이 필요해요.', 401)]);
  assert.equal(r.calls.length, 1, 'a 401 is not retried');
  assert.ok(r.outcome instanceof ApiError);
  r = await run([new TypeError('a'), new TypeError('b'), new TypeError('c'), new TypeError('d')]);
  assert.equal(r.calls.length, 4, 'three retries, then it throws');
  assert.ok(r.outcome instanceof TypeError);
  r = await run([new DOMException('timed out', 'TimeoutError')]);
  assert.equal(r.calls.length, 1, 'a client timeout is not retried');
  r = await run([new ApiError('잠시 후', 503, null, 9000)]);
  assert.equal(r.outcome, 'ok');
  assert.ok(r.calls[1] - r.calls[0] >= 9000, `the next call comes after Retry-After (${r.calls[1] - r.calls[0]} ms)`);
  assert.ok(Date.now() >= start);
  console.log('API_ERROR_OK');
});
