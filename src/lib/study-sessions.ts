import type { AppData, Card, Question } from './contracts';
import type { QuizAnswer } from './quiz-learning';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
interface SessionBase {
  id: string;
  ids: string[];
  revisions: Record<string, string>;
  index: number;
  startedAt: number;
  updatedAt: string;
}
export interface QuizSession extends SessionBase {
  kind: 'quiz';
  selection: number | null;
  result: { correct: boolean; explanation: string; citation: string; attemptId?: string } | null;
  answers: QuizAnswer[];
  pending: { requestId: string; questionId: string; answer: number } | null;
}
export interface CardSession extends SessionBase {
  kind: 'cards';
  reviewStates: Record<string, string>;
  flipped: boolean;
  ratings: { cardId: string; rating: 'AGAIN' | 'HARD' | 'GOOD' | 'EASY' }[];
}
export type StudySession = QuizSession | CardSession;
export const studySessionRevision = (item: Question | Card) =>
  'options' in item
    ? JSON.stringify([item.prompt, item.options, item.answer])
    : JSON.stringify([
        item.front,
        item.back,
        item.image,
        item.masks,
        item.diagram,
        item.maskedNodeIds,
      ]);
const key = (user: string) => `memoryz-study-sessions-v1:${encodeURIComponent(user)}`;
function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
function valid(value: unknown): value is StudySession {
  if (!value || typeof value !== 'object') return false;
  const s = value as StudySession;
  if (
    typeof s.id !== 'string' ||
    !s.id ||
    !Array.isArray(s.ids) ||
    !s.ids.length ||
    s.ids.length > 500 ||
    !s.ids.every((id) => typeof id === 'string') ||
    new Set(s.ids).size !== s.ids.length ||
    !Number.isInteger(s.index) ||
    s.index < 0 ||
    s.index >= s.ids.length ||
    !s.revisions ||
    typeof s.revisions !== 'object' ||
    !s.ids.every((id) => typeof s.revisions[id] === 'string') ||
    !Number.isFinite(s.startedAt) ||
    !Number.isFinite(Date.parse(s.updatedAt))
  )
    return false;
  if (s.kind === 'cards')
    return (
      typeof s.flipped === 'boolean' &&
      !!s.reviewStates &&
      typeof s.reviewStates === 'object' &&
      s.ids.every((id) => typeof s.reviewStates[id] === 'string') &&
      Array.isArray(s.ratings) &&
      s.ratings.every(
        (r) =>
          r && s.ids.includes(r.cardId) && ['AGAIN', 'HARD', 'GOOD', 'EASY'].includes(r.rating),
      )
    );
  if (s.kind !== 'quiz') return false;
  return (
    (s.selection === null || (Number.isInteger(s.selection) && s.selection >= 0)) &&
    Array.isArray(s.answers) &&
    s.answers.every((a) => a && s.ids.includes(a.id) && typeof a.correct === 'boolean') &&
    (s.result === null ||
      (typeof s.result?.correct === 'boolean' &&
        typeof s.result.explanation === 'string' &&
        typeof s.result.citation === 'string')) &&
    (s.pending === null ||
      (typeof s.pending?.requestId === 'string' &&
        s.pending.questionId === s.ids[s.index] &&
        Number.isInteger(s.pending.answer) &&
        s.pending.answer >= 0))
  );
}
export function readStudySessions(user: string, storage = browserStorage()): StudySession[] {
  try {
    const values: unknown = JSON.parse(storage?.getItem(key(user)) || '[]');
    return Array.isArray(values)
      ? values
          .filter(valid)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, 12)
      : [];
  } catch {
    return [];
  }
}
/** Reject changed/deleted content and work completed in another tab/device. No silent substitution. */
export function resumableStudySessions(
  data: Pick<AppData, 'questions' | 'cards' | 'attempts'>,
  sessions: StudySession[],
) {
  return sessions.filter((s) => {
    if (!valid(s)) return false;
    const items = s.kind === 'quiz' ? data.questions : data.cards.filter((c) => !c.deleted);
    if (
      !s.ids.every((id) => {
        const item = items.find((i) => i.id === id);
        return item && studySessionRevision(item) === s.revisions[id];
      })
    )
      return false;
    if (s.kind === 'cards') {
      const pending = s.ids.slice(s.index).map((id) => data.cards.find((c) => c.id === id)!);
      return (
        !s.ratings.some((r) => r.cardId === s.ids[s.index]) &&
        pending.every(
          (c) => JSON.stringify([c.nextReviewAt, c.reviewCount]) === s.reviewStates[c.id],
        )
      );
    }
    const current = data.questions.find((q) => q.id === s.ids[s.index])!;
    if (
      (s.selection !== null && s.selection >= current.options.length) ||
      (s.pending && s.pending.answer >= current.options.length)
    )
      return false;
    if (s.result || s.pending) return true;
    // If the current problem was answered elsewhere, do not reopen it as unanswered.
    if (
      data.attempts.some(
        (a) => a.questionId === current.id && Date.parse(a.createdAt) >= s.startedAt,
      )
    )
      return false;
    const completed = new Set(s.answers.map((a) => a.id));
    return s.ids.some(
      (id, index) =>
        index >= s.index &&
        !completed.has(id) &&
        !data.attempts.some((a) => a.questionId === id && Date.parse(a.createdAt) >= s.startedAt),
    );
  });
}
export function saveStudySession(user: string, session: StudySession, storage = browserStorage()) {
  try {
    if (!storage || !valid(session)) return;
    // Reopening the same set is one activity, not another item in the resume list.
    const signature = [...session.ids].sort().join('\u0000');
    const other = readStudySessions(user, storage).filter(
      (s) =>
        s.id !== session.id &&
        !(s.kind === session.kind && [...s.ids].sort().join('\u0000') === signature),
    );
    storage.setItem(key(user), JSON.stringify([session, ...other].slice(0, 12)));
  } catch {
    /* Unavailable storage never blocks learning. */
  }
}
export function removeStudySession(user: string, id: string, storage = browserStorage()) {
  try {
    const rest = readStudySessions(user, storage).filter((s) => s.id !== id);
    if (rest.length) storage?.setItem(key(user), JSON.stringify(rest));
    else storage?.removeItem(key(user));
  } catch {
    /* The current session can still complete without browser storage. */
  }
}
