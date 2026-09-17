import type { AppData, Card } from '@/lib/contracts';
import { isDue } from '@/lib/srs';
export type CardScope = 'all' | 'due' | 'mastered';
export type CardSort = 'due' | 'name';
export const cardTitle = (card: Card, data: AppData) =>
  (card.diagram && card.sourceQuestionId
    ? data.questions.find((q) => q.id === card.sourceQuestionId)?.prompt
    : undefined) || card.front;
export const permanentlyMastered = (card: Card) => card.bucket === 'MASTERED' && !card.fsrs;
export function libraryCards(
  data: AppData,
  cards: Card[],
  options: {
    subject: string;
    scope: CardScope;
    query: string;
    bucket: string;
    sort: CardSort;
    trash: boolean;
  },
  now = Date.now(),
) {
  const query = options.query.trim().toLocaleLowerCase('ko');
  return cards
    .filter(
      (c) =>
        c.deleted === options.trash &&
        (!options.subject || c.subjectId === options.subject) &&
        (options.trash ||
          options.scope === 'all' ||
          (options.scope === 'due' ? isDue(c, now) : c.bucket === 'MASTERED')) &&
        (options.trash || !options.bucket || c.bucket === options.bucket) &&
        (!query ||
          `${cardTitle(c, data)} ${data.subjects.find((s) => s.id === c.subjectId)?.name || ''}`
            .toLocaleLowerCase('ko')
            .includes(query)),
    )
    .sort(
      (a, b) =>
        (options.sort === 'due'
          ? Number(permanentlyMastered(a)) - Number(permanentlyMastered(b)) ||
            (Date.parse(a.nextReviewAt) || 0) - (Date.parse(b.nextReviewAt) || 0)
          : 0) ||
        cardTitle(a, data).localeCompare(cardTitle(b, data), 'ko', { numeric: true }) ||
        a.id.localeCompare(b.id),
    );
}
