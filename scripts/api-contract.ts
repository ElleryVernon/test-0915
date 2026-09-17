// The outcome checks of the old in-process suite (scripts/backend-check.ts), replayed over HTTP
// against the Go server: uploads, quiz and wrong notes, card reviews in FIXED and FSRS mode with
// the browser's own scheduler as the oracle, profile preferences, essays, schedules, planner,
// community, admin, links, privacy, cheers, children, suspension, deletion — and the AI harness
// (staged runs, replay, concurrency, failures, interrupted runs) against a fake OpenRouter.
// Phase 1 uses the server serve.mjs started (no AI key); phase 2 starts its own Go server pointed
// at the fake provider. Throwaway qa- accounts only; nothing is charged.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { db, useServer } from './lib/db';
import { createSession } from './lib/session';
import { scheduleCard, isDue } from '../src/lib/srs';
import { inputHash } from './lib/hash';

const base = process.env.TEST_APP_URL!;
const database = new URL(process.env.DATABASE_URL!);
assert(['127.0.0.1', 'localhost'].includes(database.hostname) && database.port === '15444' && database.pathname === '/memoryz', 'dedicated local database only');
assert(base && ['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'HTTP test target must be loopback');
const prefix = `qa-contract-${randomUUID().slice(0, 8)}`;
const ids = { student: `${prefix}-s`, other: `${prefix}-o`, parent: `${prefix}-p`, admin: `${prefix}-a` };
const cookie: Record<string, string> = {};
let checks = 0;
const check = (ok: unknown, message: string) => {
  assert.ok(ok, message);
  checks++;
};
async function api(target: string, role: keyof typeof ids | null, route: string, method = 'GET', payload?: unknown, expected = 200, headers: Record<string, string> = {}) {
  const response = await fetch(`${target}/api/${route}`, {
    method,
    headers: { ...(role ? { cookie: cookie[role] } : {}), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
  checks++;
  return { data: result.data, error: result.error, headers: response.headers };
}
const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });

try {
  for (const [role, userId] of Object.entries(ids)) {
    await db.user.create({ data: { id: userId, name: '검증 계정', nickname: userId, role: role === 'parent' ? 'PARENT' : role === 'admin' ? 'ADMIN' : 'STUDENT', points: 1000 } });
    cookie[role] = (await createSession(userId, new Request(base))).split(';')[0];
  }
  const call = (role: keyof typeof ids | null, route: string, method = 'GET', payload?: unknown, expected = 200, headers: Record<string, string> = {}) =>
    api(base, role, route, method, payload, expected, headers).then((r) => r.data);

  // ---- Phase 1: no AI key ----
  await call(null, 'bootstrap', 'GET', undefined, 401);
  check((await call(null, 'health')).database === 'connected', 'health');
  await call('student', 'notifications', 'PATCH', { read: true }, 200, { origin: base, 'sec-fetch-site': 'same-origin' });
  await call('student', 'subjects', 'POST', { name: '검증 과목' }, 403, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  const subject = await call('student', 'subjects', 'POST', { name: '검증 생명과학' }, 201);
  await call('other', `subjects/${subject.id}`, 'PATCH', { name: '탈취' }, 404);
  await call('parent', 'subjects', 'POST', { name: '불법 과목' }, 403);

  const text = '나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.';
  const form = new FormData();
  form.append('file', new File([text], '테스트.txt', { type: 'text/plain' }), '테스트.txt');
  const uploadResponse = await fetch(`${base}/api/upload`, { method: 'POST', headers: { cookie: cookie.student, Origin: base }, body: form });
  check(uploadResponse.status === 200, `upload ${uploadResponse.status}`);
  const upload = (await uploadResponse.json()).data;
  check(upload.content === text && upload.type === 'TXT' && upload.title === '테스트' && upload.extraction === 'text', `upload payload ${JSON.stringify({ ...upload, content: undefined })}`);
  const served = await fetch(`${base}${upload.url}`, { headers: { cookie: cookie.student } });
  check(served.status === 200 && (await served.text()) === text, 'uploaded text served back verbatim');
  check((await fetch(`${base}${upload.url}`, { headers: { cookie: cookie.other } })).status === 404, "another account cannot read the file");
  const material = await call('student', 'materials', 'POST', { subjectId: subject.id, title: '검증 자료', content: upload.content, type: 'TXT', url: upload.url }, 201);
  check(material.type === 'TXT' && material.uploadId === upload.uploadId && material.extraction === 'text', 'material linked to the upload');
  await call('student', `materials/${material.id}`, 'PATCH', { title: '수정한 자료' });
  await call('other', `materials/${material.id}`, 'DELETE', undefined, 404);
  await call('student', 'generate', 'POST', { materialId: material.id, count: 1, mode: 'quiz' }, 503);

  const question = await db.question.create({ data: { userId: ids.student, subjectId: subject.id, materialId: material.id, prompt: '탈분극의 원인은?', options: ['Na 유입', 'Na 유출', 'K 유입', '물 유입', '없음'], answer: 0, explanation: 'Na 이온이 유입됩니다.', citation: text, past: '세포막', future: '막전위' } });
  const essay = await db.essay.create({ data: { userId: ids.student, subjectId: subject.id, materialId: material.id, prompt: '과정을 설명하세요.', keywords: ['자극', '통로', '유입', '탈분극'], distractors: ['항체', '호르몬', '광합성', '배설'], modelAnswer: '자극으로 통로가 열리고 나트륨 이온이 세포 안으로 유입되어 막전위가 상승하는 탈분극이 일어난다.', citation: text } });
  await call('other', 'quiz/answer', 'POST', { questionId: question.id, answer: 0 }, 404);
  check((await call('student', 'quiz/answer', 'POST', { questionId: question.id, answer: -1 })).correct === false, 'skipped answer is wrong');
  const correct = await call('student', 'quiz/answer', 'POST', { questionId: question.id, answer: 0 });
  check(correct.correct === true && correct.explanation === 'Na 이온이 유입됩니다.' && correct.citation === text, 'correct answer explained');
  await call('student', 'quiz/answer', 'POST', { questionId: question.id, answer: 5 }, 400);
  const converted = await call('student', 'wrong-notes/cards', 'POST', { questionIds: [question.id] });
  const again = await call('student', 'wrong-notes/cards', 'POST', { questionIds: [question.id] });
  check(converted[0].id === again[0].id && converted[0].sourceQuestionId === question.id && converted[0].back.startsWith('Na 유입\n\n'), 'wrong note card is idempotent');

  const card = await call('student', 'cards', 'POST', { subjectId: subject.id, front: '앞', back: '뒤', type: 'CONCEPT' }, 201);
  check(card.masks.length === 0 && card.fsrs === null && card.bucket === 'AGAIN' && card.image === undefined, `new card shape ${JSON.stringify(card)}`);
  const reviewId = randomUUID();
  const first = await call('student', 'cards/review', 'POST', { cardId: card.id, rating: 'EASY', reviewId });
  check(first.bucket === 'EASY' && first.consecutiveEasy === 1 && first.reviewCount === undefined, 'first review');
  const duplicate = await call('student', 'cards/review', 'POST', { cardId: card.id, rating: 'EASY', reviewId });
  assert.deepEqual(duplicate, first, 'same reviewId replays the stored result');
  checks++;
  await call('other', 'cards/review', 'POST', { cardId: card.id, rating: 'EASY', reviewId: randomUUID() }, 404);
  check((await api(base, 'student', 'cards/review', 'POST', { cardId: card.id, rating: 'HARD', reviewId }, 409)).error === '이미 다른 복습에 사용된 요청이에요.', 'reviewId reuse with another rating');
  const mastered = await call('student', 'cards/review', 'POST', { cardId: card.id, rating: 'EASY', reviewId: randomUUID() });
  check(mastered.bucket === 'MASTERED' && mastered.fsrs === null, 'two EASY in a row master the card');
  check((await call('student', 'bootstrap')).profile.srsMode === 'FIXED', 'default srs mode');
  await call('student', 'profile', 'PATCH', { srsMode: 'UNKNOWN' }, 400);
  await call('student', 'profile', 'PATCH', { desiredRetention: 0.79 }, 400);
  await call('student', 'profile', 'PATCH', { desiredRetention: 0.98 }, 400);
  const preferences = await call('student', 'profile', 'PATCH', { srsMode: 'FSRS', desiredRetention: 0.93 });
  check(preferences.srsMode === 'FSRS' && preferences.desiredRetention === 0.93, 'preferences answer profile');
  check((await db.user.findUniqueOrThrow({ where: { id: ids.student } })).srsMode === 'FSRS', 'preferences persisted');
  const adaptive = await call('student', 'cards', 'POST', { subjectId: subject.id, front: '적응형 앞', back: '적응형 뒤', type: 'CONCEPT' }, 201);
  const reviewedAt = Date.now() - 86400_000;
  const adaptiveReviewId = randomUUID();
  const predicted = scheduleCard(adaptive, 'EASY', 'FSRS', 0.93, reviewedAt);
  const firstAdaptive = await call('student', 'cards/review', 'POST', { cardId: adaptive.id, rating: 'EASY', reviewId: adaptiveReviewId, reviewedAt });
  assert.deepEqual(firstAdaptive.fsrs, predicted.fsrs, 'FSRS state equals the browser scheduler');
  check(firstAdaptive.nextReviewAt === predicted.nextReviewAt && firstAdaptive.fsrs.reps === 1, 'FSRS due equals the browser scheduler');
  const replay = await call('student', 'cards/review', 'POST', { cardId: adaptive.id, rating: 'EASY', reviewId: adaptiveReviewId, reviewedAt });
  assert.deepEqual(replay.fsrs, firstAdaptive.fsrs);
  await call('student', 'cards/review', 'POST', { cardId: adaptive.id, rating: 'GOOD', reviewId: randomUUID(), reviewedAt: Date.now() + 301_000 }, 400);
  await call('student', 'cards/review', 'POST', { cardId: adaptive.id, rating: 'GOOD', reviewId: randomUUID(), reviewedAt: Date.now() - 31 * 86400_000 }, 400);
  await call('student', 'cards/review', 'POST', { cardId: adaptive.id, rating: 'GOOD', reviewId: randomUUID(), reviewedAt: reviewedAt - 1 }, 409);
  const secondAt = reviewedAt + 3 * 3600_000;
  const secondPredicted = scheduleCard(firstAdaptive, 'EASY', 'FSRS', 0.93, secondAt);
  const secondAdaptive = await call('student', 'cards/review', 'POST', { cardId: adaptive.id, rating: 'EASY', reviewId: randomUUID(), reviewedAt: secondAt });
  check(secondAdaptive.bucket === 'MASTERED' && secondAdaptive.fsrs.reps === 2 && isDue(secondAdaptive, Date.parse(secondAdaptive.nextReviewAt)) && secondAdaptive.nextReviewAt === secondPredicted.nextReviewAt, 'second FSRS review');
  const legacyQueue = await call('student', 'cards/review', 'POST', { cardId: adaptive.id, rating: 'GOOD', reviewId: randomUUID() });
  check(legacyQueue.fsrs.reps === 3, 'a review without reviewedAt uses the server clock');
  assert.deepEqual((await call('student', 'bootstrap')).cards.find((item: { id: string }) => item.id === adaptive.id).fsrs, legacyQueue.fsrs);
  await call('student', 'profile', 'PATCH', { srsMode: 'FIXED' });
  const fixedAt = Date.now();
  const fixedAgain = await call('student', 'cards/review', 'POST', { cardId: adaptive.id, rating: 'HARD', reviewId: randomUUID(), reviewedAt: fixedAt });
  check(fixedAgain.fsrs === null && fixedAgain.nextReviewAt === new Date(fixedAt + 86400_000).toISOString(), 'FIXED mode after switching back');
  const eventAt = Date.now();
  const eventPrediction = scheduleCard(fixedAgain, 'EASY', 'FSRS', 0.87, eventAt);
  const eventReplay = await call('student', 'cards/review', 'POST', { cardId: adaptive.id, rating: 'EASY', reviewId: randomUUID(), reviewedAt: eventAt, mode: 'FSRS', retention: 0.87 });
  assert.deepEqual(eventReplay.fsrs, eventPrediction.fsrs);
  check(eventReplay.nextReviewAt === eventPrediction.nextReviewAt, 'explicit mode and retention per review');
  check((await call('student', 'bootstrap')).profile.srsMode === 'FIXED', 'per-review mode does not change the preference');
  await call('student', 'cards/review', 'POST', { cardId: adaptive.id, rating: 'EASY', reviewId: randomUUID(), mode: 'INVALID' }, 400);
  await call('student', 'cards/review', 'POST', { cardId: adaptive.id, rating: 'EASY', reviewId: randomUUID(), retention: 1.1 }, 400);
  await call('student', `cards/${card.id}`, 'PATCH', { deleted: true });
  await call('student', 'cards/review', 'POST', { cardId: card.id, rating: 'GOOD', reviewId: randomUUID() }, 404);
  await call('student', `cards/${card.id}`, 'PATCH', { deleted: false });
  await call('student', 'cards', 'POST', { subjectId: subject.id, front: '가림', back: '카드', type: 'BLIND' }, 400);
  await call('student', 'cards', 'POST', { subjectId: subject.id, front: '가림', back: '카드', type: 'BLIND', image: 'https://evil.example/x.png', masks: [{ x: 0, y: 0, width: 10, height: 10 }] }, 400);
  await call('student', 'cards', 'POST', { subjectId: subject.id, front: '가림', back: '카드', type: 'BLIND', image: `/api/uploads/${randomUUID()}`, masks: [{ x: 0, y: 0, width: 10, height: 10 }] }, 404);

  const grade = await call('student', 'essay/submit', 'POST', { essayId: essay.id, answer: essay.modelAnswer });
  check(grade.score === 100 && grade.method === '키워드·순서 기반 연습 채점' && grade.missing.length === 0, `rule grading of the model answer ${JSON.stringify(grade)}`);
  const schedule = await call('student', 'schedules', 'POST', { title: '고정 일정', date: '2026-09-15', start: '18:00', end: '19:30', kind: 'FIXED' }, 201);
  await call('student', 'schedules', 'POST', { title: '충돌', date: '2026-09-15', start: '18:30', end: '19:00', kind: 'FLEXIBLE' }, 409);
  await call('student', 'schedules', 'POST', { title: '잘못된 날짜', date: '2026-02-30', start: '18:30', end: '19:00', kind: 'FLEXIBLE' }, 400);
  await call('student', 'schedules', 'POST', { title: '순서', date: '2026-09-16', start: '19:00', end: '18:00', kind: 'FLEXIBLE' }, 400);
  const plans = await call('student', 'planner/suggest', 'POST', { date: '2026-09-15' });
  check(plans.plans.length === 2 && plans.method === '규칙 기반 일정 추천' && plans.dropped === undefined, 'rule planner');
  await call('student', `schedules/${schedule.id}`, 'PATCH', { done: true });
  await call('other', `schedules/${schedule.id}`, 'DELETE', undefined, 404);

  const post = await call('student', 'posts', 'POST', { title: '검증 게시글', body: '본문', category: '자유', anonymous: false }, 201);
  await call('parent', 'posts?role=STUDENT', 'GET', undefined, 403);
  await call('parent', `posts/${post.id}/comments`, 'GET', undefined, 403);
  await call('other', `posts/${post.id}/like`, 'POST', {});
  await call('student', `posts/${post.id}/save`, 'POST', {});
  const comment = await call('other', `posts/${post.id}/comments`, 'POST', { body: '댓글' }, 201);
  const reply = await call('student', `posts/${post.id}/comments`, 'POST', { body: '답글', parentId: comment.id }, 201);
  await call('student', `posts/${post.id}/comments`, 'POST', { body: '잘못된 깊이', parentId: reply.id }, 400);
  const report = await call('other', 'reports', 'POST', { postId: post.id, reason: '검증 신고' });
  await call('student', 'admin', 'GET', undefined, 403);
  await call('admin', `admin/reports/${report.id}`, 'PATCH', { status: 'RESOLVED' });
  // Following defaults to the same grade (community privacy WhoCanFollow=SAME_GRADE); fixtures start without one.
  await call('student', 'profile', 'PATCH', { grade: '고2' });
  await call('other', 'profile', 'PATCH', { grade: '고2' });
  await call('student', 'follow', 'POST', { userId: ids.other });
  await call('student', 'messages', 'POST', { userId: ids.other, body: '안녕하세요' }, 201);
  check((await call('other', `messages?userId=${ids.student}`)).length === 1, 'message delivered');
  await call('parent', 'messages', 'POST', { userId: ids.student, body: '역할 침범' }, 404);
  await call('student', 'blocks', 'POST', { userId: ids.other });
  await call('other', `posts/${post.id}/comments`, 'GET', undefined, 404);
  await call('other', 'messages', 'POST', { userId: ids.student, body: '차단 침범' }, 403);
  await call('student', `blocks/${ids.other}`, 'DELETE');

  const invite = await call('student', 'invite', 'POST', {});
  check(/^\d{6}$/.test(invite.code), 'invite code');
  for (let i = 0; i < 5; i++) await call('parent', 'link', 'POST', { code: '000000' }, i === 4 ? 429 : 400);
  await call('parent', 'link', 'POST', { code: invite.code }, 429);
  await db.user.update({ where: { id: ids.parent }, data: { linkLockedUntil: new Date(Date.now() - 1000) } });
  await call('parent', 'link', 'POST', { code: invite.code });
  await call('parent', 'link', 'POST', { code: invite.code }, 400);
  await call('student', 'profile', 'PATCH', { privacy: { accuracy: false, time: false, wrongNotes: false } });
  const hidden = await call('parent', 'bootstrap');
  check(hidden.child.id === ids.student && hidden.child.streak === 0 && hidden.stats.accuracy === 0 && hidden.stats.studyMinutes === 0 && JSON.stringify(hidden.stats.weekly) === '[]' && hidden.stats.yesterdayCards === 0, 'privacy hides stats');
  check(hidden.attempts.length === 0 && hidden.questions.length === 0 && hidden.materials.length === 0 && hidden.cards.length === 0 && hidden.schedules.length === 0 && hidden.essays.length === 0, 'privacy hides data');
  check((await call('parent', 'parent-stats')).subjectStats.length === 0, 'parent-stats hidden');
  await call('student', 'profile', 'PATCH', { privacy: { accuracy: true, time: true, wrongNotes: true } });
  const visible = await call('parent', 'bootstrap');
  check(visible.attempts.length === 3 && visible.stats.accuracy === 67 && visible.questions.length === 1 && visible.schedules.length === 1 && visible.stats.weekly.length === 7, `privacy shows data ${JSON.stringify(visible.stats)} attempts=${visible.attempts.length}`);
  check((await call('parent', 'parent-stats')).subjectStats[0].count === 2, 'parent-stats counts attempts on questions');
  await call('parent', 'cheers', 'POST', { message: '응원해', points: 1100 }, 400);
  const cheer = await call('parent', 'cheers', 'POST', { message: '응원해', points: 100 }, 201);
  await call('student', `cheers/${cheer.id}`, 'PATCH', { thanked: true });
  check((await db.user.findUniqueOrThrow({ where: { id: ids.parent } })).points === 900 && (await db.user.findUniqueOrThrow({ where: { id: ids.student } })).points === 1100, 'points moved');
  const state = await call('student', 'bootstrap');
  check(!('content' in state.materials[0]), 'bootstrap materials carry no body');
  check(state.materials[0].title === '수정한 자료' && state.materials[0].contentLength === text.length && state.materials[0].excerpt === text && typeof state.materials[0].contentHash === 'string', 'bootstrap material summary');
  check(state.cards.find((item: { id: string }) => item.id === card.id).bucket === 'MASTERED' && state.attempts.length === 3 && state.cheers.length === 1 && state.cheers[0].thanked === true && state.profile.points === 1100, 'bootstrap reflects the session');
  const etag = (await api(base, 'student', 'bootstrap')).headers.get('etag');
  const notModified = await fetch(`${base}/api/bootstrap`, { headers: { cookie: cookie.student, 'If-None-Match': etag! } });
  check(!!etag && notModified.status === 304, `bootstrap 304 on If-None-Match (${notModified.status})`);
  const children = await call('parent', 'children');
  check(children.length === 1 && children[0].selected === true, 'children list');
  await call('parent', 'children/select', 'POST', { childId: ids.other }, 404);
  await call('parent', `children/${ids.student}`, 'DELETE');
  check((await call('parent', 'bootstrap')).child === undefined, 'child unlinked');
  await call('admin', `admin/users/${ids.other}`, 'PATCH', { suspended: true });
  await call('other', 'bootstrap', 'GET', undefined, 403);
  await call('student', 'notifications', 'PATCH', { read: true });
  await call('student', `materials/${material.id}`, 'DELETE');
  check((await db.upload.count({ where: { id: upload.uploadId } })) === 0, 'deleting the material removed its upload');
  await call('student', `subjects/${subject.id}`, 'DELETE');
  check((await call('student', 'bootstrap')).subjects.length === 0, 'deleted subject gone from bootstrap');

  // ---- Phase 2: the AI harness against a fake OpenRouter ----
  await db.user.update({ where: { id: ids.other }, data: { suspended: false } }); // phase 1 suspended this account
  const providerState = { calls: 0, mode: 'ok' as 'ok' | 'hold' | 'bad-citation', release: () => {}, held: null as Promise<void> | null, onRequest: async () => {} };
  const source = '나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다. 칼륨 이온이 세포 밖으로 나가면 재분극이 일어난다.';
  const item = { prompt: '탈분극을 일으키는 이온의 이동은?', options: ['나트륨 유입', '나트륨 유출', '칼륨 유입', '칼륨 유출', '이동 없음'], answer: 0, explanation: '나트륨 이온이 세포 안으로 유입되어 탈분극이 발생해요.', citation: '나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.', past: '세포막', future: '막전위' };
  const provider = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    providerState.calls++;
    await providerState.onRequest();
    if (providerState.mode === 'hold' && providerState.held) await providerState.held;
    const name = body.tool_choice?.function?.name;
    // With AI_QUALITY_REVIEW off the model cites source text (with it on, it would cite evidence block ids).
    const citation = providerState.mode === 'bad-citation' ? '원문에 없는 전혀 다른 출처 문장이에요.' : item.citation;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'gen-1', model: 'openai/gpt-5.6-luna', provider: 'Amazon Bedrock', choices: [{ finish_reason: 'stop', message: { content: null, tool_calls: [{ function: { name, arguments: JSON.stringify({ items: [{ ...item, citation }] }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  const providerPort = await freePort();
  await new Promise<void>((r) => provider.listen(providerPort, '127.0.0.1', r));
  const work = mkdtempSync(join(tmpdir(), 'memoryz-contract-'));
  const bin = join(work, 'server');
  const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr);
  const aiPort = await freePort();
  const aiBase = `http://127.0.0.1:${aiPort}`;
  const aiServer = spawn(bin, ['serve'], {
    env: { ...process.env, DATABASE_URL: database.href, PORT: String(aiPort), HOST: '127.0.0.1', ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'warn', APP_URL: aiBase, DEMO_MODE: 'true', AUTH_SECRET: randomBytes(24).toString('hex'), OPENROUTER_API_KEY: 'synthetic-provider-key', OPENROUTER_MODEL: 'openai/gpt-5.6-luna', OPENROUTER_REASONING_EFFORT: 'high', OPENROUTER_BASE_URL: `http://127.0.0.1:${providerPort}`, AI_QUALITY_REVIEW: 'false' /* the fake model cannot act as the independent reviewer; Go tests cover it */, AI_RATE_PER_MINUTE: '100', STATIC_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let aiLog = '';
  aiServer.stdout.on('data', (d) => (aiLog += d));
  aiServer.stderr.on('data', (d) => (aiLog += d));
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      ready = await fetch(`${aiBase}/api/health`).then((r) => r.ok, () => false);
      if (!ready) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(ready, `ai server did not start: ${aiLog}`);
    useServer(aiBase); // direct database writes below must flush this server's cache, not the main one's
    const ai = (role: keyof typeof ids | null, route: string, method = 'GET', payload?: unknown, expected = 200) => api(aiBase, role, route, method, payload, expected).then((r) => r.data);
    check((await ai('student', 'bootstrap')).aiAvailable === true, 'the fake provider counts as available');
    const subject2 = await db.subject.create({ data: { userId: ids.student, name: '하네스 검증' } });
    const material2 = await db.material.create({ data: { userId: ids.student, subjectId: subject2.id, title: '합성 자료', type: 'TXT', content: source } });
    const payload = { materialId: material2.id, count: 1, mode: 'quiz' };

    // The material changes while the model is thinking: nothing is saved.
    providerState.onRequest = async () => {
      await db.material.update({ where: { id: material2.id }, data: { content: '생성 중 변경한 학습 자료의 본문입니다.' } });
    };
    check((await api(aiBase, 'student', 'generate', 'POST', { ...payload, requestId: randomUUID() }, 409)).error === '생성 중 학습 자료가 변경됐어요. 최신 자료를 확인하고 다시 시도해 주세요.', 'race is refused');
    check((await db.question.count({ where: { userId: ids.student, materialId: material2.id } })) === 0, 'nothing saved after the race');
    await db.material.update({ where: { id: material2.id }, data: { content: source } });
    providerState.onRequest = async () => {};
    providerState.calls = 0;

    // A held request: concurrent same-id calls are refused, the record shows GENERATE running.
    let started!: () => void;
    const startedPromise = new Promise<void>((r) => (started = r));
    providerState.mode = 'hold';
    providerState.held = new Promise<void>((r) => (providerState.release = r));
    providerState.onRequest = async () => started();
    const requestId = randomUUID();
    const firstRun = api(aiBase, 'student', 'generate', 'POST', { ...payload, requestId }, 201);
    await Promise.race([startedPromise, firstRun.then(() => { throw new Error('completed before the provider stage'); }), new Promise((_, reject) => setTimeout(() => reject(new Error('provider stage not reached')), 60_000))]);
    await ai('student', 'generate', 'POST', { ...payload, requestId }, 409);
    await ai('student', 'generate', 'POST', { ...payload, count: 2, requestId }, 409);
    const running = await ai('student', `ai-runs/${requestId}`);
    check(running.status === 'RUNNING' && running.steps.at(-1).stage === 'GENERATE' && running.steps.at(-1).status === 'RUNNING', `running record ${JSON.stringify(running.steps)}`);
    await ai('other', `ai-runs/${requestId}`, 'GET', undefined, 404);
    providerState.release();
    providerState.mode = 'ok';
    providerState.onRequest = async () => {};
    const created = (await firstRun).data;
    check(providerState.calls === 1 && created.length === 1 && created[0].prompt === item.prompt, 'one provider call, one item');
    const replayed = await ai('student', 'generate', 'POST', { ...payload, requestId }, 201);
    assert.deepEqual(replayed, created, 'replay returns the stored result');
    check(providerState.calls === 1 && (await db.question.count({ where: { userId: ids.student, materialId: material2.id } })) === 1, 'replay does not call the provider again');
    const saved = await ai('student', `ai-runs/${requestId}`);
    check(saved.status === 'COMPLETED' && JSON.stringify(saved.result) === JSON.stringify(created) && JSON.stringify(saved.steps.map((s: { stage: string }) => s.stage)) === '["LOAD_CONTEXT","GENERATE","VALIDATE","COMMIT"]' && saved.steps.every((s: { status: string }) => s.status === 'COMPLETED') && saved.skillVersion === '2.8.0' /* memoryz.quiz in server/internal/ai/skills.go */ && !JSON.stringify(saved).includes('synthetic-provider-key'), `saved record ${JSON.stringify(saved.steps)}`);
    check(saved.steps.every((s: { durationMs: number; finishedAt: string }) => typeof s.durationMs === 'number' && typeof s.finishedAt === 'string'), 'steps carry timings');

    providerState.mode = 'bad-citation';
    const invalidId = randomUUID();
    check((await api(aiBase, 'student', 'generate', 'POST', { ...payload, requestId: invalidId }, 422)).error === '원문에서 확인되지 않는 인용이 있어 생성 결과를 저장하지 않았어요.', 'bad citation refused');
    await ai('student', 'generate', 'POST', { ...payload, requestId: invalidId }, 422);
    // A refused first answer is asked once more with the reason (self-correction), so the failed
    // run cost two provider calls; the replay of its stored failure costs none.
    check(providerState.calls === 3 && (await db.question.count({ where: { userId: ids.student, materialId: material2.id } })) === 1, 'failed run replays without a provider call');
    check((await ai('student', `ai-runs/${invalidId}`)).status === 'FAILED', 'failed run recorded');
    providerState.mode = 'ok';

    // No key (phase-1 server): the failure is recorded once and replayed.
    const missingId = randomUUID();
    await call('student', 'generate', 'POST', { ...payload, requestId: missingId }, 503);
    await call('student', 'generate', 'POST', { ...payload, requestId: missingId }, 503);
    check((await call('student', `ai-runs/${missingId}`)).errorStatus === 503 && providerState.calls === 3, 'unconfigured provider run');

    const staleId = randomUUID();
    await db.aiRun.create({ data: { userId: ids.student, requestId: staleId, kind: 'quiz', inputHash: inputHash('quiz', payload), skillVersion: '1.0.0', model: 'openai/gpt-5.6-luna', status: 'RUNNING', updatedAt: new Date(Date.now() - 6 * 60_000) } });
    check((await ai('student', `ai-runs/${staleId}`)).status === 'INTERRUPTED', 'a run without progress for 5 minutes is interrupted');
    await ai('student', 'generate', 'POST', { ...payload, requestId: staleId }, 409);
    check(providerState.calls === 3, 'interrupted run is not retried');

    const essay2 = await db.essay.create({ data: { userId: ids.student, subjectId: subject2.id, materialId: material2.id, prompt: '탈분극 과정을 설명하세요.', keywords: ['자극', '통로', '유입', '탈분극'], distractors: ['항원', '항체', '호르몬', '광합성'], modelAnswer: '자극으로 나트륨 이온 통로가 열리고 나트륨 이온이 세포 안으로 유입되어 막전위가 상승하는 탈분극이 일어난다.', citation: item.citation } });
    const gradeId = randomUUID();
    const gradePayload = { essayId: essay2.id, answer: essay2.modelAnswer, requestId: gradeId };
    const graded = await call('student', 'essay/submit', 'POST', gradePayload);
    assert.deepEqual(await call('student', 'essay/submit', 'POST', gradePayload), graded);
    check((await db.attempt.count({ where: { userId: ids.student, essayId: essay2.id } })) === 1, 'one attempt for the replayed grade');
    await call('student', 'essay/submit', 'POST', { ...gradePayload, answer: '다른 답변' }, 409);
    const planId = randomUUID();
    const plan = await call('student', 'planner/suggest', 'POST', { date: '2026-09-15', requestId: planId });
    assert.deepEqual(await call('student', 'planner/suggest', 'POST', { date: '2026-09-15', requestId: planId }), plan);
    await call('student', 'planner/suggest', 'POST', { date: '2026-09-16', requestId: planId }, 409);
    await call('student', 'planner/suggest', 'POST', { date: '2026-09-15', requestId }, 409);
    console.log(`API_CONTRACT_OK (${checks} checks; uploads, quiz, wrong notes, FIXED/FSRS reviews against the browser scheduler, preferences, essays, schedules, planner, community, admin, links, privacy, cheers, children, suspension, deletion, AI harness: race, hold/concurrency, replay, bad citation, unconfigured, interrupted, essay/planner idempotency)`);
  } finally {
    useServer(base);
    aiServer.kill('SIGTERM');
    await new Promise((r) => aiServer.once('exit', r));
    provider.close();
    rmSync(work, { recursive: true, force: true });
  }
} finally {
  await db.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await db.$disconnect();
}
