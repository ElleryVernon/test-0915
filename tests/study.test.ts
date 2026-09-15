import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { isDue, previewIntervals, scheduleCard } from '../src/lib/srs';
import {
  acknowledgeAiTask,
  AiTaskFailureError,
  clearAiTasks,
  findAiTask,
  inspectAiTask,
  runAiTask,
} from '../src/lib/ai-task';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  cacheCards,
  cachedCards,
  clearStudyCache,
  pendingReviews,
  queueReview,
  syncReviews,
} from '../src/lib/offline';
import {
  detectHighlights,
  exclusively,
  generatedItemCount,
  dueCards,
  exactKeywords,
  exactOrder,
  latestAttempts,
  localReview,
  normalizeMask,
  wrongEssays,
  wrongQuestions,
} from '../src/components/study/logic';
import StudyScreens from '../src/components/study';
import PdfViewer from '../src/components/study/pdf-viewer';
import { PDF_ASSET_BASE, renderPdfPage } from '../src/components/study/pdf-render';
import { recoverGenerationTask } from '../src/components/study/generation-task';
import { uploadFile, validateUploadSize } from '../src/components/study/shared';
import type { AppData, Card, ScreenProps, StudyAttempt } from '../src/lib/contracts';

const now = Date.parse('2026-09-15T10:00:00Z');
const card: Card = {
  id: 'card-1',
  subjectId: 'subject-1',
  front: '삼투가 일어나는 조건은?',
  back: '선택적 투과성 막과 농도 차이',
  type: 'CONCEPT',
  bucket: 'AGAIN',
  consecutiveEasy: 0,
  nextReviewAt: new Date(now - 1000).toISOString(),
  deleted: false,
};
const data: AppData = {
  profile: {
    id: 'student-1',
    name: '테스트',
    nickname: '학습자',
    role: 'STUDENT',
    school: '테스트학교',
    grade: '고1',
    streak: 0,
    points: 0,
    privacy: { accuracy: true, time: true, wrongNotes: false },
    completedSubjects: [],
  },
  subjects: [
    {
      id: 'subject-1',
      name: '생명과학',
      semester: '2026 2학기',
      icon: 'science',
      color: 'gray',
      materialCount: 1,
      questionCount: 1,
      cardCount: 1,
    },
  ],
  materials: [
    {
      id: 'material-1',
      subjectId: 'subject-1',
      title: '수업 노트',
      type: 'text/plain',
      content: '삼투는 선택적 투과성 막을 통한 물의 이동이다.',
      createdAt: new Date(now).toISOString(),
    },
  ],
  questions: [
    {
      id: 'question-1',
      subjectId: 'subject-1',
      materialId: 'material-1',
      prompt: '삼투의 특징은?',
      options: ['선택적 투과성 막', 'ATP 필요', '막이 필요 없음', '항상 같은 농도', '용질만 이동'],
      answer: 0,
      explanation: '물은 농도 차이에 따라 이동한다.',
      citation: '삼투는 선택적 투과성 막을 통한 물의 이동이다.',
      past: '확산',
      future: '수분 퍼텐셜',
    },
  ],
  essays: [
    {
      id: 'essay-1',
      subjectId: 'subject-1',
      materialId: 'material-1',
      prompt: '삼투의 과정을 서술하세요.',
      keywords: ['막', '농도 차이', '물', '이동'],
      distractors: ['빛', '소리', '열', '전기'],
      modelAnswer: '막 사이의 농도 차이에 따라 물이 이동한다.',
      citation: '삼투는 선택적 투과성 막을 통한 물의 이동이다.',
    },
  ],
  cards: [card],
  attempts: [],
  schedules: [],
  posts: [],
  cheers: [],
  notifications: [],
  stats: { todayCards: 0, todayQuestions: 0, accuracy: 0, studyMinutes: 0, weekly: [] },
  aiAvailable: false,
  demo: true,
};
function attempt(
  id: string,
  target: string,
  correct: boolean,
  score: number,
  createdAt: string,
  essay = false,
): StudyAttempt {
  return {
    id,
    [essay ? 'essayId' : 'questionId']: target,
    correct,
    score,
    answer: '답안',
    createdAt,
  };
}

