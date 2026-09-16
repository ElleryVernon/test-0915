import type { MicroResult } from './explanation-types';
export type QuizAnswer = { id: string; correct: boolean; microResult?: MicroResult };
/** A replay replaces the same question's receipt instead of increasing the score denominator. */
export function recordQuizAnswer(answers: QuizAnswer[], answer: QuizAnswer): QuizAnswer[] {
  return [...answers.filter((item) => item.id !== answer.id), answer];
}
export function recordQuizCheck(
  answers: QuizAnswer[],
  questionId: string,
  microResult: MicroResult,
): QuizAnswer[] {
  return answers.map((item) => (item.id === questionId ? { ...item, microResult } : item));
}
export function quizSummary(answers: QuizAnswer[]) {
  const unique = [...new Map(answers.map((item) => [item.id, item])).values()];
  return {
    correct: unique.filter((item) => item.correct).length,
    wrong: unique.filter((item) => !item.correct).length,
    checked: unique.filter((item) => item.microResult === 'PASS').length,
    revisit: unique.filter((item) => item.microResult === 'FAIL').length,
  };
}
