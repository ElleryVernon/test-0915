import type { Question, Subject } from './contracts';
import { studySessionRevision } from './study-sessions';

export function quizSessionRevisions(questions: Question[]) {
  return Object.fromEntries(
    questions.map((question) => [question.id, studySessionRevision(question)]),
  );
}
/** A live session is indivisible: removing an ID must never slide another question beneath its answer. */
export function resolveQuizSession(
  ids: string[] | null,
  revisions: Record<string, string>,
  available: Question[],
) {
  if (ids === null) return { questions: null, invalid: false };
  const byId = new Map(available.map((question) => [question.id, question]));
  const questions: Question[] = [];
  for (const id of ids) {
    const question = byId.get(id);
    if (!question || studySessionRevision(question) !== revisions[id])
      return { questions: null, invalid: true };
    questions.push(question);
  }
  return { questions: questions.length ? questions : null, invalid: !questions.length };
}
export function newQuizSession(
  questions: Question[],
  newId: () => string = () => crypto.randomUUID(),
) {
  return {
    id: newId(),
    ids: questions.map((q) => q.id),
    revisions: quizSessionRevisions(questions),
  };
}
export function folderUploadPath(folder: string, subjects: Pick<Subject, 'id'>[]) {
  return subjects.some((subject) => subject.id === folder)
    ? `/subjects/${encodeURIComponent(folder)}?upload=1`
    : '/subjects?upload=1';
}
