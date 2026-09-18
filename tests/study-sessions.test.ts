import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppData, Card, Question, Essay } from '../src/lib/contracts';
import {
  readStudySessions,
  saveStudySession,
  removeStudySession,
  resumableStudySessions,
  studySessionRevision,
  type QuizSession,
  type CardSession,
} from '../src/lib/study-sessions';
import { studyResumeItems, studyInvitation } from '../src/lib/study-invitation';
import { essayRevision, type EssayDraft } from '../src/lib/study-drafts';

const now = Date.parse('2026-09-18T05:00:00Z');
const question = (id: string): Question => ({
  id,
  subjectId: 'bio',
  materialId: 'm',
  prompt: id + '의 정답은?',
  options: ['1', '2'],
  answer: 0,
  explanation: '해설',
  citation: '',
  past: '',
  future: '',
});
const card = (id: string): Card => ({
  id,
  subjectId: 'bio',
  front: id + ' 개념은?',
  back: '정답',
  type: 'CONCEPT',
  bucket: 'AGAIN',
  nextReviewAt: '2026-09-18T00:00:00Z',
  consecutiveEasy: 0,
  deleted: false,
  reviewCount: 0,
});
const questions = [question('q1'), question('q2')];
const cards = [card('c1'), card('c2')];
const essay: Essay = {
  id: 'e1',
  subjectId: 'bio',
  materialId: 'm',
  prompt: '광합성을 설명하세요.',
  keywords: ['빛'],
  distractors: [],
  modelAnswer: '모범 답안',
  citation: '',
};
const data = {
  questions,
  cards,
  essays: [essay],
  attempts: [],
  subjects: [{ id: 'bio', name: '생명과학' }],
} as unknown as AppData;
const quiz = (overrides: Partial<QuizSession> = {}): QuizSession => ({
  kind: 'quiz',
  id: 'quiz-1',
  ids: questions.map((q) => q.id),
  revisions: Object.fromEntries(questions.map((q) => [q.id, studySessionRevision(q)])),
  index: 0,
  selection: 1,
  result: null,
  pending: null,
  answers: [],
  startedAt: Date.parse('2026-09-18T01:00:00Z'),
  updatedAt: '2026-09-18T02:00:00Z',
  ...overrides,
});
const review = (overrides: Partial<CardSession> = {}): CardSession => ({
  kind: 'cards',
  id: 'cards-1',
  ids: cards.map((c) => c.id),
  revisions: Object.fromEntries(cards.map((c) => [c.id, studySessionRevision(c)])),
  reviewStates: Object.fromEntries(
    cards.map((c) => [c.id, JSON.stringify([c.nextReviewAt, c.reviewCount])]),
  ),
  index: 1,
  flipped: true,
  ratings: [{ cardId: 'c1', rating: 'GOOD' }],
  startedAt: Date.parse('2026-09-18T01:00:00Z'),
  updatedAt: '2026-09-18T03:00:00Z',
  ...overrides,
});
const draft: EssayDraft = {
  essayId: 'e1',
  revision: essayRevision(essay),
  stage: 4,
  selected: [],
  order: [],
  hint: false,
  answer: '광합성은 빛을 이용합니다.',
  updatedAt: '2026-09-18T01:00:00Z',
};
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};

