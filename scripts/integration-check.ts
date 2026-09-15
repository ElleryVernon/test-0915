import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/server/db';
import { createSession } from '../src/lib/server/auth';
const base = process.env.TEST_APP_URL ?? 'http://127.0.0.1:3000';
const database = new URL(process.env.DATABASE_URL!);
assert(
  ['127.0.0.1', 'localhost'].includes(database.hostname) &&
    database.port === '15444' &&
    database.pathname === '/memoryz',
  'Refuse to mutate any database except dedicated local memoryz:15444',
);
assert(
  ['127.0.0.1', 'localhost'].includes(new URL(base).hostname),
  'HTTP test target must be loopback',
);
const prefix = 'qa-' + randomUUID();
let checks = 0;
async function call(path: string, body?: unknown, method?: string, cookie?: string, status = 200) {
  const response = await fetch(base + '/api' + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(payload)}`);
  checks++;
  return payload.data;
}
try {
  const student = await db.user.create({
    data: {
      id: prefix + '-student',
      name: '검증 학생',
      nickname: prefix + '-student',
      role: 'STUDENT',
    },
  });
  const other = await db.user.create({
    data: {
      id: prefix + '-other',
      name: '다른 학생',
      nickname: prefix + '-other',
      role: 'STUDENT',
    },
  });
  const parent = await db.user.create({
    data: {
      id: prefix + '-parent',
      name: '검증 학부모',
      nickname: prefix + '-parent',
      role: 'PARENT',
      points: 500,
    },
  });
  const sc = (await createSession(student.id, new Request(base))).split(';')[0];
  const oc = (await createSession(other.id, new Request(base))).split(';')[0];
  const pc = (await createSession(parent.id, new Request(base))).split(';')[0];
  await call('/bootstrap', undefined, undefined, undefined, 401);
  await call('/posts?role=PARENT', undefined, undefined, sc, 403);
  await call('/posts?role=STUDENT', undefined, undefined, pc, 403);
  const blockedRoute = await fetch(base + '/parent-boards', { headers: { Cookie: sc } });
  assert.equal(blockedRoute.status, 403);
  checks++;
  const subject = await call('/subjects', { name: '검증용 생물' }, 'POST', sc, 201);
  await call('/subjects/' + subject.id, { name: '타인 수정' }, 'PATCH', oc, 404);
  const material = await call(
    '/materials',
    {
      subjectId: subject.id,
      title: '세포의 에너지',
      content:
        '세포 호흡은 포도당을 분해하여 ATP를 만드는 과정이다. ATP는 세포 활동에 필요한 에너지를 공급한다.',
      type: 'TXT',
    },
    'POST',
    sc,
    201,
  );
  await call('/materials/' + material.id, { title: '다른 이름' }, 'PATCH', oc, 404);
  const question = await db.question.create({
    data: {
      userId: student.id,
      subjectId: subject.id,
      materialId: material.id,
      prompt: 'ATP를 만드는 과정은?',
      options: ['광합성', '세포 호흡', '확산', '삼투', '복제'],
      answer: 1,
      explanation: '포도당의 에너지가 ATP로 전환됩니다.',
      citation: material.content.split('. ')[0] + '.',
      past: '포도당',
      future: '전자 전달계',
    },
  });
  const wrong = await call('/quiz/answer', { questionId: question.id, answer: 0 }, undefined, sc);
  assert.equal(wrong.correct, false);
  await call('/quiz/answer', { questionId: question.id, answer: 1 }, undefined, oc, 404);
  const converted = await call('/wrong-notes/cards', { questionIds: [question.id] }, undefined, sc);
  assert.equal(converted.length, 1);
  const convertedAgain = await call(
    '/wrong-notes/cards',
    { questionIds: [question.id] },
    undefined,
    sc,
  );
  assert.equal(convertedAgain[0].id, converted[0].id);
  const card = await call(
    '/cards',
    { subjectId: subject.id, front: 'ATP', back: '세포의 에너지 화폐', type: 'CONCEPT' },
    undefined,
    sc,
    201,
  );
  const reviewId = randomUUID();
  const first = await call(
    '/cards/review',
    { cardId: card.id, rating: 'EASY', reviewId },
    undefined,
    sc,
  );
  assert.equal(first.bucket, 'EASY');
  const retry = await call(
    '/cards/review',
    { cardId: card.id, rating: 'EASY', reviewId },
    undefined,
    sc,
  );
  assert.equal(retry.consecutiveEasy, 1);
  assert.equal(await db.cardReview.count({ where: { cardId: card.id } }), 1);
  const second = await call(
    '/cards/review',
    { cardId: card.id, rating: 'EASY', reviewId: randomUUID() },
    undefined,
    sc,
  );
  assert.equal(second.bucket, 'MASTERED');
  await call(
    '/cards/review',
    { cardId: card.id, rating: 'HARD', reviewId: randomUUID() },
    undefined,
    oc,
    404,
  );
  await call('/cards/' + card.id, { deleted: true }, 'PATCH', sc);
  await call('/cards/' + card.id, { deleted: false }, 'PATCH', sc);
  const essay = await db.essay.create({
    data: {
      userId: student.id,
      subjectId: subject.id,
      materialId: material.id,
      prompt: '세포 호흡을 설명하세요.',
      keywords: ['포도당', '분해', 'ATP', '에너지'],
      distractors: ['산소', '복제', '염색체', '물'],
      modelAnswer: '포도당을 분해하여 ATP를 만들고 세포 활동에 필요한 에너지를 공급한다.',
      citation: material.content,
    },
  });
  const essayRequestId = randomUUID();
  const essayPayload = { essayId: essay.id, answer: '포도당이 관여합니다.', requestId: essayRequestId };
  const essayResult = await call(
    '/essay/submit',
    essayPayload,
    undefined,
    sc,
  );
  assert(essayResult.score < 100);
  assert(essayResult.missing.length > 0);
  assert.deepEqual(await call('/essay/submit', essayPayload, undefined, sc), essayResult);
  const completedRun = await call('/ai-runs/' + essayRequestId, undefined, undefined, sc);
  assert.equal(completedRun.status, 'COMPLETED');
  assert.deepEqual(completedRun.result, essayResult);
  assert.deepEqual(completedRun.steps.map((step: { stage: string }) => step.stage), ['LOAD_CONTEXT', 'GENERATE', 'VALIDATE', 'COMMIT']);
  await call('/ai-runs/' + essayRequestId, undefined, undefined, oc, 404);
  await call('/essay/submit', { ...essayPayload, answer: '변경된 답변입니다.' }, undefined, sc, 409);
  const schedule = await call(
    '/schedules',
    { title: '통합 검증 공부', date: '2099-01-15', start: '16:00', end: '16:45', kind: 'FIXED' },
    undefined,
    sc,
    201,
  );
  await call(
    '/schedules',
    { title: '겹침', date: '2099-01-15', start: '16:30', end: '17:00', kind: 'FLEXIBLE' },
    undefined,
    sc,
    409,
  );
  await call(
    '/schedules',
    { title: '날짜 오류', date: '2099-02-31', start: '17:00', end: '17:30', kind: 'FIXED' },
    undefined,
    sc,
    400,
  );
  await call('/schedules/' + schedule.id, { done: true }, 'PATCH', sc);
  const planPayload = { date: '2099-01-15', requestId: randomUUID() };
  const plans = await call('/planner/suggest', planPayload, undefined, sc);
  assert.deepEqual(await call('/planner/suggest', planPayload, undefined, sc), plans);
  assert.equal(plans.plans.length, 2);
  assert(
    plans.plans.every((p: { blocks: { start: string; end: string }[] }) =>
      p.blocks.every((b) => b.end <= '16:00' || b.start >= '16:45'),
    ),
  );
  type PlanResponse = { plans: { name: string; reason?: string; blocks: { start: string; end: string }[] }[] };
  assert(
    (plans as PlanResponse).plans.every((p) => typeof p.reason === 'string' && p.reason.length > 0),
    'every proposal states why it was chosen',
  );
  const laterPlans: PlanResponse = await call(
    '/planner/suggest',
    { date: '2099-01-15', after: '18:20', requestId: randomUUID() },
    undefined,
    sc,
  );
  assert(
    laterPlans.plans.some((p) => p.blocks.length) &&
      laterPlans.plans.every((p) => p.blocks.every((b) => b.start >= '18:20')),
    'proposals never start before the requested time',
  );
  await call('/planner/suggest', { date: '2099-01-15', after: '25:00' }, undefined, sc, 400);
  const subjectless = await call(
    '/schedules/' + schedule.id,
    { subjectId: null },
    'PATCH',
    sc,
  );
  assert.equal(subjectless.subjectId, null, 'a linked subject can be cleared');
  const invite = await call('/invite', {}, undefined, sc);
  assert.match(invite.code, /^\d{6}$/);
  await call('/link', { code: invite.code }, undefined, pc);
  await call(
    '/profile',
    { privacy: { accuracy: false, time: false, wrongNotes: false } },
    'PATCH',
    sc,
  );
  let parentState = await call('/bootstrap', undefined, undefined, pc);
  assert.equal(parentState.child.id, student.id);
  assert.equal(parentState.questions.length, 0);
  assert.equal(parentState.attempts.length, 0);
  assert.equal(parentState.schedules.length, 0);
  assert.equal(parentState.stats.accuracy, 0);
  await call('/cheers', { message: '차근차근 잘하고 있어요', points: 50 }, undefined, pc, 201);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: student.id } })).points, 50);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: parent.id } })).points, 450);
  const post = await call(
    '/posts',
    {
      title: '검증 학습 질문',
      body: '이 개념은 어떻게 기억하나요?',
      category: '자유',
      anonymous: true,
    },
    undefined,
    sc,
    201,
  );
  const feed = await call('/posts?role=STUDENT', undefined, undefined, oc);
  const anonymous = feed.find((p: { id: string }) => p.id === post.id);
  assert.equal(anonymous.authorId, '');
  assert.equal(anonymous.author, '익명');
  await call(`/posts/${post.id}/comments`, { body: '함께 복습해 봐요' }, undefined, oc, 201);
  await call(`/posts/${post.id}/like`, {}, undefined, oc);
  await call(`/posts/${post.id}/save`, {}, undefined, oc);
  await call(`/posts/${post.id}/comments`, undefined, undefined, pc, 403);
  const state = await call('/bootstrap', undefined, undefined, sc);
  assert(state.materials.some((m: { id: string }) => m.id === material.id));
  assert(state.cards.some((c: { id: string }) => c.id === card.id));
  assert(state.attempts.length === 2);
  if (!process.env.OPENROUTER_API_KEY)
    await call(
      '/generate',
      { materialId: material.id, count: 2, mode: 'quiz' },
      undefined,
      sc,
      503,
    );
  const csrf = await fetch(base + '/api/subjects', {
    method: 'POST',
    headers: { Cookie: sc, Origin: 'https://invalid.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '차단' }),
  });
  assert.equal(csrf.status, 403);
  checks++;
  const authUnavailable = await fetch(base + '/api/auth/google');
  if (!process.env.GOOGLE_CLIENT_ID) assert.equal(authUnavailable.status, 503);
  await call('/logout', {}, undefined, sc);
  await call('/bootstrap', undefined, undefined, sc, 401);
  console.log(
    `MEMORYZ_INTEGRATION_OK (${checks} HTTP checks; durable DB, cross-user and role negatives, retry deduplication, SRS, essay, scheduler, privacy, points, anonymous posts, CSRF, logout)`,
  );
} finally {
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.$disconnect();
}
