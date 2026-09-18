import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import StudyScreens from '../src/components/study';
import {
  bucketDistribution,
  completedReviewSessions,
  examCountdown,
  libraryGroups,
  MASTERY_HINT_SESSIONS,
  materialMeta,
  nextReviewDay,
  recordReviewSession,
  reviewMinutes,
  reviewOrdinal,
  sessionDuration,
  sessionResult,
  splitBack,
  streakThroughToday,
  studyMethods,
  subjectInsight,
  subjectMeta,
  subjectSummary,
  whenLabel,
} from '../src/components/study/insights';
import { seoulDateKey } from '../src/lib/home';
import type { AppData, Card, ScreenProps } from '../src/lib/contracts';
import type { EssayDraft } from '../src/lib/study-drafts';
import { essayRevision } from '../src/lib/study-drafts';

const HOUR = 3600000;
const DAY = 24 * HOUR;
function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    subjectId: 'bio',
    front: `질문 ${id}`,
    back: `정답 ${id}`,
    type: 'CONCEPT',
    bucket: 'GOOD',
    consecutiveEasy: 0,
    nextReviewAt: new Date(Date.now() - 1000).toISOString(),
    deleted: false,
    ...overrides,
  };
}
const seoulPlus = (days: number, from = new Date()) =>
  new Date(Date.parse(`${seoulDateKey(from)}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

function fixture(): AppData {
  const now = Date.now();
  return {
    profile: {
      id: 'student-review',
      name: '테스트',
      nickname: '학습자',
      role: 'STUDENT',
      school: '테스트학교',
      grade: '고2',
      streak: 4,
      points: 0,
      privacy: { accuracy: true, time: true, wrongNotes: true },
      completedSubjects: [],
    },
    subjects: [
      {
        id: 'bio',
        name: '생명과학I',
        icon: 'science',
        semester: '2026 2학기',
        color: 'gray',
        materialCount: 2,
        questionCount: 3,
        cardCount: 5,
        examName: '중간고사',
        examDate: seoulPlus(12),
      },
      {
        id: 'eng',
        name: '영어',
        icon: 'book',
        semester: '2026 2학기',
        color: 'gray',
        materialCount: 0,
        questionCount: 0,
        cardCount: 0,
      },
    ],
    materials: [
      {
        id: 'm-new',
        subjectId: 'bio',
        title: '세포 호흡',
        content: '세포 호흡은 포도당을 분해해 에너지를 얻는 과정이다.',
        contentLength: 28,
        excerpt: '세포 호흡은 포도당을 분해해 에너지를 얻는 과정이다.',
        contentHash: 'h-m-new',
        type: 'TXT',
        createdAt: new Date(now).toISOString(),
      },
      {
        id: 'm-old',
        subjectId: 'bio',
        title: '호르몬과 항상성',
        content: '인슐린과 글루카곤은 혈당을 조절한다.',
        contentLength: 20,
        excerpt: '인슐린과 글루카곤은 혈당을 조절한다.',
        contentHash: 'h-m-old',
        type: 'TXT',
        createdAt: new Date(now - DAY).toISOString(),
      },
    ],
    questions: ['q1', 'q2', 'q3'].map((id) => ({
      id,
      subjectId: 'bio',
      materialId: 'm-old',
      prompt: `문제 ${id}`,
      options: ['a', 'b', 'c', 'd', 'e'],
      answer: 0,
      explanation: '',
      citation: '인슐린',
      past: '',
      future: '',
    })),
    essays: [
      {
        id: 'e1',
        subjectId: 'bio',
        materialId: 'm-old',
        prompt: '혈당 조절 과정을 서술하세요.',
        keywords: ['인슐린', '글루카곤', '간', '혈당'],
        distractors: ['빛', '소리', '열', '전기'],
        modelAnswer: '인슐린과 글루카곤이 간에서 혈당을 조절한다.',
        citation: '혈당',
      },
    ],
    cards: [
      card('due-again', { bucket: 'AGAIN', reviewCount: 2 }),
      // Listed second but overdue longer: array order and due order disagree on purpose.
      card('due-good', { nextReviewAt: new Date(now - HOUR).toISOString(), reviewCount: 0 }),
      card('later', { bucket: 'EASY', nextReviewAt: new Date(now + 3 * DAY).toISOString() }),
      card('mastered', {
        bucket: 'MASTERED',
        nextReviewAt: new Date(now + 400 * DAY).toISOString(),
      }),
      card('gone', { deleted: true }),
    ],
    attempts: [
      {
        id: 'a1',
        questionId: 'q1',
        correct: false,
        score: 0,
        answer: '1',
        createdAt: new Date(now - DAY).toISOString(),
      },
    ],
    schedules: [],
    posts: [],
    cheers: [],
    notifications: [],
    stats: {
      todayCards: 0,
      yesterdayCards: 6,
      todayQuestions: 0,
      accuracy: 0,
      studyMinutes: 0,
      weekly: [],
    },
    aiAvailable: false,
    demo: false,
  };
}
function render(path: string, data = fixture()) {
  const props: ScreenProps = {
    data,
    path,
    refresh: async () => {},
    navigate: () => {},
    back: () => {},
    toast: () => {},
  };
  return renderToStaticMarkup(createElement(StudyScreens, props));
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

test('D-day counts Seoul calendar days, hides past exams and shortens only "고사"', () => {
  // 00:30 in Seoul is still the previous day in UTC — a UTC count would say D-13.
  const now = new Date('2026-09-14T15:30:00Z');
  assert.equal(seoulDateKey(now), '2026-09-15');
  const exam = examCountdown({ examName: '중간고사', examDate: '2026-09-27' }, now);
  assert.deepEqual(exam, {
    days: 12,
    name: '중간고사',
    label: '중간고사 D-12',
    short: '중간 D-12',
  });
  assert.equal(
    examCountdown({ examName: '기말고사', examDate: '2026-09-15' }, now)?.short,
    '기말 D-day',
  );
  assert.equal(
    examCountdown({ examName: '수행평가', examDate: '2026-09-18' }, now)?.short,
    '수행평가 D-3',
  );
  assert.equal(examCountdown({ examDate: '2026-09-20' }, now)?.label, '시험 D-5');
  assert.equal(examCountdown({ examName: '중간고사', examDate: '2026-09-14' }, now), null);
  assert.equal(examCountdown({ examName: '중간고사' }, now), null);
  assert.equal(examCountdown({ examDate: '2026/09/20' }, now), null);
});

test('subject rows count only this subject, live cards and due cards; empty subjects invite an upload', () => {
  const data = fixture();
  const bio = subjectSummary(data, 'bio');
  assert.deepEqual(bio, { materials: 2, questions: 3, essays: 1, cards: 4, due: 2, again: 1 });
  assert.equal(subjectMeta(bio), '자료 2 · 문제 3 · 카드 4');
  assert.equal(
    subjectMeta(subjectSummary(data, 'eng')),
    '아직 자료가 없어요 · 올리면 문제·카드가 생겨요',
  );
  // A card-only subject keeps its counts instead of claiming it is empty.
  data.cards.push(card('eng-card', { subjectId: 'eng' }));
  assert.equal(subjectMeta(subjectSummary(data, 'eng')), '자료 0 · 문제 0 · 카드 1');
});

test('material meta names the next action when empty and never invents per-material card counts', () => {
  const data = fixture();
  assert.deepEqual(materialMeta(data, 'm-new'), { text: '문제·카드 만들기', empty: true });
  const old = materialMeta(data, 'm-old');
  assert.deepEqual(old, { text: '문제 3 · 서술형 1', empty: false });
  assert.ok(!old.text.includes('카드'), 'cards carry no material id');
});

test('study methods report state, not stock: wrong/new questions, drafts in progress, notes, mastered cards', () => {
  const data = fixture();
  const essay = data.essays[0];
  const draft = (updatedAt: string, revision = essayRevision(essay)): EssayDraft => ({
    essayId: essay.id,
    revision,
    stage: 2,
    selected: ['인슐린'],
    order: [],
    hint: false,
    answer: '',
    updatedAt,
  });
  const fresh = draft(new Date().toISOString());
  assert.equal(
    studyMethods(data, [{ ...fresh, selected: [] }]).find((m) => m.key === 'essay')!.meta,
    '1문제',
  );
  const byKey = Object.fromEntries(studyMethods(data, [fresh]).map((m) => [m.key, m.meta]));
  assert.deepEqual(byKey, {
    quiz: '틀린 1 · 새 문제 2',
    essay: '작성 중 1 · 1문제',
    wrong: '1문제',
    cards: '4장 · 암기완료 1',
  });
  // A draft written for an earlier version of the prompt is not "in progress".
  const stale = draft(new Date().toISOString(), 'old-revision');
  assert.equal(studyMethods(data, [stale]).find((m) => m.key === 'essay')!.meta, '1문제');
  // Neither is a draft that was submitted afterwards.
  data.attempts.push({
    id: 'a2',
    essayId: essay.id,
    correct: false,
    score: 40,
    answer: 'x',
    createdAt: new Date(Date.now() + 1000).toISOString(),
  });
  const later = Object.fromEntries(studyMethods(data, [fresh]).map((m) => [m.key, m.meta]));
  assert.equal(later.essay, '1문제');
  assert.equal(later.wrong, '2문제');
  const empty = { ...fixture(), questions: [], essays: [], attempts: [], cards: [] };
  assert.deepEqual(
    studyMethods(empty, []).map((m) => m.meta),
    [
      '자료로 만들 수 있어요',
      '자료로 만들 수 있어요',
      '틀린 문제가 없어요',
      '첫 카드를 만들어 보세요',
    ],
  );
});

test('library groups due cards first, then later ones by date with permanent mastery last', () => {
  const now = Date.now();
  const cards = [
    card('m', { bucket: 'MASTERED', nextReviewAt: new Date(now + DAY).toISOString() }),
    card('late', { nextReviewAt: new Date(now + 5 * DAY).toISOString() }),
    card('soon', { nextReviewAt: new Date(now + DAY).toISOString() }),
    card('due-new', { nextReviewAt: new Date(now - HOUR).toISOString() }),
    card('due-old', { nextReviewAt: new Date(now - 2 * DAY).toISOString() }),
  ];
  const { today, later } = libraryGroups(cards, now);
  assert.deepEqual(
    today.map((c) => c.id),
    ['due-old', 'due-new'],
  );
  assert.deepEqual(
    later.map((c) => c.id),
    ['soon', 'late', 'm'],
  );
  assert.deepEqual(whenLabel(today[0], now), { text: '지금', strong: true });
  assert.deepEqual(whenLabel(later[2], now), { text: '암기완료', strong: true });
  assert.deepEqual(whenLabel(later[1], now), { text: '5일 뒤', strong: false });
});

test('bucket distribution counts every box and shares sum to one', () => {
  const dist = bucketDistribution(fixture().cards.filter((c) => !c.deleted));
  assert.deepEqual(
    dist.map((d) => [d.label, d.count]),
    [
      ['다시', 1],
      ['어려움', 0],
      ['보통', 1],
      ['쉬움', 1],
      ['암기완료', 1],
    ],
  );
  assert.equal(Math.round(dist.reduce((sum, d) => sum + d.share, 0) * 1000), 1000);
  assert.deepEqual(
    bucketDistribution([]).map((d) => d.share),
    [0, 0, 0, 0, 0],
  );
});

test('next review includes same-day learning steps and uses the Seoul calendar', () => {
  // 23:30 in Seoul; a card at 00:30 Seoul the next morning is "내일", not today as UTC dates would say.
  const now = new Date('2026-09-15T14:30:00Z');
  const at = (iso: string, extra: Partial<Card> = {}) => card(iso, { nextReviewAt: iso, ...extra });
  const cards = [
    at('2026-09-15T14:00:00Z'), // due now
    at('2026-09-15T14:50:00Z'), // later today in Seoul
    at('2026-09-15T15:30:00Z'), // tomorrow 00:30 Seoul
    at('2026-09-16T10:00:00Z'), // tomorrow 19:00 Seoul
    at('2026-09-16T12:00:00Z', { deleted: true }),
    at('2026-09-16T13:00:00Z', { bucket: 'MASTERED' }),
    at('2026-09-19T01:00:00Z'),
  ];
  assert.deepEqual(nextReviewDay(cards, now), { date: '2026-09-15', count: 1, when: '20분 뒤' });
  assert.deepEqual(nextReviewDay(cards.slice(2), now), {
    date: '2026-09-16',
    count: 2,
    when: '내일',
  });
  assert.deepEqual(nextReviewDay(cards.slice(-1), now), {
    date: '2026-09-19',
    count: 1,
    when: '9월 19일',
  });
  assert.equal(nextReviewDay(cards.slice(0, 1), now), null);
  assert.deepEqual(
    nextReviewDay(
      [at('2026-09-15T14:40:00Z'), at('2026-09-15T14:40:30Z'), at('2026-09-15T14:50:00Z')],
      now,
    ),
    { date: '2026-09-15', count: 2, when: '10분 뒤' },
  );
});

test('session result keeps the latest rating per card and lists "다시" cards', () => {
  const result = sessionResult([
    { cardId: 'a', rating: 'AGAIN' },
    { cardId: 'b', rating: 'GOOD' },
    { cardId: 'c', rating: 'AGAIN' },
    { cardId: 'a', rating: 'EASY' },
  ]);
  assert.equal(result.total, 3);
  assert.deepEqual(
    result.counts.map((c) => [c.label, c.count]),
    [
      ['다시', 1],
      ['어려움', 0],
      ['보통', 1],
      ['쉬움', 1],
    ],
  );
  assert.deepEqual(result.againIds, ['c']);
  assert.equal(sessionDuration(252000), '4분 12초');
  assert.equal(sessionDuration(42400), '42초');
  assert.equal(reviewMinutes(9), 5);
  assert.equal(reviewMinutes(1), 1);
});

test('streak through today counts a finished session only when today was not already counted', () => {
  const now = new Date();
  const data = fixture();
  assert.equal(streakThroughToday(data, 3, now), 5);
  assert.equal(streakThroughToday(data, 0, now), 4);
  assert.equal(streakThroughToday({ ...data, stats: { ...data.stats, todayCards: 2 } }, 3, now), 4);
  const today = {
    id: 't',
    questionId: 'q2',
    correct: true,
    score: 100,
    answer: '1',
    createdAt: now.toISOString(),
  };
  assert.equal(streakThroughToday({ ...data, attempts: [today] }, 3, now), 4);
  assert.equal(streakThroughToday({ ...data, profile: { ...data.profile, streak: 0 } }, 1, now), 1);
});

test('answers keep a readable size; a long first paragraph folds the explanation behind "더 보기"', () => {
  assert.deepEqual(splitBack('짧은 정답\n\n설명 문단'), {
    answer: '짧은 정답',
    explanation: '설명 문단',
    collapsed: false,
  });
  const long = '가'.repeat(141);
  assert.equal(splitBack(`${long}\n\n설명`).collapsed, true);
  assert.equal(splitBack(long).collapsed, false, 'nothing to fold without an explanation');
  assert.equal(splitBack(`${'가'.repeat(140)}\n\n설명`).collapsed, false);
  assert.deepEqual(splitBack('정답\n\n설명 1\n\n설명 2').explanation, '설명 1\n\n설명 2');
});

test('review ordinal uses the server count, then FSRS reps, and stays silent when unknown', () => {
  assert.equal(reviewOrdinal({ reviewCount: 0 }), '첫 복습');
  assert.equal(reviewOrdinal({ reviewCount: 2 }), '3번째 복습');
  assert.equal(
    reviewOrdinal({
      fsrs: {
        due: '',
        stability: 1,
        difficulty: 1,
        elapsed_days: 0,
        scheduled_days: 0,
        learning_steps: 0,
        reps: 4,
        lapses: 0,
        state: 2,
      },
    }),
    '5번째 복습',
  );
  assert.equal(reviewOrdinal({}), '');
});

test('mastery hint is limited to the first three completed sessions per account and survives blocked storage', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
  };
  assert.equal(completedReviewSessions('u1', storage), 0);
  for (let i = 0; i < MASTERY_HINT_SESSIONS; i++) recordReviewSession('u1', storage);
  assert.equal(completedReviewSessions('u1', storage), 3);
  assert.equal(completedReviewSessions('u2', storage), 0, 'counts are per account');
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(completedReviewSessions('u1', blocked), 0);
  assert.doesNotThrow(() => recordReviewSession('u1', blocked));
});

test('subject insight only speaks from the subject numbers', () => {
  const summary = { materials: 3, questions: 9, essays: 0, cards: 8, due: 4, again: 3 };
  const exam = { days: 21, name: '중간고사', label: '중간고사 D-21', short: '중간 D-21' };
  assert.deepEqual(subjectInsight(summary, exam), {
    title: '시험 3주 전 · 카드 8장 중 3장이 "다시" 상자',
    description: '자료로 문제를 더 만들어 볼까요?',
  });
  assert.equal(subjectInsight({ ...summary, again: 0 }, exam), null);
  assert.equal(
    subjectInsight({ ...summary, again: 0, questions: 0 }, { ...exam, days: 5 })?.title,
    '시험 5일 전 · 아직 문제가 없어요',
  );
  assert.equal(
    subjectInsight({ ...summary, again: 0, questions: 0 }, { ...exam, days: 0 })?.title,
    '시험 당일 · 아직 문제가 없어요',
  );
  assert.equal(subjectInsight({ ...summary, materials: 0 }, exam), null);
});

test('study home exposes four methods and keeps subject management in its own screen', () => {
  const html = render('/study');
  const t = text(html);
  for (const label of ['플래시카드', '서술형 도우미', '문제은행', '오답노트'])
    assert.ok(t.includes(label));
  assert.ok(!t.includes('과목 관리') && !t.includes('배운 과목 설정'));
  assert.ok(!html.includes('aria-label="만들기"'));
  const library = text(render('/subjects'));
  assert.ok(library.includes('과목 관리'));
  // The library is folder-first: due folders sort ahead and carry a red "지금 복습" badge.
  assert.ok(library.includes('과목 폴더') && library.includes('전체 학기'));
  assert.ok(library.includes('복습할 폴더부터') && library.includes('지금 복습 2'));
  assert.ok(library.indexOf('생명과학I') < library.indexOf('영어'), 'due folder first');
});

test('subject detail shows exam, today count, next action for empty materials and a fixed upload CTA', () => {
  const t = text(render('/subjects/bio'));
  assert.ok(t.includes('2026 2학기 중간고사 D-12'));
  // The folder total counts questions and essays together, like the folder rows do.
  assert.ok(t.includes('자료 2 · 문제 4 · 카드 4 · 오늘 복습 2장'));
  assert.ok(t.includes('문제·카드 만들기'), 'empty material names its next action');
  assert.ok(t.includes('문제 3 · 서술형 1'));
  assert.ok(t.includes('카드 4장 중 1장이 "다시" 상자'));
  assert.ok(t.includes('이 폴더에 자료 추가'), 'the in-folder add action names its destination');
  assert.ok(!t.includes('0문제'));
});

test('card library separates review summary from searchable collection and uses borderless shared content', () => {
  // The library lands on folders with the cross-folder review summary and the AI entry.
  const landing = render('/flashcards');
  const l = text(landing);
  assert.ok(l.includes('지금 복습 2장') && l.includes('2장 복습'));
  assert.ok(l.includes('폴더 2개') && l.includes('AI로 카드 만들기'));
  assert.ok(landing.includes('data-card-library="all"'));
  // Entering a folder shows only that folder's searchable collection.
  const html = render('/flashcards?subject=bio');
  const t = text(html);
  assert.ok(t.includes('지금 복습 2장'));
  assert.ok(t.includes('2장 복습'));
  assert.ok(!html.includes('class="recall-dist"'));
  assert.ok(t.includes('오늘 복습 · 2장') && t.includes('복습 예정 · 1장'));
  assert.ok(t.includes('3일 뒤') && t.includes('암기완료'));
  assert.ok(html.includes('aria-label="카드 검색"'));
  assert.ok(
    t.includes('과목 폴더 생명과학I') && t.includes('내 카드'),
    'breadcrumb names the folder',
  );
  assert.ok(!l.includes('내 카드'), 'the landing has no single-folder collection');
  assert.ok(!t.includes('오프라인 저장됨'));
  assert.ok(!html.includes('<select'));
  assert.ok(t.includes('카드 추가'));
});

test('review card front uses a white card, remaining time and subject, and a brand "정답 보기"', () => {
  const html = render('/flashcards?review=1');
  const t = text(html);
  assert.ok(t.includes('1 / 2'));
  assert.ok(t.includes('약 1분 남음 · 생명과학I'));
  assert.ok(t.includes('개념 · 용어와 정의'));
  // The session walks the library's "오늘" list: the card overdue for an hour before the one due a second ago.
  const library = text(render('/flashcards?subject=bio'));
  assert.ok(
    library.indexOf('질문 due-good') < library.indexOf('질문 due-again'),
    'library lists the longest overdue first',
  );
  assert.ok(
    t.includes('질문 due-good') && t.includes('보통 상자 · 첫 복습'),
    'the session starts where the list starts',
  );
  const single = text(render('/flashcards?card=due-again&review=1'));
  assert.ok(single.includes('1 / 1') && single.includes('다시 상자 · 3번째 복습'));
  assert.ok(t.includes('먼저 답을 떠올린 뒤 확인해 보세요'));
  assert.ok(/class="btn btn-primary w-full"[^>]*>정답 보기/.test(html));
  assert.ok(!html.includes('primary-surface'), 'no orange inversion');
  console.log('STUDY_REVIEW_VERIFIED');
});