test('three interrupted features sort by actual recency, with all activities independently reachable', () => {
  const items = studyResumeItems(data, [draft], [quiz(), review()], now);
  assert.deepEqual(
    items.map((i) => i.id),
    ['cards:cards-1', 'quiz:quiz-1', 'essay:e1'],
  );
  assert.equal(items[0].href, '/flashcards?checkpoint=cards-1');
  assert.match(items[0].progress, /1\/2장 복습 · 정답 확인 중/);
  assert.equal(items[1].href, '/quiz?checkpoint=quiz-1');
  assert.match(items[1].progress, /첫 문제 답 선택 중 · 전체 2문제/);
});
test('multiple essays remain separate rather than silently discarding all except one', () => {
  const second = { ...essay, id: 'e2', prompt: '호흡을 설명하세요.' };
  const items = studyResumeItems(
    { ...data, essays: [essay, second] },
    [
      draft,
      {
        ...draft,
        essayId: 'e2',
        revision: essayRevision(second),
        updatedAt: '2026-09-18T04:00:00Z',
      },
    ],
    [],
    now,
  );
  assert.deepEqual(
    items.map((i) => i.id),
    ['essay:e2', 'essay:e1'],
  );
});
test('selected option, feedback, pending idempotency key and card side survive storage reload', () => {
  const s = storage();
  const q = quiz({ pending: { requestId: 'request-1', questionId: 'q1', answer: 1 } });
  saveStudySession('u', q, s);
  saveStudySession('u', review(), s);
  assert.deepEqual(readStudySessions('u', s), [review(), q]);
  assert.equal(resumableStudySessions(data, readStudySessions('u', s)).length, 2);
  assert.deepEqual(readStudySessions('another-user', s), []);
});
test('same question set is deduplicated; completion removes only the named activity', () => {
  const s = storage();
  saveStudySession('u', quiz(), s);
  saveStudySession('u', quiz({ id: 'quiz-new', ids: ['q2', 'q1'] }), s);
  saveStudySession('u', review(), s);
  assert.equal(readStudySessions('u', s).length, 2);
  removeStudySession('u', 'quiz-new', s);
  assert.deepEqual(
    readStudySessions('u', s).map((v) => v.kind),
    ['cards'],
  );
});
test('changed, removed, deleted and separately reviewed content cannot reopen stale progress', () => {
  assert.deepEqual(
    resumableStudySessions(
      { ...data, questions: [{ ...questions[0], options: ['변경', '보기'] }, questions[1]] },
      [quiz()],
    ),
    [],
  );
  assert.deepEqual(resumableStudySessions({ ...data, questions: [questions[1]] }, [quiz()]), []);
  assert.deepEqual(
    resumableStudySessions({ ...data, cards: [cards[0], { ...cards[1], deleted: true }] }, [
      review(),
    ]),
    [],
  );
  assert.deepEqual(
    resumableStudySessions({ ...data, cards: [cards[0], { ...cards[1], reviewCount: 1 }] }, [
      review(),
    ]),
    [],
  );
  assert.deepEqual(resumableStudySessions(data, [quiz({ selection: 99 })]), []);
  assert.deepEqual(resumableStudySessions(data, [review({ index: 2 })]), []);
});
test('another-device answer is not offered as unanswered, while an uncertain request remains retryable', () => {
  const changed = {
    ...data,
    attempts: [
      {
        id: 'a',
        questionId: 'q1',
        answer: '1',
        correct: false,
        score: 0,
        createdAt: '2026-09-18T02:30:00Z',
      },
    ],
  };
  assert.deepEqual(resumableStudySessions(changed, [quiz()]), []);
  assert.equal(
    resumableStudySessions(changed, [
      quiz({ pending: { requestId: 'same-id', questionId: 'q1', answer: 1 } }),
    ]).length,
    1,
  );
});
test('last answer feedback can be resumed until the learner finishes that stage', () => {
  const q = quiz({
    index: 1,
    answers: [
      { id: 'q1', correct: true },
      { id: 'q2', correct: false },
    ],
    result: { correct: false, explanation: '해설', citation: '' },
  });
  const items = studyResumeItems(data, [], [q], now);
  assert.equal(items[0].action, '풀이 결과 이어보기');
  assert.match(items[0].progress, /2\/2문제 완료 · 결과 확인 중/);
});
test('malformed/blocked storage cannot break the learning page', () => {
  assert.deepEqual(
    readStudySessions('u', { getItem: () => '{', setItem() {}, removeItem() {} }),
    [],
  );
  const s = {
    getItem() {
      throw Error('denied');
    },
    setItem() {
      throw Error('denied');
    },
    removeItem() {
      throw Error('denied');
    },
  };
  assert.doesNotThrow(() => saveStudySession('u', quiz(), s));
  assert.doesNotThrow(() => removeStudySession('u', 'quiz-1', s));
  assert.deepEqual(readStudySessions('u', s), []);
});
test('finished-today state acknowledges work without pretending all content has been mastered', () => {
  const completed = {
    ...data,
    cards: [],
    essays: [],
    attempts: questions.map((q) => ({
      id: 'a' + q.id,
      questionId: q.id,
      answer: '0',
      correct: true,
      score: 100,
      createdAt: '2026-09-18T04:00:00Z',
    })),
    stats: { todayQuestions: 2, todayCards: 0, accuracy: 100, studyMinutes: 1, weekly: [] },
  } as AppData;
  assert.deepEqual(studyResumeItems(completed, [], [], now), []);
  assert.match(studyInvitation(completed, [], now)!.heading.join(' '), /잘 쌓았어요/);
  assert.match(studyInvitation(completed, [], now)!.description, /쉬어도 좋아요/);
});
