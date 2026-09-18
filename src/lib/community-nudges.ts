import type { Notification } from './contracts';

// Follow suggestions are deliberately rare: once per answerer after an accept, and only from the
// second card clone of the same author. Both live in localStorage so a reinstall resets them.
const FOLLOW_SUGGESTED_KEY = 'memoryz.community.follow-suggested';
const FOLLOWED_KEY = 'memoryz.community.followed';
const CLONE_COUNT_KEY = 'memoryz.community.clone-counts';
const QUICK_EXIT_KEY = 'memoryz.community.quick-exit-streak';
const LONG_TITLE_KEY = 'memoryz.community.long-titles';

function readJSON<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key: string, value: unknown) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full — the nudge is best-effort */
  }
}

export function followSuggested(userId: string): boolean {
  const list = readJSON<string[]>(FOLLOW_SUGGESTED_KEY, []);
  return Array.isArray(list) && list.includes(userId);
}
export function markFollowSuggested(userId: string) {
  const list = readJSON<string[]>(FOLLOW_SUGGESTED_KEY, []);
  writeJSON(FOLLOW_SUGGESTED_KEY, Array.isArray(list) ? [...new Set([...list, userId])] : [userId]);
}

/** Followed authors are remembered so a suggestion never offers someone already followed. */
export function authorFollowed(userId: string): boolean {
  const list = readJSON<string[]>(FOLLOWED_KEY, []);
  return Array.isArray(list) && list.includes(userId);
}
export function markFollowed(userId: string, following: boolean) {
  const list = readJSON<string[]>(FOLLOWED_KEY, []);
  const set = new Set(Array.isArray(list) ? list : []);
  if (following) set.add(userId);
  else set.delete(userId);
  writeJSON(FOLLOWED_KEY, [...set]);
}
/** Once per author per reason — showing or dismissing both count as "seen". */
export function maySuggestFollow(userId: string | undefined): boolean {
  return !!userId && !authorFollowed(userId) && !followSuggested(userId);
}

export function clonesOf(authorId: string): number {
  const counts = readJSON<Record<string, number>>(CLONE_COUNT_KEY, {});
  return counts && typeof counts === 'object' ? counts[authorId] || 0 : 0;
}
export function recordClone(authorId: string): number {
  const counts = readJSON<Record<string, number>>(CLONE_COUNT_KEY, {});
  const next = (counts && typeof counts === 'object' ? counts[authorId] || 0 : 0) + 1;
  writeJSON(CLONE_COUNT_KEY, { ...(counts || {}), [authorId]: next });
  return next;
}

/** Feed cards widen to 3-line titles after five consecutive under-3-second detail visits. */
export function recordPostVisit(durationMs: number) {
  const streak = readJSON<number>(QUICK_EXIT_KEY, 0);
  const next = durationMs < 3000 ? streak + 1 : 0;
  writeJSON(QUICK_EXIT_KEY, next);
  if (next >= 5) writeJSON(LONG_TITLE_KEY, true);
}
export function longTitles(): boolean {
  return readJSON<boolean>(LONG_TITLE_KEY, false) === true;
}
export function resetReadingPace() {
  writeJSON(QUICK_EXIT_KEY, 0);
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LONG_TITLE_KEY);
  } catch {
    /* ignore */
  }
}

export const COMMUNITY_NOTIFICATION_KINDS = new Set([
  'FIRST_ANSWER',
  'MORE_ANSWERS',
  'ACCEPTED',
  'ACCEPT_ASK',
  'FOLLOWING_DIGEST',
]);
export function isCommunityNotification(n: Notification): boolean {
  return (
    COMMUNITY_NOTIFICATION_KINDS.has(n.kind || '') ||
    n.href.startsWith('/community') ||
    n.href.startsWith('/parent-boards')
  );
}
export function communityUnreadCount(notifications: Notification[]): number {
  return notifications.filter((n) => !n.read && isCommunityNotification(n)).length;
}

