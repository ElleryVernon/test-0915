import type { Question } from './contracts';

/** A material is already a concrete scope; a stale subject must not hide its questions. */
export function quizScope(questions: Question[], subject: string, material: string) {
  return questions.filter((q) =>
    material ? q.materialId === material : !subject || q.subjectId === subject,
  );
}

export function quizPool(
  questions: Question[],
  latest: ReadonlyMap<string, { correct: boolean }>,
  priority: string,
) {
  if (priority === 'wrong') return questions.filter((q) => latest.get(q.id)?.correct === false);
  if (priority === 'new')
    return [...questions].sort((a, b) => Number(latest.has(a.id)) - Number(latest.has(b.id)));
  return questions;
}

export function quizQuantity(available: number, requested: number) {
  const maximum = Math.min(30, Math.max(0, Math.floor(available)));
  if (!maximum) return { count: 0, options: [] as number[] };
  const count = Math.min(
    maximum,
    Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 10),
  );
  const options = [...new Set([5, 10, 20, 30, maximum, count])]
    .filter((n) => n <= maximum)
    .sort((a, b) => a - b);
  return { count, options };
}
