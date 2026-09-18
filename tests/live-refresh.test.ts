import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RefreshLoop, refreshPolicy, pullDistance, PULL_THRESHOLD } from '../src/lib/live-refresh';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(task: (signal: AbortSignal) => Promise<unknown>) {
  let time = 0,
    nextId = 0,
    available = true,
    online = true;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const loop = new RefreshLoop(task, {
    interval: 4000,
    random: () => 0,
    available: () => available,
    online: () => online,
    clock: {
      now: () => time,
      set: (fn, delay) => {
        const id = ++nextId;
        timers.set(id, { at: time + delay, fn });
        return id;
      },
      clear: (id) => {
        timers.delete(id as number);
      },
    },
  });
  return {
    loop,
    timers,
    visibility: (v: boolean) => {
      available = v;
    },
    connectivity: (v: boolean) => {
      online = v;
    },
    async advance(ms: number) {
      time += ms;
      const due = [...timers].filter(([, t]) => t.at <= time);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
      await settle();
    },
  };
}

test('conversation refresh is automatic; study answers and editing flows cannot be pulled', () => {
  for (const path of [
    '/quiz?material=1',
    '/essay?essay=1',
    '/flashcards',
    '/create-card',
    '/settings',
    '/messages?peer=1',
    '/community?peer=1',
  ])
    assert.equal(refreshPolicy(path).pull, false, path);
  for (const path of [
    '/',
    '/study',
    '/subjects/demo',
    '/community?post=1',
    '/messages',
    '/planner',
    '/notifications',
    '/wrong-notes',
  ])
    assert.equal(refreshPolicy(path).pull, true, path);
  assert.equal(refreshPolicy('/notifications').bootstrapInterval, 15000);
  assert.equal(refreshPolicy('/community').bootstrapInterval, 0);
});
test('short, upward and horizontal pulls do not trigger refresh; long pull is bounded', () => {
  assert.ok(pullDistance(0, 100) < PULL_THRESHOLD);
  assert.ok(pullDistance(0, 128) >= PULL_THRESHOLD);
  assert.equal(pullDistance(200, 130), -1);
  assert.equal(pullDistance(0, -10), -1);
  assert.equal(pullDistance(0, 10000), 88);
});
test('focus, timer and repeated explicit refresh share the same in-flight read', async () => {
  let calls = 0;
  let release!: () => void;
  const f = fixture(() => {
    calls++;
    return new Promise<void>((r) => {
      release = r;
    });
  });
  const a = f.loop.run();
  const b = f.loop.run(true);
  f.loop.wake();
  await settle();
  assert.equal(calls, 1);
  assert.equal(a, b);
  await f.advance(5000);
  assert.equal(calls, 1);
  release();
  await a;
  assert.equal(f.timers.size, 1);
  f.loop.stop();
});
test('hidden, dialog-blocked or offline reads pause, then resume on wake', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
  });
  f.visibility(false);
  f.loop.start();
  await settle();
  await f.advance(4000);
  assert.equal(calls, 0);
  f.visibility(true);
  f.connectivity(false);
  f.loop.wake();
  await settle();
  assert.equal(calls, 0);
  await assert.rejects(f.loop.run(true), /인터넷/);
  f.connectivity(true);
  f.loop.wake();
  await settle();
  assert.equal(calls, 1);
  f.loop.stop();
});
test('automatic wake respects failure backoff, but a deliberate retry can recover immediately', async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw new Error('connection');
  });
  await assert.rejects(f.loop.run());
  await f.advance(2000);
  f.loop.wake();
  await settle();
  assert.equal(calls, 1);
  await f.loop.run(true);
  assert.equal(calls, 2);
  await f.advance(4000);
  assert.equal(calls, 3);
  f.loop.stop();
});
test('Retry-After also prevents manual retries and recovers after the server deadline', async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1)
      throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 12000 });
  });
  await assert.rejects(f.loop.run());
  await f.advance(4000);
  await assert.rejects(f.loop.run(true), /잠시/);
  assert.equal(calls, 1);
  await f.advance(8000);
  assert.equal(calls, 2);
  f.loop.stop();
});
test('permission failure stops automatic retries without hiding a user-requested retry', async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw Object.assign(new Error('forbidden'), { status: 403 });
  });
  await assert.rejects(f.loop.run());
  assert.equal(f.timers.size, 0);
  await f.advance(10000);
  f.loop.wake();
  await settle();
  assert.equal(calls, 1);
  await f.loop.run(true);
  assert.equal(calls, 2);
  f.loop.stop();
});
test('pull-to-refresh never starts or continues while the keyboard or a text field owns the gesture', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src/components/refresh.tsx'), 'utf8');
  assert.match(src, /import \{ isTextField \} from '@\/lib\/keyboard-inset';/);
  assert.match(
    src,
    /document\.documentElement\.dataset\.keyboard === 'open'/,
    'an open keyboard owns the gesture',
  );
  assert.match(src, /isTextField\(document\.activeElement\)/, 'a focused field owns the gesture');
  assert.match(
    src,
    /visualViewport\?\.offsetTop \?\? 0\) > 1/,
    'a panned visual viewport is not a pull',
  );
  assert.match(
    src,
    /visualViewport\?\.scale \?\? 1\) - 1\) > 0\.01/,
    'a pinched viewport is not a pull',
  );
  const move = src.slice(src.indexOf('const move'));
  assert.match(move, /start = null;/, 'a gesture that becomes typing cancels the pull');
  const cancel = move.indexOf('start = null;');
  const prevent = move.indexOf('preventDefault');
  assert.ok(cancel > -1 && prevent > -1 && cancel < prevent, 'cancel before preventDefault');
});

test('leaving a resource aborts its read and cannot schedule a late response', async () => {
  let signal!: AbortSignal, release!: () => void;
  const f = fixture((s) => {
    signal = s;
    return new Promise<void>((r) => {
      release = r;
    });
  });
  const read = f.loop.run();
  await settle();
  f.loop.stop();
  assert.equal(signal.aborted, true);
  release();
  await read;
  assert.equal(f.timers.size, 0);
  await f.loop.run(true);
  assert.equal(f.timers.size, 0);
});