export interface CommunityRelation {
  answersToMe: number;
  acceptedForMe: number;
  cardsICloned: number;
}
/** "내 질문 2개에 답했고 그중 1개를 채택했어요 · 담은 카드 3장" — a relation, not a score. */
export function relationLine(relation?: CommunityRelation): string {
  if (!relation) return '';
  const parts: string[] = [];
  if (relation.answersToMe > 0)
    parts.push(
      relation.acceptedForMe > 0
        ? `내 질문 ${relation.answersToMe}개에 답했고 그중 ${relation.acceptedForMe}개를 채택했어요`
        : `내 질문 ${relation.answersToMe}개에 답했어요`,
    );
  if (relation.cardsICloned > 0) parts.push(`담은 카드 ${relation.cardsICloned}장`);
  return parts.join(' · ');
}

/** The two reader-solve outcomes from the spec: shared stumble on a miss, social proof on a hit. */
export function solveResultCopy(input: {
  correct: boolean;
  attempts?: number;
  correctCount?: number;
  authorSelected?: number;
}): { headline: string; detail: string } {
  if (input.correct) {
    const parts: string[] = [];
    if (input.attempts && input.correctCount !== undefined)
      parts.push(`${input.attempts}명 중 ${input.correctCount}명이 맞혔어요`);
    if (Number.isInteger(input.authorSelected))
      parts.push(`작성자는 ${input.authorSelected! + 1}번을 골랐어요 — 답변에 도움이 될지도`);
    return { headline: '맞았어요', detail: parts.join(' · ') };
  }
  return {
    headline: '나도 같은 자리에서 갈렸어요',
    detail: '내 오답노트에 담아 두면 내 자료 기준 해설을 만들어 드려요.',
  };
}

export interface AskOption {
  id: 'card' | 'essay' | 'similar' | 'ask';
  title: string;
  sub: string;
}
/** Study-first 갈림길 options; "커뮤니티에 물어보기" is always the last option. */
export function askOptions(ctx: {
  kind: 'EXPLAIN' | 'WRONGNOTE' | 'CARD' | 'ESSAY';
  hasMaterial: boolean;
}): AskOption[] {
  const options: AskOption[] = [];
  if (ctx.kind === 'EXPLAIN' || ctx.kind === 'WRONGNOTE') {
    options.push({
      id: 'card',
      title: '플래시카드',
      sub: '오늘 다시 볼 카드로 담아요',
    });
    options.push({
      id: 'essay',
      title: '서술형 도우미',
      sub: ctx.hasMaterial ? '같은 개념을 내 말로 설명해요' : '원본 자료가 필요해요',
    });
    options.push({
        id: 'similar',
        title: '비슷한 문제 더 풀기',
        sub: ctx.hasMaterial ? '같은 자료와 개념으로 연습해요' : '원본 자료가 필요해요',
      });
    options.push({
      id: 'ask',
      title: '커뮤니티에 물어보기',
      sub: '다른 학생의 답변을 받아요',
    });
    return options;
  }
  if (ctx.kind === 'ESSAY') {
    if (ctx.hasMaterial)
      options.push({
        id: 'similar',
        title: '비슷한 서술형 문제 더 써보기',
        sub: '같은 자료에서 서술형을 더 만들어요',
      });
    options.push({
      id: 'ask',
      title: '커뮤니티에 답안 피드백 부탁하기',
      sub: '다른 학생의 첨삭을 받아요',
    });
    return options;
  }
  return [{ id: 'ask', title: '커뮤니티에 물어보기', sub: '다른 학생의 답변을 받아요' }];
}

const NICKNAME_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
export function nicknameCooldown(changedAt: string | undefined, now = Date.now()) {
  if (!changedAt || !Number.isFinite(Date.parse(changedAt))) return { allowed: true, daysLeft: 0 };
  const left = Date.parse(changedAt) + NICKNAME_COOLDOWN_MS - now;
  return left <= 0
    ? { allowed: true, daysLeft: 0 }
    : { allowed: false, daysLeft: Math.ceil(left / 86400000) };
}
