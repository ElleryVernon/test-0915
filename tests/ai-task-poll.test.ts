import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AiTaskFailureError,
  AiTaskPendingError,
  clearAiTasks,
  findAiTask,
  inspectAiTask,
  runAiTask,
  type AiTaskOptions,
} from '../src/lib/ai-task';

const top = () => 1 - 2 ** -53;
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
};
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  at: number;
}
const original = globalThis.fetch;
function serve(handler: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', path: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, at: Date.now() };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}
const running = (id: string) => Response.json({ data: { requestId: id, status: 'RUNNING', result: null, error: null, updatedAt: new Date().toISOString() } });
const idOf = (path: string) => decodeURIComponent(path.split('/').pop()!);
let serial = 0;
function options(extra: Partial<AiTaskOptions> = {}): AiTaskOptions {
  serial++;
  return { userId: 'poll-user', endpoint: '/generate', payload: { materialId: `m-${serial}`, mode: 'quiz', count: 3 }, ...extra };
}
/** Runs a task until it settles or `until` ms pass; the loop is then aborted. */
async function drive(t: { mock: { timers: { tick: (ms: number) => void } } }, opts: AiTaskOptions, until: number, step = 25) {
  const controller = new AbortController();
  let outcome: unknown = 'pending';
  runAiTask({ ...opts, signal: opts.signal ?? controller.signal }).then(
    (v) => (outcome = v),
    (e) => (outcome = e),
  );
  for (let at = 0; at < until && outcome === 'pending'; at += step) {
    await settle();
    t.mock.timers.tick(step);
  }
  await settle();
  if (outcome === 'pending') {
    controller.abort();
    await settle();
  }
  return outcome;
}
const gets = (calls: Call[]) => calls.filter((c) => c.method === 'GET').map((c) => c.at);
const gaps = (times: number[]) => times.slice(1).map((at, i) => at - times[i]);

test('AI status polling: ±25 % period, spread wake after a server failure, backoff on failed reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    await clearAiTasks('poll-user');
    // An accepted run that stays RUNNING: every gap is 1875 ms at rand 0, under 3125 ms at rand → 1.
    for (const [rand, check] of [
      [() => 0, (gap: number) => gap === 1875],
      [top, (gap: number) => gap <= 3125 && gap > 3000],
    ] as const) {
      const calls = serve((c) => (c.method === 'POST' ? Response.json({ data: { requestId: c.body!.requestId, status: 'RUNNING' } }) : running(idOf(c.path))));
      await drive(t, options({ rand }), 30_000);
      const g = gaps(gets(calls));
      assert.ok(g.length >= 8 && g.every(check), `steady gaps at rand ${rand()} (${g})`);
      assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'one POST per run');
    }
    // Four failed reads, then RUNNING: gaps just under 5, 7.5, 10 and 10 s, then back under 3.125 s.
    let failures = 4;
    let calls = serve((c) => {
      if (c.method === 'POST') return Response.json({ data: { requestId: c.body!.requestId, status: 'RUNNING' } });
      if (failures-- > 0) throw new TypeError('fetch failed');
      return running(idOf(c.path));
    });
    await drive(t, options({ rand: top }), 40_000);
    let g = gaps(gets(calls));
    for (const [i, cap] of [5000, 7500, 10_000, 10_000, 3125].entries())
      assert.ok(g[i] <= cap && g[i] > cap - 200, `gap ${i + 1} just under ${cap} ms (${g})`);
    // A read refused with a 12 s hint: the next read comes no sooner.
    let hinted = true;
    calls = serve((c) => {
      if (c.method === 'POST') return Response.json({ data: { requestId: c.body!.requestId, status: 'RUNNING' } });
      if (hinted) {
        hinted = false;
        return Response.json({ error: '잠시 후' }, { status: 503, headers: { 'Retry-After': '12' } });
      }
      return running(idOf(c.path));
    });
    await drive(t, options({ rand: () => 0 }), 20_000);
    g = gaps(gets(calls));
    assert.ok(g[0] >= 12_000, `Retry-After floors the next read (${g[0]})`);
    // A POST no server answered: the first read comes 1250 ms after it settles (rand 0.5), not at once;
    // the run is reported pending at the 190 s deadline and the POST is never sent again.
    calls = serve((c) => {
      if (c.method === 'POST') throw new TypeError('connection reset');
      return Response.json({ error: 'missing' }, { status: 404 });
    });
    const posted = Date.now();
    const pending = await drive(t, options({ rand: () => 0.5 }), 200_000, 250);
    assert.equal(gets(calls)[0] - posted, 1250, 'the first read waits U[0, 2.5 s) after a failed POST');
    assert.ok(pending instanceof AiTaskPendingError, `pending at the deadline (${pending})`);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'the paid POST is never re-sent');
    // A POST answered 429 is read in the same tick (the server decided), and the run fails there.
    calls = serve((c) =>
      c.method === 'POST' ? Response.json({ error: 'AI 요청이 많아요.' }, { status: 429 }) : Response.json({ error: 'missing' }, { status: 404 }),
    );
    const refused = await drive(t, options({ rand: () => 0.5 }), 5_000);
    assert.ok(refused instanceof AiTaskFailureError);
    assert.equal(gets(calls)[0], calls[0].at, 'a 4xx POST keeps the immediate read');
    console.log('AI_POLL_OK');
  } finally {
    globalThis.fetch = original;
  }
});

