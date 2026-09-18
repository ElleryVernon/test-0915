import test from 'node:test';
import assert from 'node:assert/strict';
import {
  receiptAnchors,
  conversationStatus,
  firstUnreadMessage,
  emptyMessageDraft,
  groupMessages,
  makeMessageAttempt,
  mergeMessages,
  messageAttemptPayload,
  messageDay,
  messageDraftKey,
  messagePreview,
  parseMessageDraft,
  reconcileMessageDraft,
  restoreMessageDraft,
  visibleReadTarget,
  type DirectMessage,
  type MessageDraft,
} from '../src/lib/direct-messages';
import type { CommunityBlock } from '../src/lib/community-types';

const at = '2026-09-16T04:00:00.000Z';
const message = (id: string, extra: Partial<DirectMessage> = {}): DirectMessage => ({
  id,
  senderId: 'peer',
  recipientId: 'me',
  body: id,
  createdAt: at,
  ...extra,
});
const block: CommunityBlock = {
  id: 'math',
  type: 'MATH',
  hidden: false,
  payload: { text: 'x = 1' },
};

test('pagination keeps server order for equal timestamps and replaces overlap exactly once', () => {
  const latest = [message('z'), message('a'), message('m')];
  const withOlder = mergeMessages(latest, [message('q'), message('z')], 'older');
  assert.deepEqual(
    withOlder.map((m) => m.id),
    ['q', 'z', 'a', 'm'],
  );
  const refreshed = mergeMessages(withOlder, [
    message('a', { readAt: at }),
    message('m'),
    message('b'),
  ]);
  assert.deepEqual(
    refreshed.map((m) => m.id),
    ['q', 'z', 'a', 'm', 'b'],
  );
  assert.equal(refreshed.find((m) => m.id === 'a')?.readAt, at);
  const reacted = mergeMessages(refreshed, [
    message('z', { reactions: [{ emoji: '❤️', mine: true, count: 1 }] }),
  ]);
  assert.deepEqual(
    reacted.map((m) => m.id),
    ['q', 'z', 'a', 'm', 'b'],
  );
  assert.equal(reacted[1].reactions?.[0].count, 1);
});

test('a repeated latest snapshot cannot duplicate a message', () => {
  const snapshot = [message('a'), message('b')];
  assert.equal(mergeMessages(mergeMessages([], snapshot), snapshot).length, 2);
});

test('same-sender grouping splits at Korean midnight, five minutes, replies and sender changes', () => {
  const rows = groupMessages([
    message('1', { createdAt: '2026-09-15T14:59:00Z' }),
    message('2', { createdAt: '2026-09-15T15:00:00Z' }),
    message('3', { createdAt: '2026-09-15T15:01:00Z' }),
    message('4', { createdAt: '2026-09-15T15:07:00Z' }),
    message('5', {
      createdAt: '2026-09-15T15:08:00Z',
      replyTo: { id: '1', body: '1', senderId: 'peer' },
    }),
    message('6', { createdAt: '2026-09-15T15:08:00Z', senderId: 'me' }),
  ]);
  assert.equal(messageDay('2026-09-15T15:00:00Z'), '2026-09-16');
  assert.deepEqual(
    rows.map((r) => r.showDate),
    [true, true, false, false, false, false],
  );
  assert.deepEqual(
    rows.map((r) => r.startsGroup),
    [true, true, false, true, true, true],
  );
  assert.equal(rows[1].endsGroup, false);
  assert.equal(rows[2].endsGroup, true);
});

test('only an actually visible received unread message can advance read state', () => {
  const rows = [
    message('old', { readAt: at }),
    message('visible'),
    message('offscreen'),
    message('own', { senderId: 'me' }),
  ];
  const visible = new Set(['old', 'visible', 'own']);
  assert.equal(visibleReadTarget(rows, 'me', visible, false), undefined);
  assert.equal(visibleReadTarget(rows, 'me', visible, true), 'visible');
  assert.equal(visibleReadTarget(rows, 'me', new Set(), true), undefined);
  assert.equal(visibleReadTarget(rows, 'me', new Set(['own']), true), undefined);
});

test('an attachment-only draft creates an immutable attempt with exact retry identity', () => {
  const draft: MessageDraft = {
    body: '  ',
    blocks: [structuredClone(block)],
    replyTo: { id: 'original', body: '질문', senderId: 'peer' },
  };
  const attempt = makeMessageAttempt(draft, 'peer', 'durable-request', at);
  draft.blocks[0].payload.text = 'changed while sending';
  draft.body = 'a later draft';
  assert.deepEqual(messageAttemptPayload({ ...attempt, status: 'error' }), {
    userId: 'peer',
    requestId: 'durable-request',
    body: '',
    blocks: [block],
    replyToId: 'original',
  });
});

test('limits and unresolved attempts cannot accidentally create a second request', () => {
  assert.throws(() => makeMessageAttempt(emptyMessageDraft(), 'peer', '1', at));
  assert.throws(() => makeMessageAttempt({ body: 'a'.repeat(3001), blocks: [] }, 'peer', '1', at));
  assert.throws(() =>
    makeMessageAttempt({ body: '', blocks: Array(4).fill(block) }, 'peer', '1', at),
  );
  const pending = makeMessageAttempt({ body: 'first', blocks: [] }, 'peer', '1', at);
  assert.throws(() => makeMessageAttempt({ body: 'second', blocks: [], pending }, 'peer', '2', at));
});

