import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { firstLearning } from '../src/lib/first-learning';
import { HomeScreen } from '../src/components/app';
import { FirstLearningLesson } from '../src/components/study/first-learning';
import type { AppData, ScreenProps } from '../src/lib/contracts';

const blank = {
  profile: {
    id: 'new-student',
    role: 'STUDENT',
    name: '새 사용자',
    completedSubjects: [],
    streak: 0,
  },
  materials: [],
  subjects: [],
  questions: [],
  essays: [],
  cards: [],
  attempts: [],
  schedules: [],
  notifications: [],
  cheers: [],
  posts: [],
  stats: { todayCards: 0, yesterdayCards: 0, todayQuestions: 0, weekly: [0, 0, 0, 0, 0, 0, 0] },
  aiAvailable: false,
  demo: false,
} as unknown as AppData;
const sample = {
  ...blank,
  materials: [{ id: 'sample', extraction: 'sample', contentLength: 200 }],
  questions: [
    {
      id: 'question',
      materialId: 'sample',
      prompt: '확인할 개념',
      options: ['오답', '정답'],
      answer: 1,
      explanation: '정답 근거',
      citation: '자료의 문장',
    },
  ],
  cards: [
    {
      id: 'card',
      materialId: 'sample',
      sourceKind: 'STARTER',
      sourceQuestionId: 'question',
      front: '기억할 개념',
      back: '기억한 내용',
      reviewCount: 0,
      deleted: false,
    },
  ],
} as AppData;
const answered = {
  ...sample,
  attempts: [
    {
      id: 'attempt',
      questionId: 'question',
      answer: '0',
      correct: false,
      createdAt: '2026-09-17T00:00:00Z',
    },
  ],
} as AppData;
const completed = { ...answered, cards: [{ ...sample.cards[0], reviewCount: 1 }] };
const props = (data: AppData, path = '/'): ScreenProps => ({
  data,
  path,
  navigate() {},
  back() {},
  toast() {},
  async refresh() {},
});

test('new home leads to a visible example and explicit personal upload, with no empty dashboard', () => {
  const html = renderToStaticMarkup(createElement(HomeScreen, props(blank)));
  assert.match(html, /예제로 1분 학습하기/);
  assert.match(html, /내 자료로 시작하기/);
  assert.match(html, /뉴런은 어떻게 신호를 전할까/);
  assert.doesNotMatch(html, /오늘 복습할 카드|이번 주 0일|첫 복습 카드 만들기|공부 시간 정하기/);
  assert.equal(firstLearning(blank).showWelcome, true);
});

test('a sample alone remains a resumable first lesson; only real answers AND review mark completion', () => {
  assert.equal(firstLearning(sample).complete, false);
  assert.equal(firstLearning(answered).complete, false);
  assert.equal(firstLearning({ ...sample, cards: completed.cards }).complete, false);
  assert.equal(firstLearning(completed).complete, true);
  assert.equal(firstLearning(completed).showWelcome, true);
  const html = renderToStaticMarkup(createElement(HomeScreen, props(completed)));
  assert.match(html, /내 자료 추가하기/);
  assert.match(html, /문제 1개 확인 · 카드 1장 복습/);
  assert.doesNotMatch(html, /예제로 1분 학습하기|오늘 복습할 카드/);
});

test('personal sources, manual cards and imported exercises preserve the ordinary journey', () => {
  assert.equal(
    firstLearning({
      ...completed,
      materials: [...completed.materials, { id: 'mine' } as AppData['materials'][0]],
    }).showWelcome,
    false,
  );
  assert.equal(
    firstLearning({ ...blank, cards: [{ id: 'mine', deleted: false }] as AppData['cards'] })
      .showWelcome,
    false,
  );
  assert.equal(
    firstLearning({ ...blank, questions: [{ id: 'mine' }] as AppData['questions'] }).showWelcome,
    false,
  );
  assert.equal(firstLearning({ ...blank, demo: true }).showWelcome, false);
});

test('saved wrong answer exposes both labels and source evidence, not just colour', () => {
  const html = renderToStaticMarkup(
    createElement(FirstLearningLesson, props(answered, '/start?step=question')),
  );
  assert.match(html, /내 답/);
  assert.match(html, />정답</);
  assert.match(html, /자료에서 찾은 근거/);
  assert.match(html, /괜찮아요/);
  assert.match(html, /복습 카드로 기억하기/);
});

test('direct completion links cannot claim unearned progress and reviewed cards remain complete', () => {
  const pending = renderToStaticMarkup(
    createElement(FirstLearningLesson, props(sample, '/start?step=complete')),
  );
  assert.doesNotMatch(pending, /첫 학습을 마쳤어요/);
  const done = renderToStaticMarkup(
    createElement(FirstLearningLesson, props(completed, '/start?step=complete')),
  );
  assert.match(done, /카드 1장 복습 기록 저장/);
  assert.match(done, /내 자료 추가하기/);
});
