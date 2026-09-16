import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionBoundary,
  isSessionRequest,
  sessionBoundary,
  sessionFetch,
  SessionEndedError,
} from '../src/lib/session-boundary';

test('one expiry invalidates all concurrent responses, next login creates a new boundary', () => {
  const b = createSessionBoundary();
  let calls = 0;
  const remove = b.subscribe(() => calls++);
  const old = b.revision();
  b.end();
  b.end();
  assert.equal(calls, 1);
  assert.equal(b.current(old), false);
  b.begin();
  assert.equal(b.current(old), false);
  assert.equal(b.current(b.revision()), true);
  b.end();
  assert.equal(calls, 2);
  remove();
});
test('only own protected APIs end the session; login refusals and external files do not', () => {
  for (const url of [
    '/api/posts',
    '/api/upload',
    '/api/materials/a',
    '/api/ai/tasks/a',
    '/api/quiz/explanation',
  ])
    assert.equal(isSessionRequest(url), true, url);
  for (const url of [
    '/api/session',
    '/api/logout',
    '/api/auth/providers',
    '/api/schools?q=x',
    'https://other.example/api/file',
    '/icon.svg',
  ])
    assert.equal(isSessionRequest(url), false, url);
});
test('401 ends the session once without retry and discards an earlier successful response', async () => {
  const original = globalThis.fetch;
  let finish: (value: Response) => void = () => {};
  let calls = 0,
    ended = 0;
  sessionBoundary.begin();
  const unsubscribe = sessionBoundary.subscribe(() => ended++);
  globalThis.fetch = async (url) => {
    calls++;
    if (url === '/api/slow')
      return new Promise<Response>((r) => {
        finish = r;
      });
    return new Response(null, { status: url === '/api/forbidden' ? 403 : 401 });
  };
  try {
    assert.equal((await sessionFetch('/api/forbidden')).status, 403);
    assert.equal(ended, 0, '403 is not session expiration');
    const pending = sessionFetch('/api/slow');
    const rejected = assert.rejects(pending, SessionEndedError);
    assert.equal((await sessionFetch('/api/posts')).status, 401);
    finish(Response.json({ data: 'old private data' }));
    await rejected;
    assert.equal(ended, 1);
    const before = calls;
    await assert.rejects(sessionFetch('/api/cards'), SessionEndedError);
    assert.equal(calls, before, 'no new private request after expiry');
    await sessionFetch('/api/session');
    assert.equal(ended, 1, 'login denial is local');
  } finally {
    unsubscribe();
    sessionBoundary.begin();
    globalThis.fetch = original;
  }
});

 test('a delayed 401 from the previous login cannot expire a new login', async () => {
  const original = globalThis.fetch;
  let finish: (value: Response) => void = () => {};
  let ended = 0;
  const off = sessionBoundary.subscribe(() => ended++);
  sessionBoundary.begin();
  globalThis.fetch = async () => new Promise<Response>((resolve) => { finish = resolve; });
  try {
    const pending = sessionFetch('/api/slow');
    const rejected = assert.rejects(pending, SessionEndedError);
    sessionBoundary.begin();
    finish(new Response(null, {status:401}));
    await rejected;
    assert.equal(ended,0);
    assert.equal(sessionBoundary.current(sessionBoundary.revision()),true);
  } finally {off(); sessionBoundary.begin();globalThis.fetch=original;}
});
