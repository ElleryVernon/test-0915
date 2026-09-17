import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Material, Subject, ScreenProps } from '../src/lib/contracts';
import {
  folderForMaterial,
  folderMaterials,
  materialFolders,
  UNFILED_MATERIALS,
  toggleMaterialSelection,
  selectedMaterials,
} from '../src/lib/material-folders';
import { MaterialFolderBrowser } from '../src/components/study/material-folder-picker';
import { StudyHome, StudySubjectLibrary } from '../src/components/study/subjects';

const subjects = [
  { id: 'math', name: '수학', semester: '2026 2학기' },
  { id: 'bio', name: '생명과학', semester: '2026 2학기' },
  { id: 'empty', name: '영어', semester: '' },
] as Subject[];
const materials = [
  {
    id: 'old',
    title: '수업 2',
    subjectId: 'bio',
    createdAt: '2026-01-01',
    contentLength: 100,
    type: 'TXT',
  },
  {
    id: 'new',
    title: '수업 10',
    subjectId: 'math',
    createdAt: '2026-02-01',
    contentLength: 100,
    type: 'PDF',
  },
  {
    id: 'short',
    title: '수업 1',
    subjectId: 'bio',
    createdAt: '2026-03-01',
    contentLength: 5,
    type: 'TXT',
  },
  {
    id: 'lost',
    title: '이전 과목 자료',
    subjectId: 'missing',
    createdAt: '2025-01-01',
    contentLength: 100,
    type: 'TXT',
  },
] as Material[];
const data: ScreenProps['data'] = {
  subjects,
  materials,
  questions: [],
  essays: [],
  attempts: [],
  cards: [],
  profile: {
    id: 'folder-test',
    name: '학습자',
    nickname: '학습자',
    role: 'STUDENT',
    school: '',
    grade: '',
    streak: 0,
    points: 0,
    privacy: { accuracy: true, time: true, wrongNotes: true },
    completedSubjects: [],
  },
  stats: {
    yesterdayCards: 0,
    todayCards: 0,
    todayQuestions: 0,
    accuracy: 0,
    studyMinutes: 0,
    weekly: [],
  },
  schedules: [],
  posts: [],
  cheers: [],
  notifications: [],
  aiAvailable: false,
  demo: false,
};
const props = {
  data,
  path: '/study',
  back() {},
  navigate() {},
  toast() {},
  async refresh() {},
} as ScreenProps;

test('folder counts match actual materials and every material remains reachable', () => {
  const folders = materialFolders(materials, subjects);
  assert.deepEqual(
    folders.map((f) => f.name),
    ['생명과학', '수학', '영어', '과목 미지정'],
  );
  assert.equal(
    folders.reduce((sum, f) => sum + f.count, 0),
    materials.length,
  );
  assert.deepEqual(
    folders.find((f) => f.id === 'bio'),
    { id: 'bio', name: '생명과학', semester: '2026 2학기', count: 2, usableCount: 1 },
  );
  assert.equal(folders.find((f) => f.id === 'empty')?.count, 0);
  assert.deepEqual(
    folderMaterials(materials, subjects, UNFILED_MATERIALS, '', 'recent').map((m) => m.id),
    ['lost'],
  );
  assert.equal(folderForMaterial(materials[3], subjects), UNFILED_MATERIALS);
  assert.equal(folderForMaterial(materials[0], subjects), 'bio');
  assert.equal(folderForMaterial(undefined, subjects), '');
});

test('folder browsing has deterministic order and scoped search without mutating stored data', () => {
  assert.deepEqual(
    folderMaterials(materials, subjects, 'bio', '', 'recent').map((m) => m.id),
    ['short', 'old'],
  );
  assert.deepEqual(
    folderMaterials(materials, subjects, 'bio', '', 'name').map((m) => m.id),
    ['short', 'old'],
  );
  assert.deepEqual(
    folderMaterials([...materials].reverse(), subjects, '', '생명과학', 'recent').map((m) => m.id),
    ['short', 'old'],
  );
  assert.equal(folderMaterials(materials, subjects, 'bio', '수학', 'recent').length, 0);
  assert.deepEqual(
    materials.map((m) => m.id),
    ['old', 'new', 'short', 'lost'],
  );
  const tied = [
    { ...materials[0], id: 'b' },
    { ...materials[0], id: 'a' },
  ];
  assert.deepEqual(
    folderMaterials(tied, subjects, 'bio', '', 'recent').map((m) => m.id),
    ['a', 'b'],
  );
});

