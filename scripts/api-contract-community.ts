// HTTP contract check for the community, social and admin endpoints (leaf-1.5.1), run against the
// Go server: node server/scripts/serve.mjs "npx tsx scripts/api-contract-community.ts".
// Accounts and sessions are created with Prisma under one qa-community-<uuid> prefix and removed
// at the end; every status and, where the contract has one, every Korean message is asserted.
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

const prefix = 'qa-community-' + randomUUID();
let checks = 0;

const MSG = {
  login: '로그인이 필요해요.',
  role: '이 계정으로 접근할 수 없는 기능이에요.',
  route: '요청한 기능을 찾을 수 없어요.',
  otherBoard: '다른 역할의 커뮤니티에 접근할 수 없어요.',
  postMissing: '게시글을 찾을 수 없어요.',
  commentMissing: '댓글을 찾을 수 없어요.',
  followRole: '학생 프로필에서 팔로우할 수 있어요.',
  userMissing: '사용자를 찾을 수 없어요.',
  blocked: '차단된 사용자와 소통할 수 없어요.',
  replyDepth: '댓글은 한 단계까지만 답글을 달 수 있어요.',
  selfSuspend: '자신의 계정은 제한할 수 없어요.',
  suspended: '이용이 제한된 계정이에요.',
  missing: '대상을 찾을 수 없어요.',
  duplicate: '이미 사용 중인 값이에요.',
  required: '내용을 입력해 주세요.',
  input: '입력값을 확인해 주세요.',
  badJson: '요청 내용을 읽을 수 없어요.',
};
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// call sends one request and asserts its status (and the error message when given).
async function call(path: string, body?: unknown, method?: string, cookie?: string, status = 200, message?: string) {
  const response = await fetch(base + '/api' + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, status, `${method ?? (body === undefined ? 'GET' : 'POST')} ${path}: ${JSON.stringify(payload)}`);
  if (message !== undefined) assert.equal(payload.error, message, `${path}: message`);
  checks++;
  return payload.data;
}
function keysOf(value: unknown) {
  return Object.keys(value as object).sort();
}
function expectKeys(value: unknown, keys: string[], label: string) {
  assert.deepEqual(keysOf(value), [...keys].sort(), `${label}: keys ${JSON.stringify(value)}`);
  checks++;
}
function nonIncreasing(items: { createdAt: string }[]) {
  return items.every((item, index) => index === 0 || items[index - 1].createdAt >= item.createdAt);
}
function nonDecreasing(items: { createdAt: string }[]) {
  return items.every((item, index) => index === 0 || items[index - 1].createdAt <= item.createdAt);
}
const ids = (items: { id: string }[]) => items.map((item) => item.id);
const future = (days: number, index: number) => new Date(Date.now() + days * 86_400_000 + index * 1000);
// plain strips Prisma result prototypes so deepEqual compares values only.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
// tick separates two writes whose createdAt order an assertion relies on (TIMESTAMP(3) resolution).
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

