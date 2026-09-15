// HTTP contract of the account and parent endpoints (leaf-1.5.2) against the Go server:
// PATCH /api/profile, POST /api/invite, POST /api/link, /api/children, GET /api/parent-stats,
// /api/cheers and PATCH /api/notifications. Statuses, Korean messages and shapes are the ones the
// previous TypeScript server answered; the database is read back after every write and /api/me
// proves the cached user snapshot is dropped by each write. Accounts are created with Prisma
// under a qa-parent-<uuid> prefix and deleted at the end.
// Usage: node server/scripts/serve.mjs "npx tsx scripts/api-contract-parent.ts"
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

const prefix = 'qa-parent-' + randomUUID();
// Nicknames are at most 30 characters, so the ones the profile tests send are shorter than the prefix.
const short = 'qa-' + randomUUID().slice(0, 8);
let checks = 0;

type Payload = { data?: unknown; error?: string };
async function request(path: string, body?: unknown, method?: string, cookie?: string) {
  const response = await fetch(base + '/api' + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as Payload };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(path: string, body?: unknown, method?: string, cookie?: string, status = 200): Promise<any> {
  const { status: got, payload } = await request(path, body, method, cookie);
  assert.equal(got, status, `${method ?? (body === undefined ? 'GET' : 'POST')} ${path}: ${JSON.stringify(payload)}`);
  checks++;
  return payload.data;
}
// refuse asserts a failure with the exact message of the contract.
async function refuse(path: string, body: unknown, method: string | undefined, cookie: string | undefined, status: number, message: string) {
  const { status: got, payload } = await request(path, body, method, cookie);
  assert.equal(got, status, `${path}: ${JSON.stringify(payload)}`);
  assert.equal(payload.error, message, `${path}: message`);
  assert.equal(payload.data, undefined, `${path}: no data on failure`);
  checks++;
}
const MSG_INPUT = '입력값을 확인해 주세요.';
const MSG_REQUIRED = '내용을 입력해 주세요.';
const MSG_ROLE = '이 계정으로 접근할 수 없는 기능이에요.';
const MSG_BAD_CODE = '유효하지 않거나 만료된 코드예요.';
const MSG_LOCKED = '5회 확인에 실패했어요. 30분 후 다시 시도해 주세요.';
const profileKeys = ['completedSubjects', 'desiredRetention', 'grade', 'id', 'name', 'nickname', 'points', 'privacy', 'role', 'school', 'srsMode', 'streak'];
const isoShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const keysOf = (value: object) => Object.keys(value).sort();
const seoulDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(date);
// The week starts Monday 00:00 in Korea; the arithmetic is the previous server's, verbatim.
function weekStartOf(now: Date) {
  const kstDate = new Date(now.getTime() + 9 * 3600_000);
  const weekday = kstDate.getUTCDay();
  return new Date(Date.UTC(kstDate.getUTCFullYear(), kstDate.getUTCMonth(), kstDate.getUTCDate() - (weekday + 6) % 7) - 9 * 3600_000);
}
const user = (id: string) => db.user.findUniqueOrThrow({ where: { id } });

try {
  const student = await db.user.create({ data: { id: prefix + '-student', name: '검증 학생', nickname: prefix + '-student', role: 'STUDENT' } });
  const student2 = await db.user.create({ data: { id: prefix + '-student2', name: '둘째 학생', nickname: prefix + '-student2', role: 'STUDENT' } });
  const student3 = await db.user.create({ data: { id: prefix + '-student3', name: '정지될 학생', nickname: prefix + '-student3', role: 'STUDENT' } });
  const student4 = await db.user.create({ data: { id: prefix + '-student4', name: '캐시 검증 학생', nickname: prefix + '-student4', role: 'STUDENT' } });
  const parent = await db.user.create({ data: { id: prefix + '-parent', name: '검증 학부모', nickname: prefix + '-parent', role: 'PARENT', points: 500 } });
  const parent2 = await db.user.create({ data: { id: prefix + '-parent2', name: '자녀 없는 학부모', nickname: short + '-taken', role: 'PARENT', points: 100 } });
  const session = async (id: string) => (await createSession(id, new Request(base))).split(';')[0];
  const sc = await session(student.id);
  const s2c = await session(student2.id);
  const s3c = await session(student3.id);
  const s4c = await session(student4.id);
  const pc = await session(parent.id);
  const p2c = await session(parent2.id);

  // --- sign-in and role boundaries ---
  await refuse('/profile', { name: '익명' }, 'PATCH', undefined, 401, '로그인이 필요해요.');
  await refuse('/invite', {}, undefined, pc, 403, MSG_ROLE);
  await refuse('/link', { code: '123456' }, undefined, sc, 403, MSG_ROLE);
  await refuse('/children', undefined, undefined, sc, 403, MSG_ROLE);
  await refuse('/children/select', { childId: student2.id }, undefined, sc, 403, MSG_ROLE);
  await refuse('/parent-stats', undefined, undefined, sc, 403, MSG_ROLE);
  await refuse('/cheers', { message: '응원', points: 1 }, undefined, sc, 403, MSG_ROLE);
  await refuse('/cheers/none', { thanked: true }, 'PATCH', pc, 403, MSG_ROLE);

  // --- PATCH /api/profile: each field, its validation, the profile shape, the 409 ---
  const renamed = await call('/profile', { name: '  검증 이름  ' }, 'PATCH', sc);
  assert.deepEqual(keysOf(renamed), profileKeys, 'the answer is the profile');
  assert.equal(renamed.id, student.id);
  assert.equal(renamed.name, '검증 이름', 'name is trimmed');
  assert.equal(renamed.role, 'STUDENT');
  await refuse('/profile', { nickname: parent2.nickname }, 'PATCH', sc, 409, '이미 사용 중인 값이에요.');
  const nickname = short + '-nick';
  assert.equal((await call('/profile', { nickname: ' ' + nickname + ' ' }, 'PATCH', sc)).nickname, nickname, 'nickname is trimmed');
  const schooled = await call('/profile', { school: '  서울고등학교  ', grade: '고2' }, 'PATCH', sc);
  assert.equal(schooled.school, '  서울고등학교  ', 'school is stored as sent');
  assert.equal(schooled.grade, '고2');
  assert.equal((await call('/profile', { grade: '' }, 'PATCH', sc)).grade, '', 'the empty grade clears it');
  for (const grade of ['고1', '고3', 'N수/기타', '기타']) assert.equal((await call('/profile', { grade }, 'PATCH', sc)).grade, grade);
  await refuse('/profile', { grade: '중1' }, 'PATCH', sc, 400, MSG_INPUT);
  await refuse('/profile', { name: '   ' }, 'PATCH', sc, 400, MSG_REQUIRED);
  await refuse('/profile', { name: '가'.repeat(51) }, 'PATCH', sc, 400, MSG_INPUT);
  assert.equal((await call('/profile', { name: '가'.repeat(50) }, 'PATCH', sc)).name, '가'.repeat(50), '50 characters fit');
  await refuse('/profile', { nickname: '' }, 'PATCH', sc, 400, MSG_REQUIRED);
  await refuse('/profile', { nickname: 'n'.repeat(31) }, 'PATCH', sc, 400, MSG_INPUT);
  await refuse('/profile', { school: 's'.repeat(101) }, 'PATCH', sc, 400, MSG_INPUT);
  await refuse('/profile', { name: null }, 'PATCH', sc, 400, MSG_INPUT);
  await refuse('/profile', { privacy: { accuracy: false, time: true } }, 'PATCH', sc, 400, MSG_INPUT);
  await call('/profile', { privacy: { accuracy: 'yes', time: true, wrongNotes: false } }, 'PATCH', sc, 400);
  const privacy = { accuracy: false, time: false, wrongNotes: true };
  assert.deepEqual((await call('/profile', { privacy }, 'PATCH', sc)).privacy, privacy);
  assert.deepEqual((await call('/profile', { completedSubjects: ['  수학 ', '영어'] }, 'PATCH', sc)).completedSubjects, ['수학', '영어'], 'entries are trimmed');
  await refuse('/profile', { completedSubjects: [''] }, 'PATCH', sc, 400, MSG_REQUIRED);
  await refuse('/profile', { completedSubjects: ['과'.repeat(61)] }, 'PATCH', sc, 400, MSG_INPUT);
  await refuse('/profile', { completedSubjects: Array.from({ length: 101 }, (_, i) => '과목' + i) }, 'PATCH', sc, 400, MSG_INPUT);
  const tuned = await call('/profile', { srsMode: 'FSRS', desiredRetention: 0.85 }, 'PATCH', sc);
  assert.equal(tuned.srsMode, 'FSRS');
  assert.equal(tuned.desiredRetention, 0.85);
  await refuse('/profile', { srsMode: 'AUTO' }, 'PATCH', sc, 400, MSG_INPUT);
  await refuse('/profile', { desiredRetention: 0.5 }, 'PATCH', sc, 400, MSG_INPUT);
  await refuse('/profile', { desiredRetention: 0.98 }, 'PATCH', sc, 400, MSG_INPUT);
  assert.equal((await call('/profile', { desiredRetention: 0.8 }, 'PATCH', sc)).desiredRetention, 0.8);
  assert.equal((await call('/profile', { desiredRetention: 0.97 }, 'PATCH', sc)).desiredRetention, 0.97);
  assert.deepEqual((await call('/profile', { completedSubjects: [] }, 'PATCH', sc)).completedSubjects, [], 'an empty list clears it');
  const untouched = await call('/profile', {}, 'PATCH', sc);
  assert.equal(untouched.name, '가'.repeat(50), 'an empty body changes nothing');
  const stored = await user(student.id);
  assert.equal(stored.name, '가'.repeat(50));
  assert.equal(stored.nickname, nickname);
  assert.equal(stored.school, '  서울고등학교  ');
  assert.equal(stored.grade, '기타');
  assert.deepEqual(stored.privacy, privacy, 'privacy is stored as the three flags');
  assert.deepEqual(stored.completedSubjects, []);
  assert.equal(stored.srsMode, 'FSRS');
  assert.equal(stored.desiredRetention, 0.97);
  const me = await call('/me', undefined, undefined, sc);
  assert.deepEqual(keysOf(me), profileKeys);
  assert.equal(me.nickname, nickname, '/api/me sees the new nickname at once');
  assert.deepEqual(me.privacy, privacy);
  assert.equal(me.srsMode, 'FSRS');
  assert.equal(me.desiredRetention, 0.97);
  await call('/profile', { name: '검증 학생' }, 'PATCH', sc);

  // --- POST /api/invite: six digits, ten minutes, a new code voids the old one ---
  const invite1 = await call('/invite', {}, undefined, sc);
  assert.deepEqual(keysOf(invite1), ['code', 'expiresAt']);
  assert.match(invite1.code, /^[1-9]\d{5}$/);
  assert.match(invite1.expiresAt, isoShape);
  const lifetime = Date.parse(invite1.expiresAt) - Date.now();
  assert(lifetime > 9 * 60_000 && lifetime <= 10 * 60_000 + 2000, `expires in ten minutes, not ${lifetime}ms`);
  const inviteRow = await db.invite.findUniqueOrThrow({ where: { code: invite1.code } });
  assert.equal(inviteRow.studentId, student.id);
  assert.equal(inviteRow.expiresAt.toISOString(), invite1.expiresAt, 'the stored expiry is the one answered (UTC)');
  const invite2 = await call('/invite', {}, undefined, sc);
  assert.notEqual(invite2.code, invite1.code);
  assert.equal(await db.invite.findUnique({ where: { code: invite1.code } }), null, 'reissuing voids the earlier code');
  assert.equal((await db.invite.findUniqueOrThrow({ where: { code: invite2.code } })).studentId, student.id);
  const expiredInvite = await call('/invite', {}, undefined, s2c);
  await db.invite.update({ where: { code: expiredInvite.code }, data: { expiresAt: new Date(Date.now() - 1000) } });

  // --- POST /api/link: shape, five failures lock, the lock refuses a good code, unlock, success, reuse ---
  await refuse('/link', { code: '12345' }, undefined, pc, 400, '6자리 숫자를 입력해 주세요.');
  await refuse('/link', { code: 'abcdef' }, undefined, pc, 400, '6자리 숫자를 입력해 주세요.');
  await refuse('/link', { code: '1234567' }, undefined, pc, 400, '6자리 숫자를 입력해 주세요.');
  await refuse('/link', { code: invite1.code }, undefined, pc, 400, MSG_BAD_CODE); // voided by reissue
  await refuse('/link', { code: expiredInvite.code }, undefined, pc, 400, MSG_BAD_CODE); // expired
  await refuse('/link', { code: '000003' }, undefined, pc, 400, MSG_BAD_CODE);
  await refuse('/link', { code: '000004' }, undefined, pc, 400, MSG_BAD_CODE);
  assert.equal((await user(parent.id)).linkFailures, 4);
  await refuse('/link', { code: '000005' }, undefined, pc, 429, MSG_LOCKED);
  const lockedParent = await user(parent.id);
  assert.equal(lockedParent.linkFailures, 5);
  const lockLeft = lockedParent.linkLockedUntil!.getTime() - Date.now();
  assert(lockLeft > 29 * 60_000 && lockLeft <= 30 * 60_000 + 2000, `locked for thirty minutes, not ${lockLeft}ms`);
  await refuse('/link', { code: invite2.code }, undefined, pc, 429, MSG_LOCKED); // a good code while locked
  await refuse('/link', { code: '000006' }, undefined, pc, 429, MSG_LOCKED);
  assert.equal((await user(parent.id)).linkFailures, 5, 'a locked parent is not counted further');
  assert.equal(await db.invite.findUnique({ where: { code: invite2.code } }).then((row) => row?.studentId), student.id, 'the good code survives the locked attempt');
  await db.user.update({ where: { id: parent.id }, data: { linkLockedUntil: new Date(Date.now() - 60_000) } });
  // A suspended student's code is refused like an unknown one, and the count restarts after a lock.
  const suspendedInvite = await call('/invite', {}, undefined, s3c);
  await db.user.update({ where: { id: student3.id }, data: { suspended: true } });
  await refuse('/link', { code: suspendedInvite.code }, undefined, pc, 400, MSG_BAD_CODE);
  const restarted = await user(parent.id);
  assert.equal(restarted.linkFailures, 1);
  assert.equal(restarted.linkLockedUntil, null);
  const linked = await call('/link', { code: invite2.code }, undefined, pc);
  assert.deepEqual(keysOf(linked), ['child']);
  assert.deepEqual(keysOf(linked.child), profileKeys);
  assert.equal(linked.child.id, student.id);
  assert.equal(linked.child.nickname, nickname);
  const linkedParent = await user(parent.id);
  assert.equal(linkedParent.selectedChildId, student.id);
  assert.equal(linkedParent.linkFailures, 0);
  assert.equal(linkedParent.linkLockedUntil, null);
  assert.notEqual(await db.parentLink.findUnique({ where: { parentId_studentId: { parentId: parent.id, studentId: student.id } } }), null);
  assert.equal(await db.invite.findUnique({ where: { code: invite2.code } }), null, 'the code is consumed');
  await refuse('/link', { code: invite2.code }, undefined, pc, 400, MSG_BAD_CODE); // reuse
  assert.equal((await user(parent.id)).linkFailures, 1);
  await call('/link', { code: (await call('/invite', {}, undefined, sc)).code }, undefined, pc); // linking again is idempotent
  assert.equal(await db.parentLink.count({ where: { parentId: parent.id } }), 1);

  // --- /api/children: list with the selection, select, delete ---
  const children1 = await call('/children', undefined, undefined, pc);
  assert.equal(children1.length, 1);
  assert.deepEqual(keysOf(children1[0]), [...profileKeys, 'selected'].sort());
  assert.equal(children1[0].id, student.id);
  assert.equal(children1[0].selected, true);
  await refuse('/children/select', { childId: 'nope' }, undefined, pc, 404, '연결된 자녀를 찾을 수 없어요.');
  await refuse('/children/select', { childId: student.id }, undefined, p2c, 404, '연결된 자녀를 찾을 수 없어요.');
  await refuse('/children/select', { childId: '' }, undefined, pc, 400, MSG_INPUT);
  await call('/link', { code: (await call('/invite', {}, undefined, s2c)).code }, undefined, pc);
  const children2 = await call('/children', undefined, undefined, pc);
  assert.deepEqual(children2.map((c: { id: string; selected: boolean }) => [c.id, c.selected]), [[student.id, false], [student2.id, true]], 'the newest link is selected, oldest link first');
  assert.deepEqual(await call('/children/select', { childId: student.id }, undefined, pc), { selected: true });
  assert.equal((await user(parent.id)).selectedChildId, student.id);
  assert.deepEqual((await call('/children', undefined, undefined, pc)).map((c: { selected: boolean }) => c.selected), [true, false], 'the selection is visible at once');
  assert.deepEqual(await call('/children/' + student2.id, undefined, 'DELETE', pc), { deleted: true });
  assert.equal(await db.parentLink.findUnique({ where: { parentId_studentId: { parentId: parent.id, studentId: student2.id } } }), null);
  assert.equal((await user(parent.id)).selectedChildId, student.id, 'deleting another child keeps the selection');
  assert.deepEqual((await call('/children', undefined, undefined, pc)).map((c: { id: string; selected: boolean }) => [c.id, c.selected]), [[student.id, true]]);
  assert.deepEqual(await call('/children/' + student.id, undefined, 'DELETE', pc), { deleted: true });
  assert.equal((await user(parent.id)).selectedChildId, null, 'deleting the selected child clears the selection');
  assert.deepEqual(await call('/children', undefined, undefined, pc), []);
  assert.deepEqual(await call('/children/nope', undefined, 'DELETE', pc), { deleted: true });
  const emptyStats = { subjectStats: [], masteredCards: 0, weeklyQuestions: 0, studyDays: 0 };
  assert.deepEqual(await call('/parent-stats', undefined, undefined, pc), emptyStats, 'no child, empty stats');
  await call('/link', { code: (await call('/invite', {}, undefined, sc)).code }, undefined, pc);
  await call('/link', { code: (await call('/invite', {}, undefined, s2c)).code }, undefined, pc);
  await call('/children/' + student2.id, undefined, 'DELETE', pc);
  assert.equal((await user(parent.id)).selectedChildId, null);
  assert.deepEqual((await call('/children', undefined, undefined, pc)).map((c: { id: string; selected: boolean }) => [c.id, c.selected]), [[student.id, true]], 'without a choice the first link counts as selected');

  // --- GET /api/parent-stats: this week in Korea, privacy rules ---
  const now = new Date();
  const weekStart = weekStartOf(now);
  const earlyThisWeek = new Date(weekStart.getTime() + 3600_000);
  const lastWeek = new Date(weekStart.getTime() - 3600_000);
  const subjectA = await db.subject.create({ data: { userId: student.id, name: '검증 생물', createdAt: new Date(now.getTime() - 2000) } });
  const subjectB = await db.subject.create({ data: { userId: student.id, name: '검증 화학', createdAt: new Date(now.getTime() - 1000) } });
  const subjectGone = await db.subject.create({ data: { userId: student.id, name: '삭제된 과목', deleted: true } });
  const materialA = await db.material.create({ data: { userId: student.id, subjectId: subjectA.id, title: '세포', content: '세포 호흡은 ATP를 만든다.', type: 'TXT' } });
  const materialGone = await db.material.create({ data: { userId: student.id, subjectId: subjectGone.id, title: '옛 자료', content: '삭제된 과목의 자료.', type: 'TXT' } });
  const questionData = (subjectId: string, materialId: string) => ({ userId: student.id, subjectId, materialId, prompt: 'ATP를 만드는 과정은?', options: ['광합성', '세포 호흡', '확산', '삼투', '복제'], answer: 1, explanation: '포도당의 에너지가 ATP로 전환됩니다.', citation: '세포 호흡은 ATP를 만든다.', past: '포도당', future: '전자 전달계' });
  const questionA = await db.question.create({ data: questionData(subjectA.id, materialA.id) });
  const questionGone = await db.question.create({ data: questionData(subjectGone.id, materialGone.id) });
  const attempt = (userId: string, questionId: string | null, correct: boolean, createdAt: Date) =>
    db.attempt.create({ data: { userId, questionId, answer: correct ? '1' : '0', correct, score: correct ? 100 : 0, createdAt } });
  await attempt(student.id, questionA.id, true, now);
  await attempt(student.id, questionA.id, true, now);
  await attempt(student.id, questionA.id, false, now);
  await attempt(student.id, questionGone.id, true, now); // counts as a question this week, not as a live subject
  await attempt(student.id, questionGone.id, true, lastWeek); // last week
  await attempt(student.id, null, true, now); // an essay attempt is not a question
  await attempt(student2.id, questionA.id, true, now); // someone else's attempt on the same question
  const card = (subjectId: string, bucket: 'MASTERED' | 'GOOD', deleted = false) =>
    db.card.create({ data: { userId: student.id, subjectId, front: '앞', back: '뒤', bucket, deleted } });
  const mastered = await card(subjectA.id, 'MASTERED');
  await card(subjectA.id, 'MASTERED', true);
  await card(subjectGone.id, 'MASTERED');
  await card(subjectB.id, 'GOOD');
  const review = (createdAt: Date) => db.cardReview.create({ data: { id: randomUUID(), userId: student.id, cardId: mastered.id, rating: 'GOOD', result: {}, createdAt } });
  await review(now);
  await review(earlyThisWeek);
  await review(lastWeek);
  const expectedStudyDays = new Set([now, earlyThisWeek].map(seoulDay)).size;
  await call('/profile', { privacy: { accuracy: false, time: false, wrongNotes: false } }, 'PATCH', sc);
  assert.deepEqual(await call('/parent-stats', undefined, undefined, pc), { subjectStats: [], masteredCards: 1, weeklyQuestions: 4, studyDays: 0 }, 'accuracy and time hidden');
  await call('/profile', { privacy: { accuracy: false, time: true, wrongNotes: false } }, 'PATCH', sc);
  assert.deepEqual(await call('/parent-stats', undefined, undefined, pc), { subjectStats: [], masteredCards: 1, weeklyQuestions: 4, studyDays: expectedStudyDays }, 'time shown, accuracy hidden');
  await call('/profile', { privacy: { accuracy: true, time: true, wrongNotes: false } }, 'PATCH', sc);
  const fullStats = await call('/parent-stats', undefined, undefined, pc);
  assert.deepEqual(fullStats, {
    subjectStats: [
      { id: subjectA.id, name: '검증 생물', count: 3, accuracy: 67 },
      { id: subjectB.id, name: '검증 화학', count: 0, accuracy: 0 },
    ],
    masteredCards: 1,
    weeklyQuestions: 4,
    studyDays: expectedStudyDays,
  }, 'per-subject count and rounded accuracy of the child\'s own attempts');
  await call('/profile', { privacy: { accuracy: true, time: false, wrongNotes: false } }, 'PATCH', sc);
  assert.equal((await call('/parent-stats', undefined, undefined, pc)).studyDays, 0, 'time hidden zeroes study days only');
  assert.equal((await call('/parent-stats', undefined, undefined, pc)).subjectStats.length, 2);

  // --- /api/cheers: points move inside one transaction, a notification lands, thanks ---
  await refuse('/cheers', { message: '응원', points: 10 }, undefined, p2c, 400, '먼저 자녀를 연결해 주세요.');
  await refuse('/cheers', { message: '   ', points: 10 }, undefined, pc, 400, MSG_REQUIRED);
  await refuse('/cheers', { message: '응원' }, undefined, pc, 400, MSG_INPUT);
  await refuse('/cheers', { message: '응원', points: 10001 }, undefined, pc, 400, MSG_INPUT);
  await refuse('/cheers', { message: '응원', points: 1.5 }, undefined, pc, 400, MSG_INPUT);
  await refuse('/cheers', { message: '응원', points: -1 }, undefined, pc, 400, MSG_INPUT);
  await refuse('/cheers', { message: '응'.repeat(501), points: 1 }, undefined, pc, 400, MSG_INPUT);
  await refuse('/cheers', { message: '힘내', points: 600 }, undefined, pc, 400, '보유 포인트가 부족해요.');
  assert.equal((await user(parent.id)).points, 500, 'a refused cheer moves nothing');
  assert.equal(await db.cheer.count({ where: { senderId: parent.id } }), 0);
  assert.equal(await db.notification.count({ where: { userId: student.id } }), 0);
  assert.equal((await call('/me', undefined, undefined, sc)).points, 0, 'the child is cached before the cheer');
  const before = Date.now();
  const cheer = await call('/cheers', { message: '  차근차근 잘하고 있어요  ', points: 50 }, undefined, pc, 201);
  assert.deepEqual(keysOf(cheer), ['createdAt', 'id', 'message', 'points', 'recipientId', 'senderId', 'thanked'], 'the whole Cheer row');
  assert.equal(cheer.senderId, parent.id);
  assert.equal(cheer.recipientId, student.id);
  assert.equal(cheer.message, '차근차근 잘하고 있어요');
  assert.equal(cheer.points, 50);
  assert.equal(cheer.thanked, false);
  assert.match(cheer.createdAt, isoShape);
  assert(Math.abs(Date.parse(cheer.createdAt) - before) < 60_000, 'createdAt is the current UTC instant');
  assert.equal((await user(parent.id)).points, 450, 'the parent paid');
  assert.equal((await user(student.id)).points, 50, 'the child received');
  const cheerRow = await db.cheer.findUniqueOrThrow({ where: { id: cheer.id } });
  assert.equal(cheerRow.createdAt.toISOString(), cheer.createdAt);
  assert.equal(cheerRow.points, 50);
  const notification = await db.notification.findFirstOrThrow({ where: { userId: student.id } });
  assert.equal(notification.title, '응원이 도착했어요 🧡');
  assert.equal(notification.body, '차근차근 잘하고 있어요');
  assert.equal(notification.href, '/cheer');
  assert.equal(notification.read, false);
  assert.equal((await call('/me', undefined, undefined, pc)).points, 450, '/api/me shows the parent\'s new points at once');
  assert.equal((await call('/me', undefined, undefined, sc)).points, 50, '/api/me shows the child\'s new points at once');
  const free = await call('/cheers', { message: '고마워', points: 0 }, undefined, pc, 201);
  assert.equal(free.points, 0);
  assert.equal((await user(parent.id)).points, 450);
  assert.equal((await user(student.id)).points, 50);
  await refuse('/cheers/' + cheer.id, { thanked: true }, 'PATCH', s2c, 404, '응원을 찾을 수 없어요.');
  await refuse('/cheers/nope', { thanked: true }, 'PATCH', sc, 404, '응원을 찾을 수 없어요.');
  await refuse('/cheers/' + cheer.id, { thanked: false }, 'PATCH', sc, 400, MSG_INPUT);
  await refuse('/cheers/' + cheer.id, {}, 'PATCH', sc, 400, MSG_INPUT);
  assert.equal((await db.cheer.findUniqueOrThrow({ where: { id: cheer.id } })).thanked, false, 'refusals change nothing');
  assert.deepEqual(await call('/cheers/' + cheer.id, { thanked: true }, 'PATCH', sc), { thanked: true });
  assert.equal((await db.cheer.findUniqueOrThrow({ where: { id: cheer.id } })).thanked, true);
  assert.deepEqual(await call('/cheers/' + cheer.id, { thanked: true }, 'PATCH', sc), { thanked: true }, 'thanking twice is fine');

  // --- PATCH /api/notifications: all of the caller's, nobody else's ---
  await db.notification.create({ data: { userId: student2.id, title: '다른 알림', body: '그대로', href: '/' } });
  await refuse('/notifications', { read: false }, 'PATCH', sc, 400, MSG_INPUT);
  await refuse('/notifications', {}, 'PATCH', sc, 400, MSG_INPUT);
  assert.equal(await db.notification.count({ where: { userId: student.id, read: false } }), 2);
  assert.deepEqual(await call('/notifications', { read: true }, 'PATCH', sc), { read: true });
  assert.equal(await db.notification.count({ where: { userId: student.id, read: false } }), 0);
  assert.equal(await db.notification.count({ where: { userId: student.id, read: true } }), 2);
  assert.equal(await db.notification.count({ where: { userId: student2.id, read: false } }), 1, 'another account\'s notification stays unread');

  // --- cache invalidation of the child: a suspension and points land in /api/me right after a cheer ---
  await call('/link', { code: (await call('/invite', {}, undefined, s4c)).code }, undefined, pc);
  assert.equal((await call('/me', undefined, undefined, s4c)).points, 0, 'the child is signed in and cached');
  await db.user.update({ where: { id: student4.id }, data: { suspended: true } });
  await call('/cheers', { message: '마지막 응원', points: 25 }, undefined, pc, 201);
  assert.equal((await user(student4.id)).points, 25);
  assert.equal((await user(parent.id)).points, 425);
  await refuse('/me', undefined, undefined, s4c, 403, '이용이 제한된 계정이에요.');
  assert.equal((await call('/me', undefined, undefined, pc)).points, 425);

  console.log(
    `API_CONTRACT_PARENT_OK (${checks} checks; profile fields+validation+409, invite reissue, link lockout 400×4→429/locked good code→429/unlock/suspended/expired/reuse, children list+select+delete, parent-stats privacy+week, cheers points+notification+thanked, notifications read, /api/me cache invalidation)`,
  );
} finally {
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.$disconnect();
}
