import test from 'node:test';
import assert from 'node:assert/strict';
import { newQuizSession, resolveQuizSession, folderUploadPath } from '../src/lib/quiz-session';
import type { Question } from '../src/lib/contracts';
const a = {
  id: 'a',
  prompt: '첫 질문',
  options: ['정답', '오답'],
  answer: 0,
  explanation: '설명',
  citation: '근거',
  past: '',
  future: '',
  subjectId: 's',
  materialId: 'm',
} as Question;
const b = { ...a, id: 'b', prompt: '다음 질문' };
test('deleted or changed question invalidates the whole live session instead of shifting a result', () => {
  const session = newQuizSession([a, b], () => 'one');
  assert.equal(resolveQuizSession(session.ids, session.revisions, [b]).invalid, true);
  assert.equal(
    resolveQuizSession(session.ids, session.revisions, [{ ...a, prompt: '변경' }, b]).invalid,
    true,
  );
  assert.deepEqual(resolveQuizSession(session.ids, session.revisions, [b, a]).questions, [a, b]);
});
test('genuinely new sessions get separate identities; upload retains a valid folder', () => {
  assert.notEqual(newQuizSession([a]).id, newQuizSession([b]).id);
  assert.equal(folderUploadPath('s', [{ id: 's' }]), '/subjects/s?upload=1');
  assert.equal(folderUploadPath('removed', [{ id: 's' }]), '/subjects?upload=1');
});
