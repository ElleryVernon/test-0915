import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Question } from '../src/lib/contracts';
import { quizPool, quizQuantity, quizScope } from '../src/lib/quiz-setup';
import { latestAttempts } from '../src/components/study/logic';
import type { StudyAttempt } from '../src/lib/contracts';

const questions = [
  { id: 'old', subjectId: 'bio', materialId: 'bio1' },
  { id: 'new', subjectId: 'bio', materialId: 'bio1' },
  { id: 'other', subjectId: 'math', materialId: 'math1' },
] as Question[];

test('material scope takes precedence over an unrelated subject; subject-only scope stays intact', () => {
  assert.deepEqual(
    quizScope(questions, 'math', 'bio1').map((q) => q.id),
    ['old', 'new'],
  );
  assert.deepEqual(
    quizScope(questions, 'math', '').map((q) => q.id),
    ['other'],
  );
  assert.deepEqual(quizScope(questions, '', ''), questions);
  assert.deepEqual(quizScope(questions, '', 'deleted-material'), []);
});
test('unanswered first preserves solved questions and source order without mutating the source', () => {
  const latest = new Map([['old', { correct: true }]]);
  assert.deepEqual(
    quizPool(questions, latest, 'new').map((q) => q.id),
    ['new', 'other', 'old'],
  );
  assert.deepEqual(
    quizPool(questions, latest, 'all').map((q) => q.id),
    ['old', 'new', 'other'],
  );
  assert.deepEqual(
    questions.map((q) => q.id),
    ['old', 'new', 'other'],
  );
});
test('wrong-only uses the latest answer, excludes unanswered, and recovers after a correct retry', () => {
  const attempts = [
    { questionId: 'old', correct: true, createdAt: '2026-09-16T01:00:00Z' },
    { questionId: 'old', correct: false, createdAt: '2026-09-15T01:00:00Z' },
    { questionId: 'other', correct: false, createdAt: '2026-09-16T01:00:00Z' },
  ] as StudyAttempt[];
  assert.deepEqual(
    quizPool(questions, latestAttempts(attempts, 'questionId'), 'wrong').map((q) => q.id),
    ['other'],
  );
  assert.deepEqual(quizPool(questions, new Map(), 'wrong'), []);
});
test('16 available questions never offer 20 or 30; clamping has an explicitly selected option', () => {
  assert.deepEqual(quizQuantity(16, 10), { count: 10, options: [5, 10, 16] });
  assert.deepEqual(quizQuantity(16, 30), { count: 16, options: [5, 10, 16] });
  assert.deepEqual(quizQuantity(3, 10), { count: 3, options: [3] });
  assert.deepEqual(quizQuantity(0, 10), { count: 0, options: [] });
});
test('scope changes preserve intent while the effective selection and session length always agree', () => {
  for (const available of [0, 1, 3, 5, 7, 16, 20, 30, 40]) {
    for (const requested of [5, 10, 16, 20, 30]) {
      const { count, options } = quizQuantity(available, requested);
      assert.ok(count <= available && count <= 30);
      assert.equal(count, Array.from({ length: available }).slice(0, count).length);
      assert.ok(options.every((n) => n > 0 && n <= available));
      assert.equal(options.filter((n) => n === count).length, count ? 1 : 0);
    }
  }
  assert.equal(quizQuantity(3, 10).count, 3);
  assert.equal(quizQuantity(16, 10).count, 10);
});