test('latest attempts remove corrected questions and perfect essays from wrong notes even with unsorted input', () => {
  const attempts = [
    attempt('new-q', 'question-1', true, 100, '2026-09-15T12:00:00Z'),
    attempt('old-q', 'question-1', false, 0, '2026-09-15T11:00:00Z'),
    attempt('old-e', 'essay-1', false, 60, '2026-09-15T10:00:00Z', true),
    attempt('new-e', 'essay-1', true, 100, '2026-09-15T13:00:00Z', true),
  ];
  assert.equal(latestAttempts(attempts, 'questionId').get('question-1')?.id, 'new-q');
  assert.equal(wrongQuestions({ ...data, attempts }).length, 0);
  assert.equal(wrongEssays({ ...data, attempts }).length, 0);
  assert.equal(
    wrongQuestions({ ...data, attempts: attempts.filter((a) => a.id !== 'new-q') }).length,
    1,
  );
  assert.equal(
    wrongEssays({ ...data, attempts: attempts.filter((a) => a.id !== 'new-e') }).length,
    1,
  );
});

test('PDF canvas uses matching local resources and paints both document pages', async () => {
  const appPackage = JSON.parse(await readFile('package.json', 'utf8'));
  const pdfPackage = JSON.parse(await readFile('node_modules/pdfjs-dist/package.json', 'utf8'));
  assert.equal(appPackage.dependencies['pdfjs-dist'], pdfPackage.version);
  assert.equal(PDF_ASSET_BASE, `/pdfjs/${pdfPackage.version}`);
  assert.deepEqual(
    await readFile(`public${PDF_ASSET_BASE}/pdf.worker.min.mjs`),
    await readFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
    'The same-origin worker must match the bundled PDF.js engine exactly',
  );
  for (const file of [
    'LICENSE',
    'cmaps/Adobe-Korea1-UCS2.bcmap',
    'standard_fonts/LiberationSans-Regular.ttf',
    'wasm/openjpeg.wasm',
  ]) {
    assert.ok((await readFile(`public${PDF_ASSET_BASE}/${file}`)).byteLength > 100);
  }
  const markup = renderToStaticMarkup(
    createElement(PdfViewer, {
      url: '/api/uploads/owned-pdf',
      title: '수업 자료',
    }),
  );
  assert.doesNotMatch(markup, /<iframe/);
  assert.match(markup, /이전 페이지/);
  assert.match(markup, /다음 페이지/);
  assert.match(markup, /PDF를 불러오고 있어요/);
  assert.match(markup, /aria-busy="true"/);

  const streams = [
    '1 0.4 0.1 rg 40 260 220 80 re f 0 0 0 rg BT /F1 22 Tf 40 200 Td (Memoryz page one) Tj ET',
    '0.98 0.8 0.2 rg 40 260 220 80 re f 0 0 0 rg BT /F1 22 Tf 40 200 Td (Memoryz page two) Tj ET',
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map((stream) => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(source.length);
    source += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const { createCanvas } = await import('@napi-rs/canvas');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new TextEncoder().encode(source),
    standardFontDataUrl: `${resolve(`public${PDF_ASSET_BASE}/standard_fonts`)}/`,
    isEvalSupported: false,
  });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 2);
    for (const number of [1, 2]) {
      const page = await document.getPage(number);
      const canvas = Object.assign(createCanvas(1, 1), { style: {} });
      await renderPdfPage(page, canvas as unknown as HTMLCanvasElement, 300, 3).promise;
      assert.equal(canvas.width, 600, 'High-DPI rendering caps the scale at 2');
      assert.equal(canvas.height, 800);
      const fill = canvas.getContext('2d').getImageData(160, 200, 1, 1).data;
      assert.ok(
        fill[0] > 240 && fill[2] < 65 && fill[3] === 255,
        'The PDF rectangle is actually painted',
      );
      assert.ok(
        number === 1 ? fill[1] < 120 : fill[1] > 180,
        'Page navigation paints distinct page content',
      );
      const background = canvas.getContext('2d').getImageData(10, 10, 1, 1).data;
      assert.deepEqual([...background], [255, 255, 255, 255]);
      const text = await page.getTextContent();
      assert.ok(
        text.items.some(
          (item) => 'str' in item && item.str === `Memoryz page ${number === 1 ? 'one' : 'two'}`,
        ),
      );
    }
    const page = await document.getPage(1);
    const cancelledCanvas = Object.assign(createCanvas(1, 1), { style: {} });
    const cancelled = renderPdfPage(page, cancelledCanvas as unknown as HTMLCanvasElement, 300, 1);
    cancelled.cancel();
    await assert.rejects(cancelled.promise, { name: 'RenderingCancelledException' });
    const nextCanvas = Object.assign(createCanvas(1, 1), { style: {} });
    await renderPdfPage(page, nextCanvas as unknown as HTMLCanvasElement, 360, 2).promise;
    assert.equal(
      nextCanvas.width,
      720,
      'Rendering after cancellation uses a fresh responsive canvas',
    );
    console.log('STUDY_PDF_CANVAS_VERIFIED');
  } finally {
    await task.destroy();
  }
});
test('essay gates require every true keyword once, reject distractors and enforce complete order', () => {
  const words = ['막', '농도', '물', '이동'];
  assert.equal(exactKeywords([...words].reverse(), words), true);
  assert.equal(exactKeywords(['막', '농도', '물'], words), false);
  assert.equal(exactKeywords(['막', '농도', '물', '빛'], words), false);
  assert.equal(exactKeywords(['막', '막', '물', '이동'], words), false);
  assert.equal(exactOrder(words, words), true);
  assert.equal(exactOrder([...words].reverse(), words), false);
  assert.equal(exactOrder(words.slice(1), words), false);
});
test('SRS preview uses exact review intervals and consecutive easy mastery, excludes deleted/future/mastered cards', () => {
  for (const [rating, minutes] of [
    ['AGAIN', 10],
    ['HARD', 1440],
    ['GOOD', 4320],
    ['EASY', 10080],
  ] as const)
    assert.equal(Date.parse(localReview(card, rating, now).nextReviewAt) - now, minutes * 60000);
  const easy = localReview(card, 'EASY', now);
  const mastered = localReview(easy, 'EASY', now);
  assert.equal(mastered.bucket, 'MASTERED');
  assert.equal(mastered.consecutiveEasy, 2);
  assert.equal(localReview(easy, 'GOOD', now).consecutiveEasy, 0);
  assert.deepEqual(
    dueCards(
      [
        card,
        { ...card, id: 'deleted', deleted: true },
        { ...card, id: 'later', nextReviewAt: new Date(now + 1000).toISOString() },
        { ...mastered, id: 'mastered', nextReviewAt: new Date(now - 1000).toISOString() },
      ],
      now,
    ).map((c) => c.id),
    ['card-1'],
  );
});
test('mask editor normalizes reverse drags, clamps image boundaries, rejects click-sized rectangles and detects actual yellow regions', () => {
  assert.deepEqual(normalizeMask({ x: 80, y: 60 }, { x: 20, y: 10 }), {
    x: 20,
    y: 10,
    width: 60,
    height: 50,
  });
  assert.deepEqual(normalizeMask({ x: -20, y: -40 }, { x: 130, y: 150 }), {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  assert.equal(normalizeMask({ x: 4, y: 4 }, { x: 4.1, y: 4.1 }), null);
  const pixels = new Uint8ClampedArray(20 * 20 * 4).fill(255);
  assert.deepEqual(detectHighlights(pixels, 20, 20), []);
  for (let y = 5; y < 8; y++)
    for (let x = 4; x < 15; x++) pixels.set([255, 225, 30, 255], (y * 20 + x) * 4);
  // An orange diagram arrow is a negative control, not a yellow marked phrase.
  for (let y = 10; y < 16; y++)
    for (let x = 16; x < 18; x++) pixels.set([255, 129, 52, 255], (y * 20 + x) * 4);
  const masks = detectHighlights(pixels, 20, 20);
  assert.equal(masks.length, 1);
  assert.equal(masks[0].x, 15);
  assert.ok(masks[0].width > 40);
  assert.ok(masks[0].height < 40);
  assert.throws(() => detectHighlights(pixels, 21, 20), /dimensions/);
});
test('IndexedDB preserves unsynced reviews across server refresh, retries exact IDs, serializes per user, and clears only the selected account', async () => {
  const first = 'queue-user-1',
    second = 'queue-user-2';
  await clearStudyCache(first);
  await clearStudyCache(second);
  await cacheCards(first, [card]);
  await cacheCards(second, [{ ...card, front: '다른 사용자 전용' }]);
  const easy = await queueReview(first, card, 'EASY', 'review-1');
  await queueReview(first, easy, 'EASY', 'review-2');
  assert.equal((await cachedCards(first))[0].bucket, 'MASTERED');
  await cacheCards(first, [card]);
  assert.equal((await cachedCards(first))[0].bucket, 'MASTERED');
  await queueReview(first, card, 'EASY', 'review-2');
  assert.equal((await pendingReviews(first)).length, 2);
  assert.equal((await cachedCards(first))[0].consecutiveEasy, 2);
  const queue = await pendingReviews(first);
  assert.deepEqual(
    queue.map((r) => r.reviewId),
    ['review-1', 'review-2'],
  );
  assert.ok(queue[0].createdAt < queue[1].createdAt);
  const received: string[] = [];
  let server = card;
  await assert.rejects(
    syncReviews(first, async (item) => {
      received.push(item.reviewId);
      throw new Error('network lost after server accepted');
    }),
    /network lost/,
  );
  assert.equal((await pendingReviews(first)).length, 2);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = syncReviews(first, async (item) => {
    received.push(item.reviewId);
    if (item.reviewId === 'review-1') await waiting;
    server = localReview(server, item.rating);
    return server;
  });
  const same = syncReviews(first, async () => {
    assert.fail('A concurrent flush must not duplicate requests');
  });
  await queueReview(second, card, 'HARD', 'review-other');
  await queueReview(first, (await cachedCards(first))[0], 'GOOD', 'review-during-sync');
  const otherCount = await syncReviews(second, async (item) => {
    assert.equal(item.userId, second);
    return localReview(card, item.rating);
  });
  assert.equal(otherCount, 1);
  release();
  assert.equal(await run, 3);
  assert.equal(await same, 3);
  assert.deepEqual(received, ['review-1', 'review-1', 'review-2', 'review-during-sync']);
  assert.equal((await pendingReviews(first)).length, 0);
  assert.equal((await cachedCards(first))[0].bucket, 'GOOD');
  await clearStudyCache(first);
  assert.equal((await cachedCards(first)).length, 0);
  assert.equal((await cachedCards(second)).length, 1);
  await clearStudyCache(second);
  console.log('STUDY_LOGIC_VERIFIED');
});
test('every study route renders data or an actionable empty state without unavailable AI success claims', () => {
  const routes = [
    '/study',
    '/subjects',
    '/subjects/subject-1',
    '/subjects/missing',
    '/quiz',
    '/quiz?question=question-1',
    '/essay',
    '/essay?essay=essay-1',
    '/flashcards',
    '/flashcards?review=1',
    '/wrong-notes',
    '/create-card',
    '/completed-subjects',
  ];
  for (const path of routes) {
    const props: ScreenProps = {
      data,
      path,
      refresh: async () => {},
      navigate: () => {},
      toast: () => {},
    };
    const html = renderToStaticMarkup(createElement(StudyScreens, props));
    assert.ok(html.includes('<button'), `${path} must expose a usable action`);
    assert.ok(html.length > 500, `${path} must render its content`);
    const empty = renderToStaticMarkup(
      createElement(StudyScreens, {
        ...props,
        data: { ...data, subjects: [], cards: [], materials: [], questions: [], essays: [] },
      }),
    );
    assert.ok(empty.includes('<button'), `${path} must provide an exit or recovery when empty`);
  }
  const quiz = renderToStaticMarkup(
    createElement(StudyScreens, {
      data,
      path: '/quiz?question=question-1',
      refresh: async () => {},
      navigate: () => {},
      toast: () => {},
    }),
  );
  assert.equal((quiz.match(/role="radio"/g) || []).length, 5);
  assert.ok(quiz.includes('잘 모르겠어요'));
  assert.ok(quiz.includes('disabled=""'));
  const essay = renderToStaticMarkup(
    createElement(StudyScreens, {
      data,
      path: '/essay?essay=essay-1',
      refresh: async () => {},
      navigate: () => {},
      toast: () => {},
    }),
  );
  assert.ok(essay.includes('키워드를 모두 맞히면'));
  assert.equal(essay.includes('<textarea'), false, 'Writing must be gated by prerequisite stages');
  console.log('STUDY_RENDER_VERIFIED');
});

test('adaptive FSRS retains exact offline review times, preferences and mastered due behavior with shared scheduler parity', async () => {
  const userId = 'adaptive-test-user';
  const reviewedAt = Date.parse('2026-09-15T10:04:05.678Z');
  const retention = 0.92;
  await clearStudyCache(userId);
  await cacheCards(userId, [card]);
  const expected = scheduleCard(card, 'EASY', 'FSRS', retention, reviewedAt);
  const optimistic = localReview(card, 'EASY', reviewedAt, 'FSRS', retention);
  const queued = await queueReview(
    userId,
    card,
    'EASY',
    'fsrs-review-1',
    'FSRS',
    retention,
    reviewedAt,
  );
  assert.deepEqual(optimistic, expected);
  assert.deepEqual(queued, expected);
  const nextTime = reviewedAt + 3 * 86400000;
  const mastered = await queueReview(
    userId,
    queued,
    'EASY',
    'fsrs-review-2',
    'FSRS',
    retention,
    nextTime,
  );
  assert.equal(mastered.bucket, 'MASTERED');
  assert.ok(mastered.fsrs);
  assert.equal(mastered.fsrs.reps, 2);
  const entries = await pendingReviews(userId);
  assert.deepEqual(
    entries.map((e) => e.reviewedAt),
    [reviewedAt, nextTime],
  );
  assert.ok(entries.every((e) => e.mode === 'FSRS' && e.retention === retention));
  assert.ok(entries[0].createdAt < entries[1].createdAt);
  assert.notEqual(
    entries[0].createdAt,
    entries[0].reviewedAt,
    'Upload queue order must not replace the real review time',
  );
  const dueAt = Date.parse(mastered.nextReviewAt);
  assert.equal(isDue(mastered, dueAt - 1), false);
  assert.equal(isDue(mastered, dueAt), true);
  assert.deepEqual(dueCards([mastered], dueAt), [mastered]);
  const fixedMastered = localReview({ ...card, consecutiveEasy: 1 }, 'EASY', reviewedAt);
  assert.equal(fixedMastered.fsrs, null);
  assert.equal(dueCards([fixedMastered], dueAt + 365 * 86400000).length, 0);
  const fixedPreview = previewIntervals(card, 'FIXED', 0.9, reviewedAt);
  assert.deepEqual(
    fixedPreview.map((entry) => Date.parse(entry.due) - reviewedAt),
    [600000, 86400000, 259200000, 604800000],
  );
  const adaptivePreview = previewIntervals(card, 'FSRS', retention, reviewedAt);
  assert.equal(
    adaptivePreview.find((entry) => entry.rating === 'EASY')?.due,
    expected.nextReviewAt,
  );
  let serverCard = card;
  const synchronized = await syncReviews(userId, async (item) => {
    serverCard = scheduleCard(serverCard, item.rating, item.mode, item.retention, item.reviewedAt);
    return serverCard;
  });
  assert.equal(synchronized, 2);
  assert.deepEqual(serverCard, mastered);
  assert.deepEqual((await cachedCards(userId))[0], mastered);
  assert.equal((await pendingReviews(userId)).length, 0);
  // Old pre-FSRS queues still load and sync with the requested fixed defaults.
  const db = await openDB('memoryz-study-v1', 2);
  await db.put('reviews', {
    userId,
    cardId: card.id,
    reviewId: 'legacy-review',
    rating: 'GOOD',
    createdAt: reviewedAt,
  });
  const legacy = (await pendingReviews(userId))[0];
  assert.equal(legacy.mode, 'FIXED');
  assert.equal(legacy.retention, 0.9);
  assert.equal(legacy.reviewedAt, reviewedAt);
  db.close();
  await clearStudyCache(userId);
  console.log('STUDY_FSRS_VERIFIED');
});

test('generation response validation rejects empty or mismatched success and action locking prevents double-submit through completion or failure', async () => {
  assert.equal(generatedItemCount(data.questions, 'quiz', 1), 1);
  assert.equal(generatedItemCount(data.essays, 'essay', 1), 1);
  assert.equal(generatedItemCount(data.cards, 'cards', 1), 1);
  for (const invalid of [
    undefined,
    null,
    [],
    {},
    { data: data.cards },
    [{ ...card, back: '' }],
    [{ ...card, id: '' }],
  ])
    assert.throws(() => generatedItemCount(invalid, 'cards', 1), /생성 결과/);
  assert.throws(() => generatedItemCount([card, card], 'cards', 2), /생성 결과/);
  assert.throws(
    () => generatedItemCount([{ ...data.questions[0], options: ['one'] }], 'quiz', 1),
    /생성 결과/,
  );
  assert.throws(
    () => generatedItemCount([{ ...data.questions[0], answer: 5 }], 'quiz', 1),
    /생성 결과/,
  );
  assert.throws(
    () => generatedItemCount([{ ...data.essays[0], keywords: [] }], 'essay', 1),
    /생성 결과/,
  );
  const lock = { current: false };
  let calls = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = exclusively(lock, async () => {
    calls++;
    await waiting;
  });
  assert.equal(lock.current, true);
  const duplicate = await exclusively(lock, async () => {
    calls++;
  });
  assert.equal(duplicate, false);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
  assert.equal(lock.current, false);
  await assert.rejects(
    exclusively(lock, async () => {
      throw new Error('generation failed');
    }),
    /generation failed/,
  );
  assert.equal(lock.current, false);
  assert.equal(
    await exclusively(lock, async () => {
      calls++;
    }),
    true,
  );
  assert.equal(calls, 2);
  console.log('STUDY_GENERATION_VERIFIED');
});

test('AI task harness retains identity, restores completed and running work with GET only, gates terminal retries and isolates accounts', async () => {
  const originalFetch = globalThis.fetch;
  const userId = 'ai-task-test-user';
  const otherUser = 'ai-task-other-user';
  await clearAiTasks(userId);
  await clearAiTasks(otherUser);
  const records = new Map<
    string,
    { requestId: string; status: string; result: unknown; error: string | null; updatedAt: string }
  >();
  let behavior: 'success' | 'fail' | 'lost-response' | 'accepted' = 'success';
  let postCount = 0;
  let getCount = 0;
  const postedIds: string[] = [];
  const runningGets = new Map<string, number>();
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      postCount++;
      postedIds.push(body.requestId);
      const record = {
        requestId: body.requestId,
        status: behavior === 'fail' ? 'FAILED' : behavior === 'accepted' ? 'RUNNING' : 'COMPLETED',
        result: behavior === 'fail' ? null : { value: 'stored-result' },
        error: behavior === 'fail' ? 'provider failed' : null,
        updatedAt: new Date().toISOString(),
      };
      records.set(body.requestId, record);
      if (behavior === 'fail') return Response.json({ error: 'provider failed' }, { status: 502 });
      if (behavior === 'lost-response') throw new TypeError('Network response lost after commit');
      if (behavior === 'accepted')
        return Response.json(
          { data: { requestId: body.requestId, status: 'RUNNING' } },
          { status: 202 },
        );
      return Response.json({ data: record.result });
    }
    getCount++;
    const id = path.split('/').pop()!;
    const record = records.get(id);
    if (!record) return Response.json({ error: 'missing' }, { status: 404 });
    if (record.status === 'RUNNING') {
      const reads = (runningGets.get(id) || 0) + 1;
      runningGets.set(id, reads);
      if (reads >= 2) record.status = 'COMPLETED';
    }
    return Response.json({ data: record });
  };
  try {
    const payload = { materialId: 'material-1', mode: 'quiz', count: 3 };
    const lookup = { userId, endpoint: '/generate' as const, payload };
    const [first, concurrent] = await Promise.all([
      runAiTask(lookup),
      runAiTask({ ...lookup, payload: { count: 3, mode: 'quiz', materialId: 'material-1' } }),
    ]);
    assert.deepEqual(first, { value: 'stored-result' });
    assert.deepEqual(concurrent, first);
    assert.equal(postCount, 1);
    const stored = await findAiTask(lookup);
    assert.ok(stored);
    assert.equal(stored.status, 'COMPLETED');
    assert.deepEqual(await runAiTask(lookup), first);
    assert.equal(
      postCount,
      1,
      'A completed request must never be regenerated before acknowledgement',
    );
    assert.equal(await findAiTask({ ...lookup, userId: otherUser }), null);
    assert.equal((await inspectAiTask(stored!))?.requestId, postedIds[0]);
    assert.equal(postCount, 1);
    // Simulate a browser reload with a locally running task whose server execution finishes.
    const db = await openDB('memoryz-ai-tasks-v1', 1);
    const running = { ...stored!, status: 'RUNNING', result: null };
    await db.put('tasks', running);
    records.get(stored!.requestId)!.status = 'RUNNING';
    assert.deepEqual(await runAiTask(lookup), first);
    assert.equal(postCount, 1, 'Running recovery only polls GET');
    await acknowledgeAiTask(lookup);
    assert.equal(await findAiTask(lookup), null);
    assert.deepEqual(await runAiTask(lookup), first);
    assert.equal(postCount, 2);
    assert.notEqual(postedIds[0], postedIds[1]);
    const failedLookup = {
      userId,
      endpoint: '/essay/submit' as const,
      payload: { essayId: 'essay-1', answer: 'saved draft answer' },
    };
    behavior = 'fail';
    await assert.rejects(runAiTask(failedLookup), AiTaskFailureError);
    const afterFailure = postCount;
    const failed = await findAiTask(failedLookup);
    assert.equal(failed?.status, 'FAILED');
    await assert.rejects(runAiTask(failedLookup), AiTaskFailureError);
    assert.equal(postCount, afterFailure);
    behavior = 'success';
    await runAiTask({ ...failedLookup, retryFailed: true });
    assert.equal(postCount, afterFailure + 1);
    assert.notEqual(postedIds.at(-1), failed?.requestId);
    const interrupted = await findAiTask(failedLookup);
    assert.ok(interrupted);
    await db.put('tasks', { ...interrupted, status: 'RUNNING', result: null });
    records.get(interrupted!.requestId)!.status = 'INTERRUPTED';
    const beforeInterrupted = postCount;
    await assert.rejects(runAiTask(failedLookup), AiTaskFailureError);
    assert.equal(postCount, beforeInterrupted);
    await runAiTask({ ...failedLookup, retryFailed: true });
    assert.equal(postCount, beforeInterrupted + 1);
    behavior = 'lost-response';
    const lostLookup = {
      userId,
      endpoint: '/generate' as const,
      payload: { materialId: 'material-lost', mode: 'cards', count: 3 },
    };
    const beforeLost = postCount;
    assert.deepEqual(await runAiTask(lostLookup), first);
    assert.equal(postCount, beforeLost + 1);
    behavior = 'accepted';
    const acceptedLookup = {
      userId,
      endpoint: '/planner/suggest' as const,
      payload: { date: '2026-09-15' },
    };
    assert.deepEqual(
      await runAiTask(acceptedLookup),
      first,
      'Accepted RUNNING envelope must not be returned as the final result',
    );
    behavior = 'success';
    await runAiTask({ ...lookup, userId: otherUser });
    assert.ok(await findAiTask({ ...lookup, userId: otherUser }));
    await clearAiTasks(userId);
    assert.equal(await findAiTask(lookup), null);
    assert.ok(await findAiTask({ ...lookup, userId: otherUser }));
    assert.ok(getCount > postCount);
    db.close();
    console.log('STUDY_AI_TASK_VERIFIED');
  } finally {
    globalThis.fetch = originalFetch;
    await clearAiTasks(userId);
    await clearAiTasks(otherUser);
  }
});

