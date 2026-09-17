import type { AppData, Bucket, Card, Subject } from '@/lib/contracts';
import { seoulDateKey } from '@/lib/home';
import { isDue } from '@/lib/srs';
import { readEssayDrafts, essayRevision } from '@/lib/study-drafts';
import { BUCKETS, dueCards, intervalLabel, wrongEssays, wrongQuestions } from './logic';

export type Rating = Exclude<Bucket, 'MASTERED'>;

/** The home review card uses the same 30 seconds per card (components/app.tsx). */
export const reviewMinutes = (count: number) => Math.max(1, Math.ceil(count / 2));

const DAY = 86400000;
const dayNumber = (key: string) => Date.parse(`${key}T00:00:00Z`) / DAY;
const addDays = (key: string, days: number) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export interface ExamCountdown {
  days: number;
  name: string;
  /** "중간고사 D-12" for the subject detail eyebrow. */
  label: string;
  /** "중간 D-12" for the compact subject row. */
  short: string;
}
/** Days are counted on the Seoul calendar; an exam that already passed shows nothing. */
export function examCountdown(
  subject: Pick<Subject, 'examName' | 'examDate'>,
  now: Date,
): ExamCountdown | null {
  if (!subject.examDate || !/^\d{4}-\d{2}-\d{2}$/.test(subject.examDate)) return null;
  const days = dayNumber(subject.examDate) - dayNumber(seoulDateKey(now));
  if (!Number.isInteger(days) || days < 0) return null;
  const name = subject.examName?.trim() || '시험';
  const tag = days === 0 ? 'D-day' : `D-${days}`;
  return {
    days,
    name,
    label: `${name} ${tag}`,
    short: `${name.replace(/고사$/, '') || name} ${tag}`,
  };
}

export interface SubjectSummary {
  materials: number;
  questions: number;
  essays: number;
  cards: number;
  due: number;
  again: number;
}
export function subjectSummary(
  data: Pick<AppData, 'materials' | 'questions' | 'essays' | 'cards'>,
  subjectId: string,
  now = Date.now(),
): SubjectSummary {
  const cards = data.cards.filter((c) => c.subjectId === subjectId && !c.deleted);
  return {
    materials: data.materials.filter((m) => m.subjectId === subjectId).length,
    questions: data.questions.filter((q) => q.subjectId === subjectId).length,
    essays: data.essays.filter((e) => e.subjectId === subjectId).length,
    cards: cards.length,
    due: dueCards(cards, now).length,
    again: cards.filter((c) => c.bucket === 'AGAIN').length,
  };
}
export function subjectMeta(summary: SubjectSummary) {
  if (!summary.materials && !summary.questions && !summary.cards)
    return '아직 자료가 없어요 · 올리면 문제·카드가 생겨요';
  return `자료 ${summary.materials} · 문제 ${summary.questions} · 카드 ${summary.cards}`;
}

export function examLead(exam: ExamCountdown) {
  if (exam.days === 0) return '시험 당일';
  return exam.days < 7 ? `시험 ${exam.days}일 전` : `시험 ${Math.floor(exam.days / 7)}주 전`;
}
/** A suggestion only when the subject's own numbers support it; cards cannot be traced to a unit. */
export function subjectInsight(
  summary: SubjectSummary,
  exam: ExamCountdown | null,
): { title: string; description: string } | null {
  if (!summary.materials) return null;
  if (summary.cards && summary.again)
    return {
      title: [
        exam ? examLead(exam) : '',
        `카드 ${summary.cards}장 중 ${summary.again}장이 "다시" 상자`,
      ]
        .filter(Boolean)
        .join(' · '),
      description: '자료로 문제를 더 만들어 볼까요?',
    };
  if (exam && exam.days <= 21 && !summary.questions)
    return {
      title: `${examLead(exam)} · 아직 문제가 없어요`,
      description: '자료로 문제를 만들어 볼까요?',
    };
  return null;
}

