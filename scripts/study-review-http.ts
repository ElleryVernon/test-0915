// Real HTTP checks for the study review data: exam fields on subjects and review counts on cards.
// Uses throwaway qa- accounts on the dedicated local database and removes them afterwards.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from './lib/db';
import { createSession } from './lib/session';

const base = process.env.TEST_APP_URL ?? 'http://127.0.0.1:3000';
const database = new URL(process.env.DATABASE_URL!);
assert(
  ['127.0.0.1', 'localhost'].includes(database.hostname) &&
    database.port === '15444' &&
    database.pathname === '/memoryz',
  'Refuse to mutate any database except dedicated local memoryz:15444',
);
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'HTTP test target must be loopback');
const prefix = 'qa-study-' + randomUUID();
let checks = 0;
async function call<T = any>(path: string, cookie: string, body?: unknown, method?: string, status = 200) {
  const response = await fetch(base + '/api' + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, status, `${method ?? 'GET'} ${path}: ${JSON.stringify(payload)}`);
  checks++;
  return payload.data as T;
}
const seoulPlus = (days: number) =>
  new Date(
    Date.parse(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date())}T00:00:00Z`) +
      days * 86400000,
  )
    .toISOString()
    .slice(0, 10);
try {
  const [student, other] = await Promise.all(
    ['student', 'other'].map((role) =>
      db.user.create({ data: { id: `${prefix}-${role}`, name: '검증 학생', nickname: `${prefix}-${role}`, role: 'STUDENT' } }),
    ),
  );
  const sc = (await createSession(student.id, new Request(base))).split(';')[0];
  const oc = (await createSession(other.id, new Request(base))).split(';')[0];
  const subjectOf = async (id: string) =>
    (await call<{ subjects: { id: string; name: string; examName?: string; examDate?: string }[] }>('/bootstrap', sc)).subjects.find(
      (s) => s.id === id,
    )!;

  const exam = seoulPlus(12);
  const created = await call<{ id: string }>('/subjects', sc, { name: '검증 생명과학', examName: '중간고사', examDate: exam }, 'POST', 201);
  assert.deepEqual(
    (({ examName, examDate }) => ({ examName, examDate }))(await subjectOf(created.id)),
    { examName: '중간고사', examDate: exam },
  );
  await call(`/subjects/${created.id}`, sc, { examDate: seoulPlus(20) }, 'PATCH');
  assert.equal((await subjectOf(created.id)).examName, '중간고사', 'a date-only change keeps the exam name');
  assert.equal((await subjectOf(created.id)).examDate, seoulPlus(20));
  await call(`/subjects/${created.id}`, sc, { name: '검증 생명과학I' }, 'PATCH');
  assert.equal((await subjectOf(created.id)).examDate, seoulPlus(20), 'renaming keeps the exam');
  await call(`/subjects/${created.id}`, sc, { examName: '' }, 'PATCH');
  assert.equal((await subjectOf(created.id)).examName, '시험', 'an empty name reads as "시험"');
  await call(`/subjects/${created.id}`, sc, { examDate: '2026-02-30' }, 'PATCH', 400);
  await call(`/subjects/${created.id}`, sc, { examDate: '2026/10/01' }, 'PATCH', 400);
  await call(`/subjects/${created.id}`, sc, { examName: 'x'.repeat(21) }, 'PATCH', 400);
  await call(`/subjects/${created.id}`, sc, {}, 'PATCH', 400);
  await call(`/subjects/${created.id}`, oc, { examDate: exam }, 'PATCH', 404);
  assert.equal((await subjectOf(created.id)).examDate, seoulPlus(20), 'another account cannot change it');
  await call(`/subjects/${created.id}`, sc, { examDate: null }, 'PATCH');
  const cleared = await subjectOf(created.id);
  assert.equal(cleared.examDate, undefined);
  assert.equal(cleared.examName, undefined);
  const plain = await call<{ id: string }>('/subjects', sc, { name: '시험 없는 과목' }, 'POST', 201);
  assert.equal((await subjectOf(plain.id)).examDate, undefined);

  const card = await call<{ id: string }>(
    '/cards',
    sc,
    { subjectId: created.id, front: '삼투의 조건은?', back: '선택적 투과성 막과 농도 차이', type: 'CONCEPT' },
    'POST',
    201,
  );
  const reviewCount = async () =>
    (await call<{ cards: { id: string; reviewCount?: number }[] }>('/bootstrap', sc)).cards.find((c) => c.id === card.id)!
      .reviewCount;
  assert.equal(await reviewCount(), 0);
  const reviewed = await call<{ reviewCount?: number }>('/cards/review', sc, { cardId: card.id, rating: 'AGAIN', reviewId: randomUUID() });
  assert.equal(reviewed.reviewCount, undefined, 'review responses carry no count; the client counts locally');
  assert.equal(await reviewCount(), 1);
  console.log(`STUDY_REVIEW_HTTP_OK (${checks} HTTP checks; exam create/patch/clear/validation/ownership, review count)`);
} finally {
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  const left = await db.user.count({ where: { id: { startsWith: prefix } } });
  if (left) throw new Error(`cleanup left ${left} qa users`);
  await db.$disconnect();
}
