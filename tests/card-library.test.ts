import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CardLibrary } from '../src/components/study/card-library';
import { libraryCards, cardTitle } from '../src/components/study/card-library-model';
import type { AppData, Card, ScreenProps } from '../src/lib/contracts';
const now = Date.now();
const make = (id: string, patch: Partial<Card> = {}): Card => ({
  id,
  subjectId: 'bio',
  front: `개념 ${id}`,
  back: '숨겨진 정답',
  type: 'CONCEPT',
  bucket: 'GOOD',
  consecutiveEasy: 0,
  nextReviewAt: new Date(now - 1000).toISOString(),
  deleted: false,
  ...patch,
});
const cards = [
  make('10'),
  make('2'),
  make('future', { nextReviewAt: new Date(now + 86400000).toISOString() }),
  make('mastered', { bucket: 'MASTERED' }),
  make('deleted', { deleted: true }),
  make('other', { subjectId: 'math' }),
];
const data = {
  cards,
  subjects: [
    { id: 'bio', name: '생명과학' },
    { id: 'math', name: '수학' },
  ],
  questions: [],
  materials: [],
  profile: { id: 'card-library-test' },
} as unknown as AppData;
const options = {
  subject: 'bio',
  scope: 'all' as const,
  query: '',
  bucket: '',
  sort: 'due' as const,
  trash: false,
};
test('library filtering intersects subject, due scope, memory status and query without mutation', () => {
  const before = cards.map((c) => c.id);
  assert.deepEqual(
    libraryCards(data, cards, { ...options, scope: 'due' }, now).map((c) => c.id),
    ['2', '10'],
  );
  assert.deepEqual(
    libraryCards(data, cards, { ...options, scope: 'due', bucket: 'HARD' }, now),
    [],
  );
  assert.equal(libraryCards(data, cards, { ...options, query: '수학' }, now).length, 0);
  assert.equal(
    libraryCards(data, cards, { ...options, subject: '', query: '수학' }, now)[0].id,
    'other',
  );
  assert.deepEqual(
    cards.map((c) => c.id),
    before,
  );
});
test('permanent mastery is excluded from due; trash only returns scoped deleted cards; names sort numerically', () => {
  assert.deepEqual(
    libraryCards(data, cards, { ...options, scope: 'mastered' }, now).map((c) => c.id),
    ['mastered'],
  );
  assert.deepEqual(
    libraryCards(data, cards, { ...options, trash: true }, now).map((c) => c.id),
    ['deleted'],
  );
  const sorted = libraryCards(data, cards, { ...options, sort: 'name' }, now).map((c) => c.id);
  assert.ok(sorted.indexOf('2') < sorted.indexOf('10'));
  const diagram = make('diagram', { sourceQuestionId: 'q', diagram: {} as Card['diagram'] });
  assert.equal(
    cardTitle(diagram, {
      ...data,
      questions: [{ id: 'q', prompt: '원본 질문' }] as AppData['questions'],
    }),
    '원본 질문',
  );
});
test('subject uses shared collection in place, without another library link or other-subject cards', () => {
  const props = {
    data,
    path: '/subjects/bio',
    navigate: () => {},
    back: () => {},
    refresh: async () => {},
    toast: () => {},
  } as unknown as ScreenProps;
  const html = renderToStaticMarkup(createElement(CardLibrary, { props, subjectId: 'bio' }));
  assert.ok(html.includes('data-card-library="bio"'));
  assert.ok(html.includes('개념 2'));
  assert.ok(!html.includes('개념 other'));
  assert.ok(!html.includes('숨겨진 정답'));
  assert.ok(!html.includes('카드 보관함 열기'));
  assert.ok(!html.includes('카드의 과목'));
  assert.ok(html.includes('지금 복습 2장'));
});