test('Generation recovery restores the original count without another POST and respects acknowledged work', async () => {
  const originalFetch = globalThis.fetch;
  const userId = 'generation-recovery-user';
  const otherUser = 'generation-recovery-other-user';
  const materialId = 'material-recovery';
  const records = new Map<
    string,
    { requestId: string; status: string; result: unknown; error: null; updatedAt: string }
  >();
  const posted: { requestId: string; count: number }[] = [];
  let getCount = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      const result = Array.from({ length: body.count }, (_, i) => ({
        id: `${body.requestId}-${i}`,
        prompt: '복구한 문제',
        citation: '자료에서 찾은 근거',
        options: ['가', '나', '다', '라', '마'],
        answer: 1,
      }));
      records.set(body.requestId, {
        requestId: body.requestId,
        status: 'COMPLETED',
        result,
        error: null,
        updatedAt: new Date().toISOString(),
      });
      return Response.json({ data: result });
    }
    getCount++;
    const record = records.get(String(input).split('/').pop()!);
    return record
      ? Response.json({ data: record })
      : Response.json({ error: 'missing' }, { status: 404 });
  };
  const five = {
    userId,
    endpoint: '/generate' as const,
    payload: { materialId, count: 5, mode: 'quiz' },
  };
  const three = { ...five, payload: { materialId, count: 3, mode: 'quiz' } };
  const lookup = { userId, materialId, mode: 'quiz' as const };
  await clearAiTasks(userId);
  await clearAiTasks(otherUser);
  try {
    await runAiTask(five);
    await runAiTask(three);
    await runAiTask({
      ...three,
      payload: { materialId: 'other-material', count: 10, mode: 'quiz' },
    });
    await runAiTask({ ...three, payload: { materialId, count: 10, mode: 'cards' } });
    await runAiTask({ ...three, userId: otherUser });
    const storedThree = await findAiTask(three);
    const storedFive = await findAiTask(five);
    assert.ok(storedThree && storedFive);
    const db = await openDB('memoryz-ai-tasks-v1', 1);
    await db.put('tasks', { ...storedFive, updatedAt: storedThree.updatedAt - 1000 });
    records.get(storedThree.requestId)!.status = 'RUNNING';
    const postCount = posted.length;
    let restored = await recoverGenerationTask(lookup);
    assert.equal(restored?.count, 3, 'Default 5 must be replaced by the saved request count 3');
    assert.equal(restored?.task.requestId, storedThree.requestId);
    assert.equal(restored?.task.status, 'RUNNING');
    assert.equal(posted.length, postCount, 'Reopening only reads the saved task status');
    records.get(storedThree.requestId)!.status = 'COMPLETED';
    restored = await recoverGenerationTask(lookup);
    assert.equal(generatedItemCount(restored?.task.result, 'quiz', restored!.count), 3);
    await acknowledgeAiTask(three);
    restored = await recoverGenerationTask(lookup);
    assert.equal(restored?.count, 5, 'Only remaining unacknowledged work is recovered');
    await acknowledgeAiTask(five);
    assert.equal(await recoverGenerationTask(lookup), null);
    await runAiTask(five);
    assert.equal(posted.length, postCount + 1);
    assert.equal(
      posted.at(-1)?.count,
      5,
      'After acknowledgement the new user-selected count is respected',
    );
    assert.notEqual(posted.at(-1)?.requestId, storedFive.requestId);
    assert.ok(getCount >= 3);
    db.close();
    validateUploadSize({ size: 10_000_000 });
    assert.throws(() => validateUploadSize({ size: 10_000_001 }), /10MB/);
    assert.throws(() => validateUploadSize({ size: 0 }), /빈 파일/);
    const beforeRejectedUpload = posted.length;
    await assert.rejects(uploadFile(new File([], 'empty.txt', { type: 'text/plain' })), /빈 파일/);
    await assert.rejects(
      uploadFile(new File([new Uint8Array(10_000_001)], 'large.txt', { type: 'text/plain' })),
      /10MB/,
    );
    assert.equal(
      posted.length,
      beforeRejectedUpload,
      'Invalid uploads are rejected before any network request',
    );
    console.log('STUDY_GENERATION_RECOVERY_VERIFIED');
  } finally {
    globalThis.fetch = originalFetch;
    await clearAiTasks(userId);
    await clearAiTasks(otherUser);
  }
});
