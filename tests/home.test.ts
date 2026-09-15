import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HomeScreen } from '../src/components/app';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  homeAgenda,
  homeWeek,
  homeContinuations,
  remainingMaterialQuestions,
  recentMaterials,
  materialMeta,
  materialHref,
} from '../src/lib/home';
import {
  essayRevision,
  readEssayDrafts,
  findEssayDraft,
  saveEssayDraft,
  removeEssayDraft,
  type EssayDraft,
} from '../src/lib/study-drafts';
import type { AppData, Essay, Material, Question, Schedule } from '../src/lib/contracts';

const material = (id: string, createdAt = '2026-09-15T01:00:00Z'): Material => ({
  id,
  subjectId: 'bio',
  title: `자료 ${id}`,
  content: '내용',
  type: 'TEXT',
  createdAt,
});
const question = (id: string, materialId: string): Question => ({
  id,
  materialId,
  subjectId: 'bio',
  prompt: id,
  options: ['a', 'b'],
  answer: 0,
  explanation: '해설',
  citation: '자료',
  past: '',
  future: '',
});
const essay: Essay = {
  id: 'e1',
  subjectId: 'bio',
  materialId: 'm1',
  prompt: '광합성을 설명하세요',
  keywords: ['빛', '포도당'],
  distractors: ['산화'],
  modelAnswer: '모범 답안',
  citation: '자료',
};
const fixture = (): AppData => ({
  profile: {
    id: 'u1',
    name: '지우',
    nickname: '지우',
    role: 'STUDENT',
    school: '학교',
    grade: '고1',
    streak: 0,
    points: 0,
    privacy: { accuracy: false, time: false, wrongNotes: false },
    completedSubjects: [],
  },
  subjects: [
    {
      id: 'bio',
      name: '생명과학',
      icon: 'book',
      semester: '',
      color: '',
      materialCount: 2,
      questionCount: 3,
      cardCount: 10,
    },
  ],
  materials: [material('m1'), material('m2')],
  questions: [question('q1', 'm1'), question('q2', 'm1'), question('q3', 'm2')],
  essays: [essay],
  cards: [],
  attempts: [],
  schedules: [],
  posts: [],
  cheers: [],
  notifications: [],
  stats: { todayCards: 0, todayQuestions: 0, accuracy: 0, studyMinutes: 0, weekly: [] },
  aiAvailable: false,
  demo: true,
});
const draft = (): EssayDraft => ({
  essayId: essay.id,
  revision: essayRevision(essay),
  stage: 4,
  selected: ['빛', '포도당'],
  order: ['빛', '포도당'],
  hint: true,
  answer: '빛을 받아 포도당을 만든다.',
  updatedAt: '2026-09-15T03:00:00Z',
});
const attempt = (questionId: string, time = '2026-09-15T01:00:00Z') => ({
  id: `a-${questionId}-${time}`,
  questionId,
  correct: false,
  score: 0,
  answer: '1',
  createdAt: time,
});
const schedule = (
  id: string,
  start: string,
  end: string,
  done = false,
  date = '2026-09-15',
): Schedule => ({ id, title: id, date, start, end, done, kind: 'FLEXIBLE' });
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) || null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}