try {
  const mkUser = (suffix: string, role: 'STUDENT' | 'PARENT' | 'ADMIN', name: string) =>
    // Students share a grade: following defaults to the same grade (community privacy WhoCanFollow=SAME_GRADE).
    db.user.create({ data: { id: `${prefix}-${suffix}`, name, nickname: `${prefix}-${suffix}`, role, grade: role === 'STUDENT' ? '고2' : '' } });
  const student = await mkUser('student', 'STUDENT', '검증 학생');
  const other = await mkUser('other', 'STUDENT', '다른 학생');
  const third = await mkUser('third', 'STUDENT', '셋째 학생');
  const parent = await mkUser('parent', 'PARENT', '검증 학부모');
  const admin = await mkUser('admin', 'ADMIN', '검증 관리자');
  const session = async (id: string) => (await createSession(id, new Request(base))).split(';')[0];
  const sc = await session(student.id);
  const oc = await session(other.id);
  const tc = await session(third.id);
  const pc = await session(parent.id);
  const ac = await session(admin.id);

  // --- sessions and role gates -----------------------------------------------------------------
  await call('/posts', undefined, undefined, undefined, 401, MSG.login);
  await call('/social', undefined, undefined, undefined, 401, MSG.login);
  await call('/schools?q=a', undefined, undefined, undefined, 401, MSG.login);
  await call('/posts?role=PARENT', undefined, undefined, sc, 403, MSG.otherBoard);
  await call('/posts?role=STUDENT', undefined, undefined, pc, 403, MSG.otherBoard);
  await call('/posts', undefined, undefined, ac, 403, MSG.role);
  await call('/posts', { title: 't', body: 'b', category: 'c', anonymous: false }, 'POST', ac, 403, MSG.role);
  await call('/social', undefined, undefined, ac, 403, MSG.role);
  await call('/posts', undefined, 'DELETE', sc, 404, MSG.route);
  await call('/admin', undefined, 'POST', ac, 404, MSG.route);

  // --- posts -----------------------------------------------------------------------------------
  // POST /posts answers with the same view the feed renders (author, counters, school scope, tags, blocks).
  const postKeys = ['id', 'author', 'authorId', 'role', 'category', 'title', 'body', 'anonymous', 'blocks', 'tags', 'school', 'status', 'isMine', 'likes', 'liked', 'saved', 'commentCount', 'createdAt'];
  const viewKeys = postKeys;
  const post = await call('/posts', { title: '  검증 게시글  ', body: '이 개념은 어떻게 기억하나요?', category: '자유', anonymous: false }, 'POST', sc, 201);
  expectKeys(post, postKeys, 'POST /posts');
  assert.equal(post.title, '검증 게시글', 'title is trimmed');
  assert.equal(post.authorId, student.id);
  assert.equal(post.role, 'STUDENT');
  assert.equal(post.anonymous, false);
  assert.match(post.createdAt, ISO);
  checks++;
  const anonPost = await call('/posts', { title: '익명 질문', body: '익명으로 물어봐요', category: '질문', anonymous: true }, 'POST', oc, 201);
  assert.equal(anonPost.anonymous, true);
  const thirdPost = await call('/posts', { title: '셋째 게시글', body: '정지 검증용', category: '자유', anonymous: false }, 'POST', tc, 201);
  const parentPost = await call('/posts', { title: '학부모 게시글', body: '학부모 게시판', category: '정보', anonymous: false }, 'POST', pc, 201);
  assert.equal(parentPost.role, 'PARENT');
  await call('/posts', { title: '   ', body: 'b', category: 'c', anonymous: false }, 'POST', sc, 400, MSG.required);
  await call('/posts', { title: 'x'.repeat(121), body: 'b', category: 'c', anonymous: false }, 'POST', sc, 400, MSG.input);
  await call('/posts', { title: 't', body: 'x'.repeat(10_001), category: 'c', anonymous: false }, 'POST', sc, 400, MSG.input);
  await call('/posts', { title: 't', body: '', category: 'c', anonymous: false }, 'POST', sc, 400, MSG.required);
  await call('/posts', { title: 't', body: 'b', category: 'x'.repeat(31), anonymous: false }, 'POST', sc, 400, MSG.input);
  await call('/posts', { title: 't', body: 'b', category: 'c' }, 'POST', sc, 400, MSG.input);
  await call('/posts', { title: 't', body: 'b', category: 'c', anonymous: 'yes' }, 'POST', sc, 400);
  await call('/posts', { title: 5, body: 'b', category: 'c', anonymous: false }, 'POST', sc, 400);

  let feed = await call('/posts?role=STUDENT', undefined, undefined, sc);
  for (const item of feed) expectKeys(item, viewKeys, 'GET /posts item');
  assert(nonIncreasing(feed), 'feed is newest first');
  checks++;
  const mine = feed.find((p: { id: string }) => p.id === post.id);
  assert.deepEqual(mine, {
    id: post.id, author: student.nickname, authorId: student.id, role: 'STUDENT', category: '자유', title: '검증 게시글',
    body: '이 개념은 어떻게 기억하나요?', anonymous: false, likes: 0, liked: false, saved: false, commentCount: 0, createdAt: post.createdAt,
    // Editor blocks, tags and school scope are part of the view even when empty; the viewer sees their own post as isMine.
    blocks: [], tags: {}, school: '', status: 'OPEN', isMine: true,
  });
  checks++;
  const anonymous = feed.find((p: { id: string }) => p.id === anonPost.id);
  assert.equal(anonymous.author, '익명');
  assert.equal(anonymous.authorId, '');
  assert.equal(anonymous.anonymous, true);
  checks++;
  assert(!feed.some((p: { id: string }) => p.id === parentPost.id), 'a parent post never reaches the student board');
  const parentFeed = await call('/posts', undefined, undefined, pc);
  assert(parentFeed.some((p: { id: string }) => p.id === parentPost.id));
  assert(!parentFeed.some((p: { id: string }) => p.id === post.id || p.id === anonPost.id));
  checks++;

  // --- like and save toggles -----------------------------------------------------------------
  assert.deepEqual(await call(`/posts/${post.id}/like`, {}, undefined, oc), { liked: true });
  feed = await call('/posts', undefined, undefined, oc);
  assert.equal(feed.find((p: { id: string }) => p.id === post.id).likes, 1);
  assert.equal(feed.find((p: { id: string }) => p.id === post.id).liked, true);
  feed = await call('/posts', undefined, undefined, sc);
  assert.equal(feed.find((p: { id: string }) => p.id === post.id).likes, 1);
  assert.equal(feed.find((p: { id: string }) => p.id === post.id).liked, false);
  checks++;
  assert.deepEqual(await call(`/posts/${post.id}/like`, {}, undefined, oc), { liked: false });
  feed = await call('/posts', undefined, undefined, oc);
  assert.equal(feed.find((p: { id: string }) => p.id === post.id).likes, 0);
  assert.deepEqual(await call(`/posts/${post.id}/like`, {}, undefined, oc), { liked: true });
  assert.equal(await db.postLike.count({ where: { postId: post.id } }), 1);
  checks++;
  assert.deepEqual(await call(`/posts/${post.id}/save`, {}, undefined, oc), { saved: true });
  feed = await call('/posts', undefined, undefined, oc);
  assert.equal(feed.find((p: { id: string }) => p.id === post.id).saved, true);
  assert.deepEqual(await call(`/posts/${post.id}/save`, {}, undefined, oc), { saved: false });
  feed = await call('/posts', undefined, undefined, oc);
  assert.equal(feed.find((p: { id: string }) => p.id === post.id).saved, false);
  assert.equal(await db.postSave.count({ where: { postId: post.id } }), 0);
  checks++;
  await call(`/posts/${parentPost.id}/like`, {}, undefined, sc, 403, MSG.role);
  await call(`/posts/${post.id}/save`, {}, undefined, pc, 403, MSG.role);
  await call('/posts/no-such-post/like', {}, undefined, sc, 404, MSG.postMissing);
  await call(`/posts/${post.id}/like`, undefined, 'GET', sc, 404, MSG.route);

  // --- comments and one level of replies -----------------------------------------------------
  // A created comment answers with the viewer flag instead of the raw author id.
  const commentKeys = ['id', 'postId', 'body', 'parentId', 'createdAt', 'isMine'];
  assert.deepEqual(await call(`/posts/${post.id}/comments`, undefined, undefined, sc), []);
  const comment = await call(`/posts/${post.id}/comments`, { body: ' 첫 댓글 ' }, undefined, oc, 201);
  expectKeys(comment, commentKeys, 'POST comment');
  assert.equal(comment.body, '첫 댓글');
  assert.equal(comment.parentId, null);
  assert.equal(comment.isMine, true);
  assert.equal(comment.postId, post.id);
  assert.match(comment.createdAt, ISO);
  checks++;
  await tick();
  const reply = await call(`/posts/${post.id}/comments`, { body: '답글', parentId: comment.id }, undefined, sc, 201);
  assert.equal(reply.parentId, comment.id);
  await call(`/posts/${post.id}/comments`, { body: '2단계', parentId: reply.id }, undefined, sc, 400, MSG.replyDepth);
  const crossComment = await call(`/posts/${anonPost.id}/comments`, { body: '다른 글의 댓글' }, undefined, sc, 201);
  // A parent is looked up inside this post first: another post's comment and an unknown id are both "not found".
  await call(`/posts/${post.id}/comments`, { body: '다른 글에 답글', parentId: crossComment.id }, undefined, sc, 404, MSG.commentMissing);
  await call(`/posts/${post.id}/comments`, { body: '없는 부모', parentId: 'no-such-comment' }, undefined, sc, 404, MSG.commentMissing);
  await call(`/posts/${post.id}/comments`, { body: '' }, undefined, sc, 400, MSG.required);
  await call(`/posts/${post.id}/comments`, { body: 'x'.repeat(2001) }, undefined, sc, 400, MSG.input);
  await call(`/posts/${post.id}/comments`, { body: 'b', parentId: '' }, undefined, sc, 400, MSG.input);
  await call(`/posts/${post.id}/comments`, { body: 'b', parentId: null }, undefined, sc, 400, MSG.input);
  await call(`/posts/${post.id}/comments`, { body: 'b' }, undefined, pc, 403, MSG.role);
  await call(`/posts/${post.id}/comments`, undefined, undefined, pc, 403, MSG.role);
  await call(`/posts/${post.id}/comments`, undefined, undefined, ac, 403, MSG.role);
  await call('/posts/no-such-post/comments', undefined, undefined, sc, 404, MSG.postMissing);
  const thread = await call(`/posts/${post.id}/comments`, undefined, undefined, sc);
  assert.equal(thread.length, 2);
  assert(nonDecreasing(thread), 'thread is oldest first');
  const top = thread.find((c: { id: string }) => c.id === comment.id);
  // Comment views carry the author id, viewer flags, like state, acceptance and redaction state.
  assert.deepEqual(top, { id: comment.id, postId: post.id, author: other.nickname, authorId: other.id, body: '첫 댓글', createdAt: comment.createdAt, isMine: false, isPostAuthor: false, deleted: false, likes: 0, liked: false, accepted: false });
  assert(!('parentId' in top), 'a top-level comment carries no parentId key');
  const nested = thread.find((c: { id: string }) => c.id === reply.id);
  assert.deepEqual(nested, { id: reply.id, postId: post.id, author: student.nickname, authorId: student.id, body: '답글', parentId: comment.id, createdAt: reply.createdAt, isMine: true, isPostAuthor: true, deleted: false, likes: 0, liked: false, accepted: false });
  checks++;
  feed = await call('/posts', undefined, undefined, sc);
  assert.equal(feed.find((p: { id: string }) => p.id === post.id).commentCount, 2);
  assert.equal(feed.find((p: { id: string }) => p.id === anonPost.id).commentCount, 1);
  checks++;
  // commented=1 keeps only the posts the caller commented on.
  assert.deepEqual(ids(await call('/posts?commented=1', undefined, undefined, oc)), [post.id]);
  assert.deepEqual(ids(await call('/posts?commented=1&role=STUDENT', undefined, undefined, sc)).sort(), [post.id, anonPost.id].sort());
  assert.deepEqual(await call('/posts?commented=1', undefined, undefined, tc), []);
  assert(ids(await call('/posts?commented=0', undefined, undefined, tc)).includes(post.id), 'only commented=1 filters');
  checks++;

  // --- reports: one per (user, post), reopened on repeat -------------------------------------
  const reportKeys = ['id', 'userId', 'postId', 'reason', 'status', 'createdAt'];
  const report = await call('/reports', { postId: anonPost.id, reason: ' 욕설 ' }, undefined, sc);
  expectKeys(report, reportKeys, 'POST /reports');
  assert.equal(report.status, 'OPEN');
  assert.equal(report.reason, '욕설');
  assert.equal(report.userId, student.id);
  assert.equal(report.postId, anonPost.id);
  assert.match(report.createdAt, ISO);
  checks++;
  const again = await call('/reports', { postId: anonPost.id, reason: '스팸' }, undefined, sc);
  assert.equal(again.id, report.id);
  assert.equal(again.reason, '스팸');
  assert.equal(again.status, 'OPEN');
  assert.equal(again.createdAt, report.createdAt);
  assert.equal(await db.report.count({ where: { userId: student.id, postId: anonPost.id } }), 1);
  checks++;
  await call('/reports', { postId: parentPost.id, reason: '역할' }, undefined, sc, 403, MSG.role);
  await call('/reports', { postId: anonPost.id, reason: '관리자' }, undefined, ac, 403, MSG.role);
  await call('/reports', { postId: 'no-such-post', reason: '없음' }, undefined, sc, 404, MSG.postMissing);
  await call('/reports', { postId: anonPost.id, reason: '  ' }, undefined, sc, 400, MSG.required);
  await call('/reports', { postId: anonPost.id, reason: 'x'.repeat(1001) }, undefined, sc, 400, MSG.input);
  await call('/reports', { postId: '', reason: '이유' }, undefined, sc, 400, MSG.input);
  await call('/reports', { postId: anonPost.id, reason: '이유' }, undefined, undefined, 401, MSG.login);

  // --- admin: role gate, report triage, schools, self-suspension --------------------------------
  await call('/admin', undefined, undefined, sc, 403, MSG.role);
  await call('/admin', undefined, undefined, pc, 403, MSG.role);
  await call('/admin', undefined, undefined, undefined, 401, MSG.login);
  await call(`/admin/reports/${report.id}`, { status: 'RESOLVED' }, 'PATCH', sc, 403, MSG.role);
  await call(`/admin/users/${other.id}`, { suspended: true }, 'PATCH', pc, 403, MSG.role);
  await call('/admin/schools', { name: '학생 학교' }, 'POST', sc, 403, MSG.role);
  const resolved = await call(`/admin/reports/${report.id}`, { status: 'RESOLVED' }, 'PATCH', ac);
  expectKeys(resolved, reportKeys, 'PATCH report');
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.id, report.id);
  checks++;
  await call(`/admin/reports/${report.id}`, { status: 'CLOSED' }, 'PATCH', ac, 400, MSG.input);
  await call(`/admin/reports/${report.id}`, {}, 'PATCH', ac, 400, MSG.input);
  await call('/admin/reports/no-such-report', { status: 'DISMISSED' }, 'PATCH', ac, 404, MSG.missing);
  assert.equal((await call(`/admin/reports/${report.id}`, { status: 'DISMISSED' }, 'PATCH', ac)).status, 'DISMISSED');
  const reopened = await call('/reports', { postId: anonPost.id, reason: '다시 신고' }, undefined, sc);
  assert.equal(reopened.id, report.id);
  assert.equal(reopened.status, 'OPEN', 'a repeated report reopens it');
  checks++;
  const school = await call('/admin/schools', { name: ` ${prefix} 고등학교 ` }, 'POST', ac, 201);
  expectKeys(school, ['id', 'name'], 'POST /admin/schools');
  assert.equal(school.name, `${prefix} 고등학교`);
  await call('/admin/schools', { name: `${prefix} 고등학교` }, 'POST', ac, 409, MSG.duplicate);
  await call('/admin/schools', { name: '' }, 'POST', ac, 400, MSG.required);
  await call('/admin/schools', { name: 'x'.repeat(101) }, 'POST', ac, 400, MSG.input);
  await call(`/admin/users/${admin.id}`, { suspended: true }, 'PATCH', ac, 400, MSG.selfSuspend);
  await call('/admin/users/no-such-user', { suspended: true }, 'PATCH', ac, 404, MSG.missing);
  await call(`/admin/users/${other.id}`, {}, 'PATCH', ac, 400, MSG.input);
  let overview = await call('/admin', undefined, undefined, ac);
  expectKeys(overview, ['users', 'reports', 'schools'], 'GET /admin');
  for (const u of overview.users) expectKeys(u, ['id', 'name', 'nickname', 'role', 'suspended'], 'admin user');
  const listed = overview.reports.find((r: { id: string }) => r.id === report.id);
  assert.deepEqual(listed, { ...reopened, post: { title: anonPost.title }, postTitle: anonPost.title });
  assert(overview.schools.some((s: { id: string }) => s.id === school.id));
  for (const s of overview.schools) expectKeys(s, ['id', 'name'], 'admin school');
  checks++;

  // --- follow toggles ------------------------------------------------------------------------
  assert.deepEqual(await call('/follow', { userId: other.id }, undefined, sc), { following: true });
  assert.deepEqual(await call('/follow', { userId: other.id }, undefined, sc), { following: false });
  assert.deepEqual(await call('/follow', { userId: other.id }, undefined, sc), { following: true });
  assert.equal(await db.follow.count({ where: { followerId: student.id } }), 1);
  checks++;
  assert.deepEqual(await call('/follow', { userId: student.id }, undefined, oc), { following: true });
  assert.deepEqual(await call('/follow', { userId: student.id }, undefined, tc), { following: true });
  await call('/follow', { userId: parent.id }, undefined, sc, 404, MSG.userMissing);
  await call('/follow', { userId: student.id }, undefined, sc, 404, MSG.userMissing);
  await call('/follow', { userId: 'no-such-user' }, undefined, sc, 404, MSG.userMissing);
  await call('/follow', { userId: '' }, undefined, sc, 400, MSG.input);
  // Only student profiles follow; a parent is refused by role before any lookup.
  await call('/follow', { userId: student.id }, undefined, pc, 403, MSG.followRole);

  // --- messages ------------------------------------------------------------------------------
  // A message carries its read state, editor blocks, redaction flag, reactions and the conversation ordinal.
  const messageKeys = ['id', 'senderId', 'recipientId', 'body', 'createdAt', 'readAt', 'blocks', 'deleted', 'reactions', 'ordinal'];
  const first = await call('/messages', { userId: other.id, body: ' 안녕 ' }, undefined, sc, 201);
  expectKeys(first, messageKeys, 'POST /messages');
  assert.equal(first.senderId, student.id);
  assert.equal(first.recipientId, other.id);
  assert.equal(first.body, '안녕');
  assert.match(first.createdAt, ISO);
  checks++;
  await tick();
  const second = await call('/messages', { userId: student.id, body: '반가워' }, undefined, oc, 201);
  const fromStudent = await call(`/messages?userId=${other.id}`, undefined, undefined, sc);
  assert.deepEqual(fromStudent, [first, second]);
  assert.deepEqual(await call(`/messages?userId=${student.id}`, undefined, undefined, oc), fromStudent);
  assert.deepEqual(await call(`/messages?userId=${third.id}`, undefined, undefined, sc), []);
  checks++;
  await call(`/messages?userId=${parent.id}`, undefined, undefined, sc, 404, MSG.userMissing);
  await call(`/messages?userId=${student.id}`, undefined, undefined, sc, 404, MSG.userMissing);
  await call('/messages', undefined, undefined, sc, 404, MSG.userMissing);
  await call('/messages', { userId: parent.id, body: '학부모에게' }, undefined, sc, 404, MSG.userMissing);
  await call('/messages', { userId: student.id, body: '학생에게' }, undefined, pc, 404, MSG.userMissing);
  await call('/messages', { userId: other.id, body: '' }, undefined, sc, 400, MSG.required);
  await call('/messages', { userId: other.id, body: 'x'.repeat(3001) }, undefined, sc, 400, MSG.input);
  await call('/messages', { userId: other.id, body: '관리자' }, undefined, ac, 403, MSG.role);

  // --- social summary ------------------------------------------------------------------------
  const ref = (u: { id: string; nickname: string }) => ({ id: u.id, nickname: u.nickname });
  let social = await call('/social', undefined, undefined, sc);
  expectKeys(social, ['followers', 'following', 'users', 'blocked', 'counts'], 'GET /social');
  assert.deepEqual(social.followers.map(ref).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)), [ref(other), ref(third)].sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(social.following, [ref(other)]);
  assert.deepEqual(social.blocked, []);
  assert.deepEqual(social.counts, {
    posts: await db.post.count({ where: { userId: student.id } }),
    comments: await db.comment.count({ where: { userId: student.id } }),
    followers: 2,
    following: 1,
  });
  assert.equal(social.counts.comments, 2);
  const peerIds = ids(social.users);
  assert(peerIds.includes(other.id) && peerIds.includes(third.id), 'peers of the same role are listed');
  assert(!peerIds.includes(student.id) && !peerIds.includes(parent.id) && !peerIds.includes(admin.id), 'self, other roles and admins are not');
  for (const u of social.users) expectKeys(u, ['id', 'nickname'], 'social user');
  checks++;
  await call('/social', undefined, undefined, pc);

  // --- suspension holds on the target's very next request -------------------------------------
  // The Go server caches user rows briefly; a request before the suspension proves the cache is
  // dropped. (/api/bootstrap goes through the same session check; it is probed via /api/me and
  // /api/posts here until the bootstrap route is mounted.)
  await call('/me', undefined, undefined, tc);
  const thirdComment = await call(`/posts/${post.id}/comments`, { body: '셋째의 댓글' }, undefined, tc, 201);
  assert.deepEqual(await call(`/admin/users/${third.id}`, { suspended: true }, 'PATCH', ac), { id: third.id, suspended: true });
  await call('/me', undefined, undefined, tc, 403, MSG.suspended);
  await call('/posts', undefined, undefined, tc, 403, MSG.suspended);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: third.id } })).suspended, true);
  checks++;
  assert(!ids(await call('/posts', undefined, undefined, sc)).includes(thirdPost.id), 'a suspended author leaves the feed');
  assert(!ids(await call(`/posts/${post.id}/comments`, undefined, undefined, sc)).includes(thirdComment.id), 'and the threads');
  await call(`/posts/${thirdPost.id}/like`, {}, undefined, sc, 404, MSG.postMissing);
  await call(`/posts/${thirdPost.id}/comments`, undefined, undefined, sc, 404, MSG.postMissing);
  await call('/reports', { postId: thirdPost.id, reason: '정지' }, undefined, sc, 404, MSG.postMissing);
  await call('/follow', { userId: third.id }, undefined, sc, 404, MSG.userMissing);
  await call('/messages', { userId: third.id, body: '정지된 사람에게' }, undefined, sc, 404, MSG.userMissing);
  social = await call('/social', undefined, undefined, sc);
  assert(!ids(social.users).includes(third.id), 'a suspended account is no peer');
  assert.equal(social.counts.followers, 2, 'follow rows stay');
  checks++;
  const listedThird = (await call('/admin', undefined, undefined, ac)).users.find((u: { id: string }) => u.id === third.id);
  assert.deepEqual(listedThird, { id: third.id, name: third.name, nickname: third.nickname, role: 'STUDENT', suspended: true });
  checks++;
  assert.deepEqual(await call(`/admin/users/${third.id}`, { suspended: false }, 'PATCH', ac), { id: third.id, suspended: false });
  await call('/me', undefined, undefined, tc);
  assert(ids(await call('/posts', undefined, undefined, sc)).includes(thirdPost.id), 'lifting the suspension restores the posts');
  assert(ids(await call(`/posts/${post.id}/comments`, undefined, undefined, sc)).includes(thirdComment.id));
  checks++;

  // --- blocks: both directions vanish, messages refuse, lifting restores -----------------------
  const otherComment = await call(`/posts/${thirdPost.id}/comments`, { body: '다른 학생의 댓글' }, undefined, oc, 201);
  const studentComment = await call(`/posts/${thirdPost.id}/comments`, { body: '검증 학생의 댓글' }, undefined, sc, 201);
  assert.deepEqual(await call('/blocks', { userId: student.id }, undefined, oc), { blocked: true });
  assert.equal(await db.block.count({ where: { userId: other.id, blockedId: student.id } }), 1);
  checks++;
  await call(`/posts/${post.id}/comments`, undefined, undefined, oc, 404, MSG.postMissing);
  await call(`/posts/${anonPost.id}/comments`, undefined, undefined, sc, 404, MSG.postMissing);
  await call(`/posts/${post.id}/like`, {}, undefined, oc, 404, MSG.postMissing);
  await call(`/posts/${anonPost.id}/save`, {}, undefined, sc, 404, MSG.postMissing);
  await call('/reports', { postId: anonPost.id, reason: '차단 후' }, undefined, sc, 404, MSG.postMissing);
  await call(`/posts/${post.id}/comments`, { body: '차단 후 댓글' }, undefined, oc, 404, MSG.postMissing);
  assert(!ids(await call('/posts', undefined, undefined, oc)).includes(post.id), 'the blocker no longer sees the blocked author');
  assert(!ids(await call('/posts', undefined, undefined, sc)).includes(anonPost.id), 'nor the other way round');
  const thirdThreadForOther = ids(await call(`/posts/${thirdPost.id}/comments`, undefined, undefined, oc));
  assert(thirdThreadForOther.includes(otherComment.id) && !thirdThreadForOther.includes(studentComment.id), 'blocked comments hide in shared threads');
  const thirdThreadForStudent = ids(await call(`/posts/${thirdPost.id}/comments`, undefined, undefined, sc));
  assert(thirdThreadForStudent.includes(studentComment.id) && !thirdThreadForStudent.includes(otherComment.id));
  checks++;
  await call('/messages', { userId: student.id, body: '차단했지만' }, undefined, oc, 403, MSG.blocked);
  await call('/messages', { userId: other.id, body: '차단됐지만' }, undefined, sc, 403, MSG.blocked);
  await call(`/messages?userId=${other.id}`, undefined, undefined, sc, 403, MSG.blocked);
  await call(`/messages?userId=${student.id}`, undefined, undefined, oc, 403, MSG.blocked);
  await call('/follow', { userId: other.id }, undefined, sc, 403, MSG.blocked);
  await call('/follow', { userId: student.id }, undefined, oc, 403, MSG.blocked);
  await call('/blocks', { userId: student.id }, undefined, oc, 403, MSG.blocked);
  await call('/blocks', { userId: parent.id }, undefined, oc, 404, MSG.userMissing);
  await call('/blocks', { userId: other.id }, undefined, oc, 404, MSG.userMissing);
  await call('/blocks', { userId: '' }, undefined, oc, 400, MSG.input);
  await call('/blocks', { userId: student.id }, undefined, ac, 403, MSG.role);
  social = await call('/social', undefined, undefined, oc);
  assert.deepEqual(social.blocked, [ref(student)]);
  assert(!ids(social.users).includes(student.id));
  social = await call('/social', undefined, undefined, sc);
  assert.deepEqual(social.blocked, []);
  assert(!ids(social.users).includes(other.id), 'being blocked hides the blocker too');
  checks++;
  assert.deepEqual(await call(`/blocks/${student.id}`, undefined, 'DELETE', oc), { blocked: false });
  assert.deepEqual(await call(`/blocks/${student.id}`, undefined, 'DELETE', oc), { blocked: false });
  assert.equal(await db.block.count({ where: { userId: other.id } }), 0);
  checks++;
  assert(ids(await call(`/posts/${post.id}/comments`, undefined, undefined, oc)).includes(comment.id), 'lifting the block restores the thread');
  assert(ids(await call('/posts', undefined, undefined, sc)).includes(anonPost.id));
  const afterBlock = await call('/messages', { userId: student.id, body: '다시 대화' }, undefined, oc, 201);
  assert.deepEqual(ids(await call(`/messages?userId=${other.id}`, undefined, undefined, sc)), [first.id, second.id, afterBlock.id]);
  assert(ids((await call('/social', undefined, undefined, sc)).users).includes(other.id));
  checks++;

  // --- schools: the embedded NEIS directory (server/internal/schools); every query word must match
  //     the name or address, best name matches first, at most 30 rows, no database rows involved ----
  const garak = await call('/schools?q=가락', undefined, undefined, sc);
  assert(garak.some((s: { name: string; address: string }) => s.name === '가락고등학교' && s.address.includes('송파구')), 'directory search by name');
  for (const s of garak) expectKeys(s, ['id', 'name', 'address', 'province'], 'school');
  assert.deepEqual(ids(await call('/schools?q=가락 송파', undefined, undefined, pc)).sort(), ids(garak.filter((s: { address: string }) => s.address.includes('송파'))).sort(), 'every word must match; parents search too');
  assert.equal((await call('/schools?q=고등학교', undefined, undefined, ac)).length, 30, 'capped at 30 rows');
  assert.deepEqual(await call(`/schools?q=${encodeURIComponent(prefix + ' nothing')}`, undefined, undefined, sc), []);
  assert.deepEqual(await call(`/schools?q=${encodeURIComponent('x'.repeat(120))}`, undefined, undefined, sc), [], 'a long query is cut to 100 characters and finds nothing');
  checks++;

  // --- limits: admin 500/500/1000, feed 100, thread 500, messages 50 per page, peers 100 ---------------
  await db.user.createMany({
    data: Array.from({ length: 501 }, (_, i) => ({ id: `${prefix}-bulk-${i}`, name: `대량 ${i}`, nickname: `${prefix}-bulk-${i}`, role: 'STUDENT' as const, createdAt: future(1, i) })),
  });
  await db.post.createMany({
    data: Array.from({ length: 501 }, (_, i) => ({ id: `${prefix}-bulkpost-${i}`, userId: student.id, role: 'STUDENT' as const, category: '자유', title: `대량 게시글 ${i}`, body: '본문', createdAt: future(2, i) })),
  });
  await db.report.createMany({
    data: Array.from({ length: 501 }, (_, i) => ({ id: `${prefix}-bulkreport-${i}`, userId: third.id, postId: `${prefix}-bulkpost-${i}`, reason: `대량 신고 ${i}`, createdAt: future(3, i) })),
  });
  await db.school.createMany({
    data: Array.from({ length: 1001 }, (_, i) => ({ id: `${prefix}-bulkschool-${i}`, name: `${prefix} bulk ${String(i).padStart(4, '0')}` })),
  });
  await db.comment.createMany({
    data: Array.from({ length: 501 }, (_, i) => ({ id: `${prefix}-bulkcomment-${i}`, postId: post.id, userId: student.id, body: `대량 댓글 ${i}`, createdAt: future(4, i) })),
  });
  await db.message.createMany({
    data: Array.from({ length: 201 }, (_, i) => ({ id: `${prefix}-bulkmessage-${i}`, senderId: student.id, recipientId: other.id, body: `대량 메시지 ${i}`, createdAt: future(5, i) })),
  });
  // The rows above bypassed the API, so no cache version moved; drop the cache the way an operator would (dev-only route).
  await call('/_dev/cache-flush', undefined, 'POST', ac);
  overview = await call('/admin', undefined, undefined, ac);
  assert.equal(overview.users.length, 500);
  assert.deepEqual(overview.users, plain(await db.user.findMany({ select: { id: true, name: true, nickname: true, role: true, suspended: true }, orderBy: { createdAt: 'desc' }, take: 500 })));
  assert(!ids(overview.users).includes(`${prefix}-bulk-0`) && ids(overview.users).includes(`${prefix}-bulk-500`), 'the 500 newest accounts');
  checks++;
  assert.equal(overview.reports.length, 500);
  const expectedReports = (await db.report.findMany({ include: { post: { select: { title: true } } }, orderBy: { createdAt: 'desc' }, take: 500 })).map((r) => ({ ...r, postTitle: r.post.title, createdAt: r.createdAt.toISOString() }));
  assert.deepEqual(overview.reports, plain(expectedReports));
  assert.equal(overview.reports[0].postTitle, '대량 게시글 500');
  checks++;
  assert.equal(overview.schools.length, 1000);
  assert.deepEqual(overview.schools, plain(await db.school.findMany({ orderBy: { name: 'asc' }, take: 1000 })));
  checks++;
  feed = await call('/posts', undefined, undefined, sc);
  assert.equal(feed.length, 100);
  assert.deepEqual(ids(feed), Array.from({ length: 100 }, (_, i) => `${prefix}-bulkpost-${500 - i}`), 'the 100 newest posts of the role');
  checks++;
  const bigThread = await call(`/posts/${post.id}/comments`, undefined, undefined, sc);
  assert.equal(bigThread.length, 500);
  assert.equal(bigThread[0].id, comment.id, 'the 500 oldest comments');
  assert.equal(bigThread[499].id, `${prefix}-bulkcomment-${500 - 4}`);
  checks++;
  // A conversation answers its newest 50 messages oldest-first; before=<id> pages toward older ones.
  const bigChat = await call(`/messages?userId=${other.id}`, undefined, undefined, sc);
  assert.equal(bigChat.length, 50, 'a page is the 50 newest messages');
  assert.equal(bigChat[0].id, `${prefix}-bulkmessage-151`, 'oldest first inside the page');
  assert.equal(bigChat[49].id, `${prefix}-bulkmessage-200`);
  let page = await call(`/messages?userId=${other.id}&before=${bigChat[0].id}`, undefined, undefined, sc);
  assert.equal(page.length, 50);
  assert.equal(page[49].id, `${prefix}-bulkmessage-150`, 'before= continues just past the previous page');
  for (let hops = 0; hops < 3 && page.length === 50; hops++) page = await call(`/messages?userId=${other.id}&before=${page[0].id}`, undefined, undefined, sc);
  assert.equal(page.length, 4, 'the last page holds the remaining messages');
  assert.deepEqual(ids(page).slice(0, 3), [first.id, second.id, afterBlock.id], 'the conversation start is reached through the cursor');
  await call(`/messages?userId=${other.id}&before=no-such-message`, undefined, undefined, sc, 404, MSG.missing);
  checks++;
  assert.equal((await call('/social', undefined, undefined, sc)).users.length, 100, 'peers are capped at 100');
  checks++;

  console.log(
    `API_CONTRACT_COMMUNITY_OK (${checks} checks; posts and feeds, likes and saves, comments and one-level replies, reports, admin lists and triage, suspension, follow, messages, blocks, social summary, schools search, list limits)`,
  );
} finally {
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.school.deleteMany({ where: { name: { startsWith: prefix } } });
  await db.$disconnect();
}
