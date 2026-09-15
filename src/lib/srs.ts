import { createEmptyCard, fsrs, Rating, type Card as FsrsCard } from 'ts-fsrs';
import type { Bucket, Card, SerializedFsrs } from './contracts';
export type SrsMode = 'FIXED' | 'FSRS';
export type ReviewRating = Exclude<Bucket, 'MASTERED'>;
const ratings = {
  AGAIN: Rating.Again,
  HARD: Rating.Hard,
  GOOD: Rating.Good,
  EASY: Rating.Easy,
} as const;
export const SRS_VERSION = 'ts-fsrs@5.4.2 / FSRS-6';
function restore(value: SerializedFsrs | undefined | null, now: Date): FsrsCard {
  if (!value) return createEmptyCard(now);
  if (
    !Number.isFinite(value.stability) ||
    !Number.isFinite(value.difficulty) ||
    !Number.isFinite(value.reps) ||
    ![0, 1, 2, 3].includes(value.state) ||
    Number.isNaN(Date.parse(value.due))
  )
    throw new Error('Invalid stored FSRS state');
  return {
    ...value,
    due: new Date(value.due),
    last_review: value.last_review ? new Date(value.last_review) : undefined,
  };
}
/** Both browser and server use this exact deterministic scheduler. Historical fixed reviews are not fabricated as FSRS history. */
export function scheduleCard(
  card: Card,
  rating: ReviewRating,
  mode: SrsMode = 'FIXED',
  retention = 0.9,
  now: Date | number = new Date(),
): Card {
  if (mode !== 'FIXED' && mode !== 'FSRS') throw new Error('Invalid SRS mode');
  if (!(rating in ratings)) throw new Error('Invalid review rating');
  const date = typeof now === 'number' ? new Date(now) : now;
  if (Number.isNaN(date.getTime())) throw new Error('Invalid review time');
  const consecutiveEasy = rating === 'EASY' ? card.consecutiveEasy + 1 : 0;
  const bucket: Bucket = consecutiveEasy >= 2 ? 'MASTERED' : rating;
  if (mode === 'FIXED')
    return {
      ...card,
      consecutiveEasy,
      bucket,
      fsrs: null,
      nextReviewAt: new Date(
        date.getTime() +
          { AGAIN: 600000, HARD: 86400000, GOOD: 259200000, EASY: 604800000 }[rating],
      ).toISOString(),
    };
  if (!Number.isFinite(retention) || retention < 0.8 || retention > 0.97)
    throw new Error('Retention must be between 0.80 and 0.97');
  const old = restore(card.fsrs, date);
  if (old.last_review && date < old.last_review)
    throw new Error('Review time precedes the last review');
  const engine = fsrs({
    request_retention: retention,
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: ['1m', '10m'],
    relearning_steps: ['10m'],
    maximum_interval: 36500,
  });
  const next = engine.next(old, date, ratings[rating]).card;
  return {
    ...card,
    consecutiveEasy,
    bucket,
    nextReviewAt: next.due.toISOString(),
    fsrs: { ...next, due: next.due.toISOString(), last_review: next.last_review?.toISOString() },
  };
}
export function isDue(card: Card, now = Date.now()) {
  return (
    !card.deleted &&
    (card.bucket !== 'MASTERED' || Boolean(card.fsrs)) &&
    new Date(card.nextReviewAt).getTime() <= now
  );
}
export function previewIntervals(card: Card, mode: SrsMode, retention = 0.9, now = Date.now()) {
  return (Object.keys(ratings) as ReviewRating[]).map((rating) => ({
    rating,
    due: scheduleCard(card, rating, mode, retention, now).nextReviewAt,
  }));
}