test('this-week dots exclude last week and future days at Seoul midnight', () => {
  const days = homeWeek([1, 1, 1, 1, 1, 0, 2], new Date('2026-09-14T15:01:00Z'));
  assert.deepEqual(
    days.map((d) => d.date),
    [
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ],
  );
  assert.deepEqual(
    days.map((d) => d.done),
    [false, true, false, false, false, false, false],
  );
  assert.equal(days[1].today, true);
  assert.equal(days[2].future, true);
  assert.equal(
    homeWeek([1, 1, 1, 1, 1, 1, 1], new Date('2026-09-20T01:00:00Z')).filter((d) => d.done).length,
    7,
  );
});
test('agenda prioritizes ongoing/future study and distinguishes overdue work', () => {
  const schedules = [
    schedule('done', '10:00', '12:00', true),
    schedule('old', '08:00', '09:00'),
    schedule('future', '16:00', '16:50'),
    schedule('ongoing', '13:00', '14:00'),
    schedule('tomorrow', '00:00', '01:00', false, '2026-09-16'),
  ];
  const a = homeAgenda({ schedules }, new Date('2026-09-15T04:30:00Z'));
  assert.equal(a.next?.id, 'ongoing');
  assert.equal(a.duration, 60);
  assert.equal(a.label, '오후 1:00 · 지금 할 공부');
  assert.equal(a.done, 1);
  assert.equal(a.total, 4);
  const b = homeAgenda({ schedules }, new Date('2026-09-15T08:00:00Z'));
  assert.equal(b.next, undefined);
  assert.equal(b.total - b.done, 3);
  assert.equal(homeAgenda({ schedules: [] }, new Date()).total, 0);
});
test('quiz resume counts distinct answered questions and opens only remaining questions', () => {
  const data = fixture();
  data.attempts = [attempt('q1'), attempt('q1', '2026-09-15T02:00:00Z'), attempt('q3')];
  const [row] = homeContinuations(data, []);
  assert.equal(row.id, 'm1');
  assert.equal(row.progress, '50%');
  assert.equal(row.description, '문제 1 / 2 완료');
  assert.equal(row.href, '/quiz?material=m1&resume=1');
  assert.deepEqual(
    remainingMaterialQuestions(data, 'm1').map((q) => q.id),
    ['q2'],
  );
  data.attempts.push(attempt('q2'));
  assert.equal(homeContinuations(data, []).length, 0);
});
test('completed and never-started material groups are not fake continuation rows', () => {
  const data = fixture();
  assert.deepEqual(homeContinuations(data, []), []);
  data.attempts = [attempt('q1'), attempt('q2')];
  assert.deepEqual(homeContinuations(data, []), []);
});
test('draft state survives re-entry, remains user-scoped, and is removed after completion', () => {
  const s = storage(),
    d = draft();
  assert.equal(saveEssayDraft('u1', d, s), true);
  assert.deepEqual(findEssayDraft('u1', essay, s), d);
  assert.deepEqual(readEssayDrafts('u2', s), []);
  const row = homeContinuations(fixture(), readEssayDrafts('u1', s))[0];
  assert.equal(row.href, '/essay?essay=e1');
  assert.equal(row.progress, '4/4');
  assert.match(row.description, /답안 작성 중/);
  const data = fixture();
  data.attempts = [
    {
      id: 'a',
      essayId: 'e1',
      correct: true,
      score: 100,
      answer: d.answer,
      createdAt: '2026-09-15T04:00:00Z',
    },
  ];
  assert.deepEqual(homeContinuations(data, [d]), []);
  removeEssayDraft('u1', 'e1', s);
  assert.deepEqual(readEssayDrafts('u1', s), []);
});
test('corrupt, outdated and deleted drafts are ignored; blocked storage does not break learning', () => {
  const s = storage();
  saveEssayDraft('u1', draft(), s);
  assert.equal(findEssayDraft('u1', { ...essay, keywords: ['새 키워드'] }, s), undefined);
  assert.equal(homeContinuations({ ...fixture(), essays: [] }, [draft()]).length, 0);
  s.setItem('memoryz-essay-drafts-v1:u1', '{broken');
  assert.deepEqual(readEssayDrafts('u1', s), []);
  s.setItem(
    'memoryz-essay-drafts-v1:u1',
    JSON.stringify([
      { ...draft(), stage: 9 },
      { ...draft(), order: [1] },
    ]),
  );
  assert.deepEqual(readEssayDrafts('u1', s), []);
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(readEssayDrafts('u1', blocked), []);
  assert.equal(saveEssayDraft('u1', draft(), blocked), false);
});
test('recent materials are latest two, metadata never invents card counts or zero quizzes, and routes address the document', () => {
  const data = fixture();
  data.materials = [
    material('old', '2026-09-10T00:00:00Z'),
    material('new', '2026-09-15T00:00:00Z'),
    material('middle', '2026-09-13T00:00:00Z'),
  ];
  assert.deepEqual(
    recentMaterials(data.materials).map((m) => m.id),
    ['new', 'middle'],
  );
  assert.equal(data.materials[0].id, 'old');
  assert.equal(materialMeta(data, material('empty')), '생명과학');
  assert.equal(materialMeta(data, material('m1')), '생명과학 · 문제 2 · 서술형 1');
  assert.equal(
    materialHref({ ...material('a&b'), subjectId: 'x/y' }),
    '/subjects/x%2Fy?material=a%26b',
  );
});

test('empty home renders a real onboarding action without invented progress or completed labels', () => {
  const data = fixture();
  data.materials = [];
  data.questions = [];
  data.essays = [];
  data.subjects = [];
  const markup = renderToStaticMarkup(
    createElement(HomeScreen, {
      data,
      path: '/',
      navigate: () => {},
      toast: () => {},
      refresh: async () => {},
    }),
  );
  assert.match(markup, /첫 학습 자료 올리기/);
  assert.match(markup, /첫 복습 카드 만들기/);
  assert.match(markup, /진행 중인 공부가 없어요/);
  assert.doesNotMatch(markup, /오늘의 일정을 모두 마쳤어요|문제 0|14%|12일째/);
  data.materials = [material('m1')];
  const existing = renderToStaticMarkup(
    createElement(HomeScreen, {
      data,
      path: '/',
      navigate: () => {},
      toast: () => {},
      refresh: async () => {},
    }),
  );
  assert.doesNotMatch(existing, /자료 하나가 여러 번의 공부로|첫 학습 자료 올리기/);
});
