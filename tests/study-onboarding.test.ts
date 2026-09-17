import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppData, Card, Material, ScreenProps } from '../src/lib/contracts';
import { soleUploadSubject, studyOnboarding } from '../src/lib/study-onboarding';
import { StudyHome } from '../src/components/study/subjects';

test('camera and file entry never infer a subject from bootstrap ordering', () => {
  const subjects = [
    { id: 'bio', name: '생명과학' },
    { id: 'math', name: '수학' },
  ] as AppData['subjects'];
  assert.equal(soleUploadSubject([]), null);
  assert.equal(soleUploadSubject(subjects)?.id, undefined);
  assert.equal(soleUploadSubject([...subjects].reverse()), null);
  assert.equal(soleUploadSubject(subjects.slice(0, 1))?.id, 'bio');
  const sample = { id: 'sample', subjectId: 'bio', extraction: 'sample' } as Material;
  assert.equal(
    soleUploadSubject(subjects.slice(0, 1), [sample]),
    null,
    'the sample subject must not silently categorize personal uploads',
  );
  assert.equal(
    soleUploadSubject(subjects.slice(0, 1), [
      sample,
      { ...sample, id: 'personal', extraction: 'manual' },
    ])?.id,
    'bio',
  );
});

const data = {
  materials: [],
  subjects: [],
  questions: [],
  essays: [],
  cards: [],
  attempts: [],
  profile: { id: 'onboarding-check', completedSubjects: [] },
  stats: { yesterdayCards: 0 },
  aiAvailable: true,
} as unknown as AppData;
const source = (contentLength: number) =>
  ({ id: 'source', subjectId: 'bio', title: '수업 필기', contentLength }) as Material;
function home(overrides: Partial<AppData> = {}) {
  return renderToStaticMarkup(
    createElement(StudyHome, {
      data: { ...data, ...overrides },
      path: '/study',
      navigate() {},
      back() {},
      toast() {},
      async refresh() {},
    } as ScreenProps),
  );
}

test('first visit and a subject-only account offer a first source instead of four empty destinations', () => {
  for (const subjects of [[], [{ id: 'bio', name: '생명과학' }]]) {
    const html = home({ subjects: subjects as AppData['subjects'] });
    assert.ok(html.includes('예제로 1분 학습하기'));
    assert.ok(html.includes('내 자료로 시작하기'));
    assert.ok(html.includes('내 과목·자료'));
    assert.ok(!html.includes('aria-label="학습 방법"'));
    assert.ok(!html.includes('오답노트'));
  }
});

test('a saved source advances the next visit without an onboarding-seen flag', () => {
  assert.equal(studyOnboarding(data).phase, 'first-source');
  const ready = { materials: [source(20)] };
  assert.equal(studyOnboarding({ ...data, ...ready }).phase, 'first-study');
  const html = home(ready);
  assert.ok(html.includes('자료가 준비됐어요'));
  assert.ok(html.includes('자료 1개로'));
  assert.ok(html.includes('플래시카드 만들기'));
  assert.ok(html.includes('서술형 문제 만들기'));
  assert.ok(html.includes('객관식 문제 만들기'));
  assert.ok(!html.includes('첫 자료 추가하기'));
  assert.ok(!html.includes('오답노트'));
});

test('unusable sources explain how to repair content rather than promising generation', () => {
  const html = home({ materials: [source(0), { ...source(19), id: 'short' }] });
  assert.ok(html.includes('자료 내용 확인하기'));
  assert.ok(html.includes('20자 이상'));
  assert.ok(html.includes('새 자료 추가하기'));
  assert.ok(!html.includes('aria-label="첫 학습 만들기"'));
  assert.equal(studyOnboarding({ ...data, materials: [source(19), source(20)] }).usableSources, 1);
});

test('manually written cards and independently imported learning content bypass source onboarding', () => {
  for (const content of [
    { cards: [{ id: 'manual', deleted: false }] as Card[] },
    { questions: [{ id: 'imported' }] as AppData['questions'] },
    { essays: [{ id: 'imported' }] as AppData['essays'] },
  ]) {
    assert.equal(studyOnboarding({ ...data, ...content }).phase, 'ready');
    const html = home(content);
    assert.ok(html.includes('aria-label="학습 방법"'));
    assert.ok(html.includes('오답노트'));
    assert.ok(!html.includes('첫 자료 추가하기'));
  }
  assert.equal(
    studyOnboarding({ ...data, cards: [{ deleted: true }] as Card[] }).phase,
    'first-source',
  );
});

test('unavailable AI does not expose dead generation actions or block manual study', () => {
  const html = home({ materials: [source(100)], aiAvailable: false });
  assert.ok(html.includes('지금은 AI 학습 만들기를 이용할 수 없어요'));
  assert.ok(html.includes('직접 카드 만들기'));
  assert.ok(!html.includes('aria-label="첫 학습 만들기"'));
});
