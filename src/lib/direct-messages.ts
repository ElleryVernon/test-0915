import type { CommunityBlock } from './community-types';

export interface MessageQuote {
  id: string;
  body: string;
  senderId: string;
  deleted?: boolean;
}
export interface DirectMessage {
  id: string;
  senderId: string;
  recipientId: string;
  body: string;
  createdAt: string;
  requestId?: string;
  ordinal?: number;
  readAt?: string | null;
  replyTo?: MessageQuote | null;
  blocks?: CommunityBlock[];
  deleted?: boolean;
  reactions?: { emoji: string; count: number; mine: boolean }[];
}
export interface Conversation {
  id: string;
  nickname: string;
  body: string;
  createdAt: string;
  unreadCount: number;
  senderId?: string;
  readAt?: string | null;
  blocks?: CommunityBlock[];
  deleted?: boolean;
}
export interface MessageAttempt {
  requestId: string;
  userId: string;
  body: string;
  blocks: CommunityBlock[];
  replyToId?: string;
  replyTo?: MessageQuote;
  createdAt: string;
  status: 'sending' | 'error';
  error?: string;
}
export interface MessageDraft {
  body: string;
  blocks: CommunityBlock[];
  replyTo?: MessageQuote;
  pending?: MessageAttempt;
}
export const emptyMessageDraft = (): MessageDraft => ({ body: '', blocks: [] });
export const messageDraftKey = (accountId: string, peerId: string) =>
  `memoryz.dm.v1:${encodeURIComponent(accountId)}:${encodeURIComponent(peerId)}`;

