import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { studyInvitation } from '../src/lib/study-invitation';
import { essayRevision, type EssayDraft } from '../src/lib/study-drafts';
import type { AppData, Card, Essay, Question, ScreenProps } from '../src/lib/contracts';
import { StudyHome } from '../src/components/study/subjects';

const now = Date.parse('2026-09-18T03:00:00Z');
const essay: Essay = {
  id: 'essay 1',
  subjectId: 'bio',
  materialId: 'source',
  prompt: '효소의 역할을 설명하세요.',
  keywords: ['효소'],
  distractors: ['산소'],
  modelAnswer: '모범 답안',
  citation: '근거',
};
const question: Question = {
  id: 'question 1',
  subjectId: 'bio',
  materialId: 'source',
  prompt: '효소의 특징으로 옳은 것은?',
  options: ['가', '나'],
  answer: 1,
  explanation: '해설',
  citation: '근거',
  past: '',
  future: '',
};
const card: Card = {
  id: 'card 1',
  subjectId: 'bio',
  front: '효소란?',
  back: '생체 촉매',
  type: 'CONCEPT',
  bucket: 'AGAIN',
  consecutiveEasy: 0,
  nextReviewAt: '2026-09-18T00:00:00Z',
  deleted: false,
};
const data = (overrides: Partial<AppData> = {}): AppData =>
  ({
    profile: { id: 'study-invitation-test', name: '학생', completedSubjects: [] },
    subjects: [{ id: 'bio', name: '생화학' }],
    materials: [],
    questions: [question],
    essays: [essay],
    cards: [],
    attempts: [],
    stats: {},
    ...overrides,
  }) as AppData;
const draft = (overrides: Partial<EssayDraft> = {}): EssayDraft => ({
  essayId: essay.id,
  revision: essayRevision(essay),
  stage: 4,
  selected: [],
  order: [],
  hint: false,
  answer: '효소는 반응을 촉진합니다.',
  updatedAt: '2026-09-18T01:00:00Z',
  ...overrides,
});

test('a meaningful current draft takes precedence over due cards and links to that exact essay', () => {
  const result = studyInvitation(data({ cards: [card] }), [draft()], now)!;
  assert.equal(result.kind, 'resume');
  assert.equal(result.href, '/essay?essay=essay%201');
  assert.equal(result.prompt, essay.prompt);
  assert.match(result.context, /생화학/);
});

test('empty, changed, removed and already submitted drafts never claim to be in progress', () => {
  const submitted = {
    id: 'a',
    essayId: essay.id,
    createdAt: '2026-09-18T02:00:00Z',
    correct: true,
    score: 100,
    answer: '답',
  };
  for (const [fixture, candidate] of [
    [data(), draft({ answer: '  ' })],
    [data(), draft({ revision: 'old revision' })],
    [data({ essays: [] }), draft()],
    [data({ attempts: [submitted] }), draft()],
    [data(), draft({ updatedAt: 'bad date' })],
  ] as const) {
    assert.notEqual(studyInvitation(fixture, [candidate], now)?.kind, 'resume');
  }
  assert.equal(
    studyInvitation(
      data({ attempts: [submitted] }),
      [draft({ updatedAt: '2026-09-18T02:30:00Z' })],
      now,
    )?.kind,
    'resume',
  );
});

test('a single due card is offered, excluding trash, future reviews and permanently mastered cards', () => {
  const cards = [
    { ...card, id: 'trash', deleted: true },
    { ...card, id: 'mastered', bucket: 'MASTERED' as const },
    { ...card, id: 'future', nextReviewAt: '2026-09-20T00:00:00Z' },
    card,
  ];
  const result = studyInvitation(data({ cards }), [], now)!;
  assert.equal(result.kind, 'card');
  assert.equal(result.href, '/flashcards?subject=bio&card=card%201');
  assert.equal(result.action, '한 장 복습하기');
  assert.equal(studyInvitation(data({ cards: cards.slice(0, 3) }), [], now)?.kind, 'question');
});

test('fresh question links to a one-question session; first attempt advances the suggestion', () => {
  const second = { ...question, id: 'question 2' };
  const fixture = data({ questions: [question, second] });
  assert.equal(studyInvitation(fixture, [], now)?.href, '/quiz?question=question%201');
  fixture.attempts = [
    {
      id: 'a',
      questionId: question.id,
      correct: true,
      score: 100,
      answer: '1',
      createdAt: '2026-09-18T02:00:00Z',
    },
  ];
  assert.equal(studyInvitation(fixture, [], now)?.href, '/quiz?question=question%202');
  assert.deepEqual(
    fixture.questions.map((q) => q.id),
    [question.id, second.id],
  );
});

test('completed content is never labelled new; no due card is never described as due', () => {
  const attempts = [
    {
      id: 'a',
      questionId: question.id,
      correct: true,
      score: 100,
      answer: '1',
      createdAt: '2026-09-18T02:00:00Z',
    },
  ];
  assert.equal(studyInvitation(data({ attempts }), [], now)?.kind, 'essay');
  assert.equal(studyInvitation(data({ attempts, essays: [] }), [], now)?.kind, 'revisit');
  const result = studyInvitation(
    data({ questions: [], essays: [], cards: [{ ...card, nextReviewAt: '2026-09-20T00:00:00Z' }] }),
    [],
    now,
  )!;
  assert.equal(result.href, '/flashcards');
  assert.match(result.description, /복습할 카드는 없어요/);
  assert.equal(
    studyInvitation(
      data({ questions: [], essays: [], cards: [{ ...card, deleted: true }] }),
      [],
      now,
    ),
    null,
  );
});

test('ready study hub renders the invitation before all four methods, without disclosing an answer', () => {
  const html = renderToStaticMarkup(
    createElement(StudyHome, {
      data: data(),
      path: '/study',
      navigate() {},
      back() {},
      toast() {},
      async refresh() {},
    } as ScreenProps),
  );
  assert.ok(html.indexOf('data-study-invitation') < html.indexOf('aria-label="학습 방법"'));
  for (const label of ['플래시카드', '서술형 도우미', '문제은행', '오답노트', '내 과목·자료'])
    assert.ok(html.includes(label));
  assert.ok(html.includes('한 문제 풀기'));
  assert.ok(!html.includes(essay.modelAnswer));
  assert.ok(!html.includes('오늘의 복습 카드'));
});
