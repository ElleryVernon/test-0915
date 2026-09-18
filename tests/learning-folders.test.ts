import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppData, Card, ScreenProps } from '../src/lib/contracts';
import { learningFolders, inLearningFolder } from '../src/lib/learning-folders';
import { LearningFolders } from '../src/components/study/learning-folders';
import { CardLibrary } from '../src/components/study/card-library';
const now = Date.parse('2026-09-18T03:00:00Z');
const card = (id: string, subjectId: string, patch: Partial<Card> = {}): Card => ({
  id,
  subjectId,
  front: `front-${id}`,
  back: 'answer',
  type: 'CONCEPT',
  bucket: 'GOOD',
  consecutiveEasy: 0,
  nextReviewAt: new Date(now - 1).toISOString(),
  deleted: false,
  ...patch,
});
const data = {
  profile: { id: 'folder-test' },
  subjects: [
    { id: 'math', name: '수학', semester: '2026년 2학기', cardCount: 900 },
    { id: 'bio', name: '생명과학', semester: '2026년 2학기', cardCount: 0 },
    { id: 'empty', name: '국어', semester: '2026년 1학기', materialCount: 300 },
  ],
  materials: [{ id: 'm', subjectId: 'bio' }],
  cards: [
    card('due', 'bio'),
    card('later', 'math', { nextReviewAt: new Date(now + 3600000).toISOString() }),
    card('deleted', 'bio', { deleted: true }),
    card('mastered', 'math', { bucket: 'MASTERED' }),
  ],
  questions: [
    { id: 'q1', subjectId: 'bio' },
    { id: 'q2', subjectId: 'bio', savedToNotes: true },
    { id: 'q3', subjectId: 'math' },
    { id: 'q4', subjectId: 'math' },
  ],
  essays: [
    { id: 'e1', subjectId: 'bio' },
    { id: 'e2', subjectId: 'math' },
  ],
  attempts: [
    { questionId: 'q1', correct: false, createdAt: '2026-09-01' },
    { questionId: 'q1', correct: true, createdAt: '2026-09-02' },
    { questionId: 'q3', correct: true, createdAt: '2026-09-01' },
    { questionId: 'q3', correct: false, createdAt: '2026-09-02' },
    { essayId: 'e1', score: 40, createdAt: '2026-09-01' },
    { essayId: 'e1', score: 100, createdAt: '2026-09-02' },
    { essayId: 'e2', score: 80, createdAt: '2026-09-02' },
  ],
} as unknown as AppData;

test('folder counts use live records; deleted cards and permanent mastery are never due', () => {
  const folders = learningFolders(data, 'cards', now);
  assert.deepEqual(
    folders.map(({ id, total, due }) => ({ id, total, due })),
    [
      { id: 'bio', total: 1, due: 1 },
      { id: 'empty', total: 0, due: 0 },
      { id: 'math', total: 2, due: 0 },
    ],
  );
  assert.equal(learningFolders(data, 'materials', now).find((x) => x.id === 'empty')?.total, 0);
});
test('weak folders use latest attempts, saved unattempted questions and essays below full score', () => {
  const folders = learningFolders(data, 'notes', now);
  assert.equal(folders.find((x) => x.id === 'bio')?.total, 1);
  assert.equal(folders.find((x) => x.id === 'math')?.total, 2);
  assert.equal(folders.find((x) => x.id === 'empty')?.total, 0);
  const quiz = learningFolders(data, 'quiz', now);
  assert.equal(quiz.find((x) => x.id === 'bio')?.newCount, 1);
  assert.equal(quiz.find((x) => x.id === 'math')?.total, 2);
});
test('removed subject contents remain in a matching unfiled folder instead of disappearing', () => {
  const orphaned = { ...data, subjects: data.subjects.filter((subject) => subject.id !== 'bio') };
  const folders = learningFolders(orphaned, 'cards', now);
  assert.equal(folders.find((item) => item.id === '__unfiled__')?.total, 1);
  assert.equal(folders.find((item) => item.id === '__unfiled__')?.due, 1);
  assert.ok(inLearningFolder('bio', '__unfiled__', orphaned.subjects));
  assert.ok(!inLearningFolder('math', '__unfiled__', orphaned.subjects));
  assert.ok(inLearningFolder('math', '', orphaned.subjects));
  assert.ok(
    !learningFolders({ ...orphaned, cards: [] }, 'cards', now).some(
      (item) => item.id === '__unfiled__',
    ),
  );
});
test('sorting is stable and keeps same-name folders from different semesters distinct', () => {
  const source = {
    ...data,
    subjects: [
      { ...data.subjects[0], id: 'b' },
      { ...data.subjects[0], id: 'a', semester: '2026년 1학기' },
    ],
  };
  const before = JSON.stringify(source);
  assert.deepEqual(
    learningFolders(source, 'quiz', now)
      .filter((item) => item.id !== '__unfiled__')
      .map((item) => item.id),
    ['a', 'b'],
  );
  assert.equal(JSON.stringify(source), before);
});
test('folder rows expose names, counts, due text and semester without relying only on color', () => {
  const html = renderToStaticMarkup(
    createElement(LearningFolders, { data, mode: 'cards', now, onSelect: () => {} }),
  );
  assert.match(html, /지금 복습/);
  assert.match(html, /2026년 2학기/);
  assert.match(html, /카드 0장/);
  assert.match(html, /data-learning-folders="cards"/);
  assert.ok(!html.includes('front-due'));
});
test('card library starts in folders but explicit subject entry stays inside that folder', () => {
  const props = {
    data,
    path: '/flashcards',
    navigate: () => {},
    back: () => {},
    refresh: async () => {},
    toast: () => {},
  } as unknown as ScreenProps;
  const root = renderToStaticMarkup(createElement(CardLibrary, { props }));
  assert.match(root, /data-learning-folders="cards"/);
  assert.ok(!root.includes('front-due'));
  const inner = renderToStaticMarkup(createElement(CardLibrary, { props, initialSubject: 'bio' }));
  assert.match(inner, /카드 폴더 경로/);
  assert.match(inner, /front-due/);
  assert.ok(!inner.includes('front-later'));
});