test('reload restores the unsent draft but never automatically resends a pending attempt', () => {
  const pending = makeMessageAttempt({ body: 'first', blocks: [block] }, 'peer', '1', at);
  const restored = parseMessageDraft(
    JSON.stringify({ body: 'next draft', blocks: [], pending }),
    'peer',
  );
  assert.equal(restored.body, 'next draft');
  assert.equal(restored.pending?.status, 'error');
  assert.equal(restored.pending?.requestId, '1');
  assert.deepEqual(messageAttemptPayload(restored.pending!), messageAttemptPayload(pending));
});

test('account and peer storage namespaces cannot collide; malformed and cross-peer attempts are rejected', () => {
  assert.notEqual(messageDraftKey('a:b', 'c'), messageDraftKey('a', 'b:c'));
  assert.notEqual(messageDraftKey('me', 'peer'), messageDraftKey('other', 'peer'));
  assert.deepEqual(parseMessageDraft('{broken', 'peer'), emptyMessageDraft());
  assert.deepEqual(
    parseMessageDraft(JSON.stringify({ body: 'hello', blocks: [{ type: 'SCRIPT' }] }), 'peer'),
    emptyMessageDraft(),
  );
  const pending = makeMessageAttempt({ body: 'wrong target', blocks: [] }, 'other', '1', at);
  assert.equal(
    parseMessageDraft(JSON.stringify({ body: 'safe draft', blocks: [], pending }), 'peer').pending,
    undefined,
  );
});

test('a matching successful poll clears only the attempt and preserves a newer draft and attachments', () => {
  const pending = makeMessageAttempt({ body: 'sent', blocks: [] }, 'peer', 'request', at);
  const draft: MessageDraft = { body: 'keep this', blocks: [block], pending };
  assert.strictEqual(reconcileMessageDraft(draft, [message('unrelated')]), draft);
  const confirmed = reconcileMessageDraft(draft, [message('server-id', { requestId: 'request' })]);
  assert.equal(confirmed.pending, undefined);
  assert.equal(confirmed.body, 'keep this');
  assert.deepEqual(confirmed.blocks, [block]);
});

test('inbox previews distinguish retraction, attachment-only messages and trimmed text', () => {
  assert.equal(messagePreview(message('a', { body: ' one\n two ' })), 'one two');
  assert.equal(messagePreview(message('a', { body: '', blocks: [block] })), '수식');
  assert.equal(
    messagePreview(message('a', { body: 'old private text', deleted: true })),
    '보내기를 취소한 메시지',
  );
});

test('server ordinals place a delayed send response before an already-polled newer message', () => {
  const rows = mergeMessages(
    [message('newer', { ordinal: 52 })],
    [message('sent', { ordinal: 51 })],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['sent', 'newer'],
  );
});

test('legacy journey drafts migrate only the selected peer and current persisted or sent-empty drafts take precedence', () => {
  const legacy = { peer: '작성 중인 쪽지', other: '다른 상대의 초안' };
  assert.deepEqual(restoreMessageDraft(null, 'peer', legacy), {
    body: '작성 중인 쪽지',
    blocks: [],
  });
  assert.deepEqual(restoreMessageDraft(null, 'unknown', legacy), emptyMessageDraft());
  assert.equal(
    restoreMessageDraft(JSON.stringify({ body: 'new draft', blocks: [] }), 'peer', legacy).body,
    'new draft',
  );
  assert.deepEqual(
    restoreMessageDraft(JSON.stringify(emptyMessageDraft()), 'peer', legacy),
    emptyMessageDraft(),
  );
  assert.equal(legacy.other, '다른 상대의 초안');
});

test('read receipts never revert on a delayed send or poll response', () => {
  const seen = message('m', { senderId: 'me', readAt: at });
  assert.equal(
    mergeMessages([seen], [message('m', { senderId: 'me', readAt: null })])[0].readAt,
    at,
  );
  const gone = message('m', { deleted: true, body: '' });
  assert.equal(mergeMessages([gone], [message('m')])[0].deleted, true);
});

test('receipt anchors preserve the last read boundary below a newer unread send', () => {
  const rows = [
    message('a', { senderId: 'me', readAt: at }),
    message('b', { senderId: 'me' }),
    message('c'),
  ];
  assert.deepEqual(receiptAnchors(rows, 'me'), { read: 'a', sent: 'b' });
  assert.deepEqual(
    receiptAnchors([...rows, message('d', { senderId: 'me', deleted: true })], 'me'),
    { read: 'a', sent: 'b' },
  );
  assert.deepEqual(receiptAnchors([], 'me'), { read: undefined, sent: undefined });
});

test('inbox status labels only confirmed outgoing non-retracted messages', () => {
  const row = {
    id: 'peer',
    nickname: 'Peer',
    body: 'hello',
    createdAt: at,
    unreadCount: 0,
    senderId: 'me',
  };
  assert.equal(conversationStatus(row, 'me'), '보냄');
  assert.equal(conversationStatus({ ...row, readAt: at }, 'me'), '읽음');
  assert.equal(conversationStatus({ ...row, senderId: 'peer' }, 'me'), undefined);
  assert.equal(conversationStatus({ ...row, deleted: true }, 'me'), undefined);
});

test('unread start ignores own messages, retractions and already read history', () => {
  const rows = [
    message('deleted', { deleted: true }),
    message('read', { readAt: at }),
    message('own', { senderId: 'me' }),
    message('unread'),
  ];
  assert.equal(firstUnreadMessage(rows, 'me'), 'unread');
  assert.equal(visibleReadTarget(rows, 'me', new Set(['deleted']), true), undefined);
});
