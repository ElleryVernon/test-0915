import test from 'node:test';
import assert from 'node:assert/strict';

// localStorage stub so the nudge state helpers run under node:test.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
};

const {
  askOptions,
  authorFollowed,
  clonesOf,
  communityUnreadCount,
  followSuggested,
  isCommunityNotification,
  longTitles,
  markFollowed,
  markFollowSuggested,
  maySuggestFollow,
  nicknameCooldown,
  recordClone,
  recordPostVisit,
  relationLine,
  resetReadingPace,
  solveResultCopy,
} = await import('../src/lib/community-nudges');

test('askOptions keeps the community ask as the last option', () => {
  const options = askOptions({ kind: 'WRONGNOTE', hasMaterial: true });
  assert.deepEqual(
    options.map((o) => o.id),
    ['card', 'essay', 'similar', 'ask'],
  );
  assert.equal(options.at(-1)!.id, 'ask');
});

test('askOptions preserves four stable paths with missing-source explanation', () => {
  const options = askOptions({ kind: 'EXPLAIN', hasMaterial: false });
  assert.deepEqual(
    options.map((o) => o.id),
    ['card', 'essay', 'similar', 'ask'],
  );
});

test('askOptions for a card context goes straight to asking', () => {
  const options = askOptions({ kind: 'CARD', hasMaterial: false });
  assert.deepEqual(
    options.map((o) => o.id),
    ['ask'],
  );
});

test('solveResultCopy separates the two reader outcomes', () => {
  const wrong = solveResultCopy({ correct: false });
  assert.match(wrong.headline, /같은 자리/);
  assert.match(wrong.detail, /오답노트/);
  const right = solveResultCopy({
    correct: true,
    attempts: 7,
    correctCount: 4,
    authorSelected: 1,
  });
  assert.equal(right.headline, '맞았어요');
  assert.match(right.detail, /4명이 맞혔어요/);
  assert.match(right.detail, /2번을 골랐어요/);
});

test('relationLine composes a relationship sentence, not a score', () => {
  assert.equal(relationLine(undefined), '');
  assert.equal(relationLine({ answersToMe: 0, acceptedForMe: 0, cardsICloned: 0 }), '');
  assert.equal(
    relationLine({ answersToMe: 2, acceptedForMe: 1, cardsICloned: 3 }),
    '내 질문 2개에 답했고 그중 1개를 채택했어요 · 담은 카드 3장',
  );
  assert.equal(
    relationLine({ answersToMe: 2, acceptedForMe: 0, cardsICloned: 0 }),
    '내 질문 2개에 답했어요',
  );
});

test('nicknameCooldown enforces the 30-day rule', () => {
  const changed = new Date('2025-01-01T00:00:00Z').toISOString();
  const later = Date.parse('2025-01-20T00:00:00Z');
  assert.deepEqual(nicknameCooldown(changed, later), { allowed: false, daysLeft: 11 });
  assert.deepEqual(nicknameCooldown(changed, Date.parse('2025-02-01T00:00:00Z')), {
    allowed: true,
    daysLeft: 0,
  });
  assert.deepEqual(nicknameCooldown(undefined, later), { allowed: true, daysLeft: 0 });
  assert.deepEqual(nicknameCooldown('not-a-date', later), { allowed: true, daysLeft: 0 });
});

test('follow suggestions fire once per author and never for followed authors', () => {
  assert.equal(maySuggestFollow('u1'), true);
  markFollowSuggested('u1');
  assert.equal(maySuggestFollow('u1'), false);
  assert.equal(followSuggested('u1'), true);
  assert.equal(maySuggestFollow('u2'), true);
  markFollowed('u2', true);
  assert.equal(authorFollowed('u2'), true);
  assert.equal(maySuggestFollow('u2'), false);
  markFollowed('u2', false);
  assert.equal(authorFollowed('u2'), false);
  assert.equal(maySuggestFollow(undefined), false);
});

test('clone counts accumulate per author', () => {
  assert.equal(clonesOf('author-a'), 0);
  assert.equal(recordClone('author-a'), 1);
  assert.equal(recordClone('author-a'), 2);
  assert.equal(clonesOf('author-a'), 2);
  assert.equal(clonesOf('author-b'), 0);
});

test('reading pace widens titles after five quick exits', () => {
  resetReadingPace();
  assert.equal(longTitles(), false);
  for (let i = 0; i < 4; i++) recordPostVisit(1200);
  assert.equal(longTitles(), false);
  recordPostVisit(1200);
  assert.equal(longTitles(), true);
  // A real read resets the streak but keeps the learned preference.
  recordPostVisit(12_000);
  assert.equal(longTitles(), true);
});

test('community notifications group by kind for the session-end row', () => {
  const list = [
    {
      id: '1',
      title: '첫 답변이 도착했어요',
      body: '',
      read: false,
      href: '/community?post=p1',
      kind: 'FIRST_ANSWER',
      createdAt: 'x',
    },
    {
      id: '2',
      title: '답변이 3개 더 왔어요',
      body: '',
      read: false,
      href: '/community?post=p2',
      kind: 'MORE_ANSWERS',
      createdAt: 'x',
    },
    {
      id: '3',
      title: '일정 알림',
      body: '',
      read: false,
      href: '/planner',
      createdAt: 'x',
    },
    {
      id: '4',
      title: '읽은 답변',
      body: '',
      read: true,
      href: '/community?post=p3',
      kind: 'FIRST_ANSWER',
      createdAt: 'x',
    },
  ];
  assert.equal(communityUnreadCount(list), 2);
  assert.equal(
    isCommunityNotification({
      id: '5',
      title: '',
      body: '',
      read: false,
      href: '/parent-boards?post=x',
      createdAt: 'x',
    }),
    true,
  );
});