test('returning learner sees four learning choices and the separate library entry', () => {
  const html = renderToStaticMarkup(
    createElement(StudyHome, {
      ...props,
      data: { ...data, questions: [{ id: 'existing' }] as ScreenProps['data']['questions'] },
    }),
  );
  assert.equal((html.match(/class="feature"/g) || []).length, 4);
  const labels = ['플래시카드', '서술형 도우미', '문제은행', '오답노트'];
  let previous = -1;
  for (const label of labels) {
    const position = html.indexOf(`<strong>${label}</strong>`);
    assert.ok(position > previous);
    previous = position;
  }
  assert.ok(!html.includes('과목 관리'));
  assert.ok(!html.includes('오늘의 복습'));
  assert.ok(!html.includes('만들기'));
  const library = renderToStaticMarkup(
    createElement(StudySubjectLibrary, { ...props, path: '/subjects' }),
  );
  assert.ok(library.includes('내 과목·자료'));
  assert.ok(library.includes('과목 관리'));
  assert.ok(library.includes('생명과학'));
});

test('picker starts at folders and does not silently choose the first material', () => {
  const html = renderToStaticMarkup(createElement(MaterialFolderBrowser, { data, onSelect() {} }));
  assert.ok(html.includes('과목별 자료 폴더'));
  assert.ok(html.includes('폴더 4개'));
  assert.ok(html.includes('한 주제에 사용할 자료를 골라 주세요.'));
  assert.match(html, /<button[^>]+disabled=""[^>]*>자료를 선택해 주세요/);
});

test('contextual selection opens its folder, keeps too-short material explanation and explicit confirmation', () => {
  const html = renderToStaticMarkup(
    createElement(MaterialFolderBrowser, { data, selected: [materials[0]], onSelect() {} }),
  );
  assert.ok(html.includes('aria-current="location">생명과학'));
  assert.ok(html.includes('수업 2'));
  assert.ok(!html.includes('수업 10'));
  assert.ok(html.includes('본문이 짧아요'));
  assert.match(html, /aria-checked="false" disabled=""/);
  assert.ok(html.includes('선택한 자료'));
  assert.ok(html.includes('1개 자료 사용하기'));
});

test('missing selected material does not leave an enabled confirmation', () => {
  const html = renderToStaticMarkup(
    createElement(MaterialFolderBrowser, {
      data: { subjects, materials: [] },
      selected: [materials[0]],
      onSelect() {},
    }),
  );
  assert.ok(html.includes('이 폴더에 자료가 없어요'));
  assert.match(html, /<button[^>]+disabled=""[^>]*>자료를 선택해 주세요/);
});

test('multiple selections persist across folders and are explicitly removable with a five-source limit', () => {
  let chosen = toggleMaterialSelection([], 'old');
  chosen = toggleMaterialSelection(chosen, 'new');
  assert.deepEqual(
    selectedMaterials(materials, chosen).map((m) => m.subjectId),
    ['bio', 'math'],
  );
  folderMaterials(materials, subjects, 'empty', '', 'recent');
  assert.deepEqual(chosen, ['old', 'new']);
  assert.deepEqual(toggleMaterialSelection(chosen, 'old'), ['new']);
  assert.deepEqual(toggleMaterialSelection(['1', '2', '3', '4', '5'], '6'), [
    '1',
    '2',
    '3',
    '4',
    '5',
  ]);
  const html = renderToStaticMarkup(
    createElement(MaterialFolderBrowser, { data, selected: materials.slice(0, 2), onSelect() {} }),
  );
  assert.ok(html.includes('2개 자료 사용하기'));
  assert.match(html, /선택한 자료 <strong>2개<\/strong>/);
  assert.ok(html.includes('선택 해제'));
});