/** Materials only link to questions and essays; cards carry no material id, so none are counted here. */
export function materialMeta(
  data: Pick<AppData, 'questions' | 'essays'>,
  materialId: string,
): { text: string; empty: boolean } {
  const questions = data.questions.filter((q) => q.materialId === materialId).length;
  const essays = data.essays.filter((e) => e.materialId === materialId).length;
  if (!questions && !essays) return { text: '문제·카드 만들기', empty: true };
  return {
    text: [questions ? `문제 ${questions}` : '', essays ? `서술형 ${essays}` : '']
      .filter(Boolean)
      .join(' · '),
    empty: false,
  };
}

export interface StudyMethod {
  key: 'quiz' | 'essay' | 'wrong' | 'cards';
  label: string;
  meta: string;
  path: string;
}
export function studyMethods(
  data: Pick<AppData, 'questions' | 'essays' | 'attempts' | 'cards' | 'profile'>,
  drafts = readEssayDrafts(data.profile.id),
): StudyMethod[] {
  const attempted = new Set(data.attempts.map((a) => a.questionId).filter(Boolean));
  const wrong = wrongQuestions(data).length;
  const fresh = data.questions.filter((q) => !attempted.has(q.id)).length;
  const writing = drafts.filter((draft) => {
    const essay = data.essays.find(
      (e) => e.id === draft.essayId && essayRevision(e) === draft.revision,
    );
    return (
      essay &&
      (draft.answer.trim() || draft.selected.length || draft.order.length || draft.hint) &&
      !data.attempts.some(
        (a) => a.essayId === essay.id && Date.parse(a.createdAt) >= Date.parse(draft.updatedAt),
      )
    );
  }).length;
  const notes = wrong + wrongEssays(data).length;
  const live = data.cards.filter((c) => !c.deleted);
  const mastered = live.filter((c) => c.bucket === 'MASTERED').length;
  const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  return [
    {
      key: 'quiz',
      label: '문제 풀기',
      meta:
        join(wrong ? `틀린 ${wrong}` : '', fresh ? `새 문제 ${fresh}` : '') ||
        (data.questions.length ? '모두 풀었어요' : '자료로 만들 수 있어요'),
      path: '/quiz',
    },
    {
      key: 'essay',
      label: '서술형 코칭',
      meta:
        join(
          writing ? `작성 중 ${writing}` : '',
          data.essays.length ? `${data.essays.length}문제` : '',
        ) || '자료로 만들 수 있어요',
      path: '/essay',
    },
    {
      key: 'wrong',
      label: '오답노트',
      meta: notes ? `${notes}문제` : '틀린 문제가 없어요',
      path: '/wrong-notes',
    },
    {
      key: 'cards',
      label: '카드 보관함',
      meta: live.length
        ? join(`${live.length}장`, mastered ? `암기완료 ${mastered}` : '')
        : '첫 카드를 만들어 보세요',
      path: '/flashcards',
    },
  ];
}

const permanentlyMastered = (card: Card) => card.bucket === 'MASTERED' && !card.fsrs;
export function libraryGroups(cards: Card[], now = Date.now()) {
  const byDue = (a: Card, b: Card) =>
    Number(permanentlyMastered(a)) - Number(permanentlyMastered(b)) ||
    Date.parse(a.nextReviewAt) - Date.parse(b.nextReviewAt);
  return {
    today: cards.filter((c) => isDue(c, now)).sort(byDue),
    later: cards.filter((c) => !isDue(c, now)).sort(byDue),
  };
}
export function whenLabel(card: Card, now = Date.now()): { text: string; strong: boolean } {
  if (permanentlyMastered(card)) return { text: '암기완료', strong: true };
  if (isDue(card, now)) return { text: '지금', strong: true };
  return { text: `${intervalLabel(card.nextReviewAt, now)} 뒤`, strong: false };
}

export function bucketDistribution(cards: Card[]) {
  const total = cards.length;
  return BUCKETS.map((b) => {
    const count = cards.filter((c) => c.bucket === b.id).length;
    return { id: b.id, label: b.label, count, share: total ? count / total : 0 };
  });
}

