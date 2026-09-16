import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordQuizAnswer, recordQuizCheck, quizSummary } from '../src/lib/quiz-learning';

test('an uncertain answer replay cannot inflate score or retain a stale check', () => {
  const receipt = { id: 'q1', correct: false };
  let answers = recordQuizAnswer([], receipt);
  answers = recordQuizAnswer(answers, receipt);
  assert.equal(answers.length, 1);
  assert.deepEqual(quizSummary(answers), { correct: 0, wrong: 1, checked: 0, revisit: 0 });
});
test('micro success and failure never rewrite the scored answer', () => {
  const initial = [
    { id: 'q1', correct: false },
    { id: 'q2', correct: true },
  ];
  const checked = recordQuizCheck(initial, 'q1', 'PASS');
  assert.equal(checked[0].correct, false);
  assert.deepEqual(quizSummary(checked), { correct: 1, wrong: 1, checked: 1, revisit: 0 });
  assert.deepEqual(quizSummary(recordQuizCheck(checked, 'q1', 'FAIL')), {
    correct: 1,
    wrong: 1,
    checked: 0,
    revisit: 1,
  });
  assert.deepEqual(initial, [
    { id: 'q1', correct: false },
    { id: 'q2', correct: true },
  ]);
});
test('skipped and unknown checks are not counted as understanding', () => {
  const initial = [{ id: 'q1', correct: false }];
  assert.deepEqual(recordQuizCheck(initial, 'missing', 'PASS'), initial);
  assert.deepEqual(quizSummary(recordQuizCheck(initial, 'q1', 'SKIP')), {
    correct: 0,
    wrong: 1,
    checked: 0,
    revisit: 0,
  });
});