const blockNames: Record<string, string> = {
  QUESTION: '문제',
  CARD: '복습 카드',
  MATERIAL: '자료 발췌',
  PHOTO: '사진 · 필기',
  ESSAY: '서술형 답안',
  POLL: '투표',
  SCHEDULE: '시간표',
  MATH: '수식',
};
export function messagePreview(message: Pick<DirectMessage, 'body' | 'blocks' | 'deleted'>) {
  if (message.deleted) return '보내기를 취소한 메시지';
  if (message.body.trim()) return message.body.replace(/\s+/g, ' ').trim();
  const blocks = message.blocks ?? [];
  return blocks.length
    ? `${blockNames[blocks[0].type] ?? '학습 자료'}${blocks.length > 1 ? ` 외 ${blocks.length - 1}개` : ''}`
    : '메시지';
}
/** Keep server insertion order, including messages sharing a millisecond. Edits do not move rows. */
export function mergeMessages(
  previous: DirectMessage[],
  incoming: DirectMessage[],
  position: 'older' | 'latest' = 'latest',
) {
  const updates = new Map(incoming.map((message) => [message.id, message]));
  const known = new Set(previous.map((message) => message.id));
  const added = incoming.filter(
    (message, index) =>
      !known.has(message.id) && incoming.findIndex((m) => m.id === message.id) === index,
  );
  const existing = previous.map((message) => {
    const update = updates.get(message.id);
    if (!update) return message;
    // A delayed send/poll response cannot undo a confirmed read or retraction.
    if (message.deleted && !update.deleted) return message;
    return { ...update, readAt: message.readAt || update.readAt };
  });
  const merged = position === 'older' ? [...added, ...existing] : [...existing, ...added];
  // The optional server ordinal also orders a send response arriving after a newer polling page.
  return merged.every((message) => typeof message.ordinal === 'number')
    ? merged.sort((left, right) => left.ordinal! - right.ordinal!)
    : merged;
}
export function messageDay(timestamp: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}
export function groupMessages(messages: DirectMessage[]) {
  const belongs = (left?: DirectMessage, right?: DirectMessage) =>
    !!left &&
    !!right &&
    left.senderId === right.senderId &&
    !left.deleted &&
    !right.deleted &&
    !right.replyTo &&
    messageDay(left.createdAt) === messageDay(right.createdAt) &&
    Date.parse(right.createdAt) - Date.parse(left.createdAt) <= 5 * 60_000;
  return messages.map((message, index) => ({
    message,
    showDate:
      index === 0 || messageDay(messages[index - 1].createdAt) !== messageDay(message.createdAt),
    startsGroup: !belongs(messages[index - 1], message),
    endsGroup: !belongs(message, messages[index + 1]),
  }));
}
export function makeMessageAttempt(
  draft: MessageDraft,
  peerId: string,
  requestId: string,
  now: string,
): MessageAttempt {
  if (draft.pending) throw new Error('이전 메시지의 전송 결과를 먼저 확인해 주세요.');
  if (
    (!draft.body.trim() && !draft.blocks.length) ||
    draft.body.length > 3000 ||
    draft.blocks.length > 3
  )
    throw new Error('메시지는 3,000자, 첨부는 3개까지 보낼 수 있어요.');
  return {
    requestId,
    userId: peerId,
    body: draft.body.trim(),
    blocks: structuredClone(draft.blocks),
    ...(draft.replyTo ? { replyToId: draft.replyTo.id, replyTo: { ...draft.replyTo } } : {}),
    createdAt: now,
    status: 'sending',
  };
}
/** Retries always use the captured payload, never whatever is currently in the composer. */
export function messageAttemptPayload(attempt: MessageAttempt) {
  return {
    userId: attempt.userId,
    body: attempt.body,
    requestId: attempt.requestId,
    blocks: attempt.blocks,
    ...(attempt.replyToId ? { replyToId: attempt.replyToId } : {}),
  };
}
export function reconcileMessageDraft(
  draft: MessageDraft,
  messages: DirectMessage[],
): MessageDraft {
  return draft.pending && messages.some((message) => message.requestId === draft.pending?.requestId)
    ? { ...draft, pending: undefined }
    : draft;
}
function isBlocks(value: unknown): value is CommunityBlock[] {
  return (
    Array.isArray(value) &&
    value.length <= 3 &&
    value.every(
      (block) =>
        block &&
        typeof block.id === 'string' &&
        blockNames[block.type] &&
        block.payload &&
        typeof block.payload === 'object',
    )
  );
}
function isQuote(value: unknown): value is MessageQuote {
  if (!value || typeof value !== 'object') return false;
  const q = value as MessageQuote;
  return typeof q.id === 'string' && typeof q.body === 'string' && typeof q.senderId === 'string';
}
export function parseMessageDraft(raw: string | null, peerId: string): MessageDraft {
  if (!raw) return emptyMessageDraft();
  try {
    const value = JSON.parse(raw) as MessageDraft;
    if (
      !value ||
      typeof value.body !== 'string' ||
      value.body.length > 3000 ||
      !isBlocks(value.blocks)
    )
      return emptyMessageDraft();
    const draft: MessageDraft = { body: value.body, blocks: value.blocks };
    if (isQuote(value.replyTo)) draft.replyTo = value.replyTo;
    const p = value.pending;
    if (
      p &&
      p.userId === peerId &&
      typeof p.requestId === 'string' &&
      p.requestId.length > 0 &&
      typeof p.body === 'string' &&
      p.body.length <= 3000 &&
      isBlocks(p.blocks) &&
      typeof p.createdAt === 'string' &&
      Number.isFinite(Date.parse(p.createdAt)) &&
      (!p.replyToId || typeof p.replyToId === 'string')
    ) {
      draft.pending = {
        ...p,
        replyTo: isQuote(p.replyTo) ? p.replyTo : undefined,
        status: 'error',
        error: '전송 결과를 확인하지 못했어요. 대화를 새로고침하거나 다시 시도해 주세요.',
      };
    }
    return draft;
  } catch {
    return emptyMessageDraft();
  }
}
/** Prefer current durable state; migrate only the current peer from older history-entry drafts. */
export function restoreMessageDraft(
  raw: string | null,
  peerId: string,
  legacyDrafts: Record<string, string> = {},
): MessageDraft {
  if (raw !== null) return parseMessageDraft(raw, peerId);
  const body = legacyDrafts?.[peerId];
  return typeof body === 'string' && body.length <= 3000
    ? { body, blocks: [] }
    : emptyMessageDraft();
}

export function visibleReadTarget(
  messages: DirectMessage[],
  accountId: string,
  visibleIds: Set<string>,
  active: boolean,
) {
  if (!active) return undefined;
  return messages.findLast(
    (message) =>
      message.senderId !== accountId &&
      !message.deleted &&
      !message.readAt &&
      visibleIds.has(message.id),
  )?.id;
}

/** Two separate anchors preserve where the recipient read up to when a newer send is unread. */
export function receiptAnchors(messages: DirectMessage[], accountId: string) {
  const own = messages.filter((m) => m.senderId === accountId && !m.deleted);
  return { sent: own.at(-1)?.id, read: own.findLast((m) => !!m.readAt)?.id };
}
export function conversationStatus(conversation: Conversation, accountId: string) {
  if (conversation.deleted || conversation.senderId !== accountId) return undefined;
  return conversation.readAt ? '읽음' : '보냄';
}
export function firstUnreadMessage(messages: DirectMessage[], accountId: string) {
  return messages.find((m) => m.senderId !== accountId && !m.deleted && !m.readAt)?.id;
}