/** Earliest future review: today's learning steps must not disappear behind a later day. */
export function nextReviewDay(cards: Card[], now: Date) {
  const upcoming = cards
    .filter(
      (card) =>
        !card.deleted &&
        !permanentlyMastered(card) &&
        Number.isFinite(Date.parse(card.nextReviewAt)) &&
        !isDue(card, now.getTime()),
    )
    .sort((a, b) => Date.parse(a.nextReviewAt) - Date.parse(b.nextReviewAt));
  const first = upcoming[0];
  if (!first) return null;
  const today = seoulDateKey(now);
  const date = seoulDateKey(new Date(first.nextReviewAt));
  const minute = Math.floor(Date.parse(first.nextReviewAt) / 60000);
  const count = upcoming.filter((card) =>
    date === today
      ? Math.floor(Date.parse(card.nextReviewAt) / 60000) === minute
      : seoulDateKey(new Date(card.nextReviewAt)) === date,
  ).length;
  const [, month, day] = date.split('-').map(Number);
  return {
    date,
    count,
    when:
      date === today
        ? `${intervalLabel(first.nextReviewAt, now.getTime())} 뒤`
        : date === addDays(today, 1)
          ? '내일'
          : `${month}월 ${day}일`,
  };
}

export interface SessionRating {
  cardId: string;
  rating: Rating;
}
/** Latest rating per card, so a card retried in the same session is counted once. */
export function sessionResult(ratings: SessionRating[]) {
  const latest = new Map<string, Rating>();
  for (const r of ratings) latest.set(r.cardId, r.rating);
  const rated = [...latest.entries()];
  const total = rated.length;
  return {
    total,
    counts: BUCKETS.slice(0, 4).map((b) => {
      const count = rated.filter(([, rating]) => rating === b.id).length;
      return { id: b.id as Rating, label: b.label, count, share: total ? count / total : 0 };
    }),
    againIds: rated.filter(([, rating]) => rating === 'AGAIN').map(([id]) => id),
  };
}
export function sessionDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}분 ${seconds % 60}초` : `${seconds}초`;
}
/** Server streaks count today only once something was recorded today; a finished session always counts. */
export function streakThroughToday(
  data: Pick<AppData, 'profile' | 'stats' | 'attempts'>,
  reviewedCount: number,
  now: Date,
) {
  const today = seoulDateKey(now);
  const counted =
    data.stats.todayCards > 0 ||
    data.attempts.some((a) => seoulDateKey(new Date(a.createdAt)) === today);
  return counted || !reviewedCount ? data.profile.streak : data.profile.streak + 1;
}

/** First paragraph is the answer; after 140 characters the explanation waits behind "더 보기". */
export function splitBack(back: string) {
  const [answer = '', ...rest] = back.trim().split(/\n\s*\n/);
  const explanation = rest.join('\n\n');
  return { answer, explanation, collapsed: answer.length > 140 && explanation.length > 0 };
}
export function reviewOrdinal(card: Pick<Card, 'reviewCount' | 'fsrs'>) {
  const done = card.reviewCount ?? card.fsrs?.reps;
  if (done === undefined) return '';
  return done === 0 ? '첫 복습' : `${done + 1}번째 복습`;
}

type CountStorage = Pick<Storage, 'getItem' | 'setItem'>;
const sessionKey = (userId: string) => `memoryz-review-sessions-v1:${encodeURIComponent(userId)}`;
function browserStorage(): CountStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
export const MASTERY_HINT_SESSIONS = 3;
export function completedReviewSessions(userId: string, storage = browserStorage()) {
  try {
    const value = Number.parseInt(storage?.getItem(sessionKey(userId)) || '0', 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
export function recordReviewSession(userId: string, storage = browserStorage()) {
  try {
    storage?.setItem(sessionKey(userId), String(completedReviewSessions(userId, storage) + 1));
  } catch {
    /* A blocked storage only keeps the mastery hint visible longer. */
  }
}
