import test from 'node:test';
import assert from 'node:assert/strict';
import { commentThreads, readCommentDraft, saveCommentDraft } from '../src/lib/community-comments';
import type { Comment } from '../src/lib/contracts';
const c = (id: string, parentId?: string, createdAt = id): Comment => ({
  id,
  postId: 'p',
  author: '친구',
  body: '본문',
  parentId,
  createdAt,
});
test('threads keep deleted roots and orphan replies visible without duplicating nested replies', () => {
  const rows = [c('2', '1'), { ...c('1'), deleted: true }, c('3', 'missing')];
  assert.deepEqual(
    commentThreads(rows).map((t) => [t.root.id, t.replies.map((r) => r.id)]),
    [
      ['1', ['2']],
      ['3', []],
    ],
  );
  assert.equal(commentThreads(rows, true)[0].root.id, '3');
});
test('comment drafts retain retry identity, are account/post scoped, and clear after send', () => {
  const storage = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => storage.get(k) || null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    },
  });
  try {
    const d = {
      body: '작성 중',
      block: null,
      reply: c('1'),
      requestId: 'same-retry',
      updatedAt: Date.now(),
    };
    assert.equal(saveCommentDraft('me', 'p', d), true);
    assert.equal(readCommentDraft('me', 'p')?.requestId, 'same-retry');
    assert.equal(readCommentDraft('other', 'p'), null);
    assert.equal(readCommentDraft('me', 'other'), null);
    saveCommentDraft('me', 'p', { ...d, updatedAt: Date.now() - 8 * 86400000 });
    assert.equal(readCommentDraft('me', 'p'), null);
    saveCommentDraft('me', 'p', { ...d, body: '', reply: null });
    assert.equal(storage.size, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