test('manual retry cooldown: stored once, gates the retry, and reuses an unclaimed request id', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    await clearAiTasks('poll-user');
    const opts = options({ rand: () => 0 });
    let calls = serve((c) =>
      c.method === 'POST'
        ? Response.json({ error: 'AI 요청이 많아요. 잠시 후 다시 시도해 주세요.', retryAfterMs: 12_000 }, { status: 429 })
        : Response.json({ error: 'missing' }, { status: 404 }),
    );
    const refusedAt = Date.now();
    const refused = await drive(t, opts, 5_000);
    assert.ok(refused instanceof AiTaskFailureError);
    const stored = await findAiTask(opts);
    assert.equal(stored?.status, 'FAILED');
    assert.equal(stored?.unclaimed, true, 'the server never recorded it');
    assert.equal(stored?.retryAt, refusedAt + 12_000, 'retryAt = refusal + hint (rand 0)');
    const firstId = stored!.requestId;
    assert.equal((await findAiTask(opts))?.retryAt, stored?.retryAt, 'reloading keeps the same retryAt');
    // Before retryAt: no POST.
    calls = serve((c) => (c.method === 'POST' ? Response.json({ data: { ok: true } }) : Response.json({ error: 'missing' }, { status: 404 })));
    const early = await drive(t, { ...opts, retryFailed: true }, 1_000);
    assert.ok(early instanceof AiTaskFailureError);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'no POST before the cooldown ends');
    // After retryAt: exactly one POST, with the same request id.
    t.mock.timers.tick(12_000);
    calls = serve((c) => (c.method === 'POST' ? Response.json({ data: { ok: true } }) : Response.json({ error: 'missing' }, { status: 404 })));
    const result = await drive(t, { ...opts, retryFailed: true }, 5_000);
    assert.deepEqual(result, { ok: true });
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body!.requestId, firstId, 'an unclaimed id is sent again (it still runs at most once)');
    // A recorded 429 with a 15 s hint sets retryAt once; a second read keeps it.
    const failedOpts = options({ rand: () => 0 });
    calls = serve((c) =>
      c.method === 'POST'
        ? Response.json({ error: 'AI 요청이 많아요.' }, { status: 429, headers: { 'Retry-After': '15' } })
        : Response.json({ data: { requestId: idOf(c.path), status: 'FAILED', result: null, error: 'AI 요청이 많아요.', errorStatus: 429, retryAfterMs: 15_000, updatedAt: new Date().toISOString() } }),
    );
    await drive(t, failedOpts, 5_000);
    const recorded = (await findAiTask(failedOpts))!;
    const readAt = Date.now();
    const inspected = await inspectAiTask(recorded, undefined, () => 0);
    t.mock.timers.tick(3_000);
    const again = await inspectAiTask(inspected!, undefined, () => 0.9);
    assert.equal(inspected?.retryAt, recorded.retryAt ?? readAt + 15_000);
    assert.ok(recorded.retryAt && recorded.retryAt >= readAt && recorded.retryAt <= readAt + 15_000, `retryAt from the record's hint (${recorded.retryAt! - readAt})`);
    assert.equal(again?.retryAt, inspected?.retryAt, 'a later read never redraws it');
    assert.equal(recorded.unclaimed, undefined, 'a recorded run is not reused');
    console.log('COOLDOWN_OK');
  } finally {
    globalThis.fetch = original;
  }
});

test('restart simulation: 25 learners whose requests all fail at one instant come back spread out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const simulate = async (randFor: (i: number) => () => number) => {
      await clearAiTasks('restart-user');
      const base = Date.now();
      const recovery = base + 20_000;
      const held: (() => void)[] = [];
      const calls = serve(
        (c) =>
          new Promise<Response>((resolve, reject) => {
            if (Date.now() >= recovery) {
              resolve(c.method === 'POST' ? Response.json({ data: { requestId: c.body!.requestId, status: 'RUNNING' } }) : running(idOf(c.path)));
              return;
            }
            // The instance is restarting: every request hangs until the connections drop together.
            held.push(() => reject(new TypeError('connection reset')));
          }),
      );
      const controller = new AbortController();
      const loops: Promise<unknown>[] = [];
      for (let i = 0; i < 25; i++) {
        loops.push(
          runAiTask({ userId: 'restart-user', endpoint: '/generate', payload: { materialId: `r-${i}`, mode: 'quiz', count: 3 }, rand: randFor(i), signal: controller.signal }).catch(() => {}),
        );
        for (let k = 0; k < 4; k++) {
          await settle();
          t.mock.timers.tick(10);
        }
      }
      for (let at = Date.now(); at < base + 45_000; at += 25) {
        if (at >= recovery && held.length) held.splice(0).forEach((drop) => drop());
        await settle();
        t.mock.timers.tick(25);
      }
      controller.abort();
      await settle();
      await Promise.all(loops);
      const after = calls.filter((c) => c.method === 'GET' && c.at >= recovery && c.at < base + 40_000).map((c) => c.at);
      const windows = new Map<number, number>();
      for (const at of after) windows.set(Math.floor(at / 250), (windows.get(Math.floor(at / 250)) ?? 0) + 1);
      return { reads: after.length, busiest: Math.max(...windows.values()) };
    };
    const spread = await simulate((i) => mulberry32(i + 1));
    assert.ok(spread.reads >= 100, `polling resumed (${spread.reads} reads)`);
    assert.ok(spread.busiest <= 8, `no 250 ms window above 8 reads after recovery (${spread.busiest})`);
    // Control: the same draw on every device keeps them in lockstep after the shared failure.
    const lockstep = await simulate(() => () => 0.5);
    assert.ok(lockstep.busiest >= 20, `without per-device jitter the reads line up (${lockstep.busiest})`);
    console.log('RESTART_SPREAD_OK');
  } finally {
    globalThis.fetch = original;
  }
});
