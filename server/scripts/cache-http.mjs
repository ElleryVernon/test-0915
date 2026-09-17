// Gate K1: the cache layer over real HTTP. Runs under serve.mjs (TEST_APP_URL, in-process cache,
// demo mode, the dedicated local database). Every cached answer is compared with a freshly
// computed one, every write that must invalidate is followed by a miss, and everything the check
// creates is removed again at the end.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const base = process.env.TEST_APP_URL;
if (!base) throw new Error('TEST_APP_URL is required (run through server/scripts/serve.mjs)');
const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');

let checks = 0;
const check = (ok, message) => {
  assert.ok(ok, message);
  checks++;
};
const cookieOf = (res) => {
  const raw = res.headers.get('set-cookie') ?? '';
  const m = /memoryz_session=([a-f0-9]{64})/.exec(raw);
  return m ? `memoryz_session=${m[1]}` : null;
};
async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.headers.origin = base;
    init.body = JSON.stringify(body);
  }
  return fetch(base + path, init);
}
const json = (res) => res.json();
const stats = async () => (await json(await call('/api/_dev/stats'))).data;
async function login(role) {
  const res = await call('/api/session', { method: 'POST', body: { role } });
  assert.equal(res.status, 200, `${role} login`);
  return cookieOf(res);
}
async function bootstrap(cookie, headers) {
  const res = await call('/api/bootstrap', { cookie, headers });
  const text = res.status === 200 ? await res.text() : '';
  return { status: res.status, cache: res.headers.get('x-cache'), etag: res.headers.get('etag'), text, data: text ? JSON.parse(text).data : null };
}

const db = new pg.Client({ connectionString: database.href });
await db.connect();
const created = { subjects: [], materials: [], cards: [], schedules: [], posts: [] };
try {
  const student = await login('STUDENT');
  const parent = await login('PARENT');

  // 1. A second bootstrap is answered from the cache: same ETag, same body, no database work.
  const first = await bootstrap(student);
  check(first.status === 200 && first.cache === 'miss' && /^"[a-f0-9]{32}"$/.test(first.etag), `first bootstrap ${first.status} ${first.cache} ${first.etag}`);
  const before = await stats();
  const second = await bootstrap(student);
  const after = await stats();
  check(second.cache === 'hit' && second.etag === first.etag && second.text === first.text, `second bootstrap ${second.cache} ${second.etag}`);
  check(after.acquireCount === before.acquireCount, `a cache hit acquires no connection (${before.acquireCount} → ${after.acquireCount})`);
  const conditional = await bootstrap(student, { 'if-none-match': first.etag });
  check(conditional.status === 304 && conditional.cache === 'hit', `conditional request from the cache ${conditional.status} ${conditional.cache}`);

  // 2. A material creation invalidates: miss, new ETag, and the material is in the payload.
  const subject = (await json(await call('/api/subjects', { method: 'POST', cookie: student, body: { name: '캐시 검사 과목' } }))).data;
  check(subject?.id, `subject created ${JSON.stringify(subject)}`);
  created.subjects.push(subject.id);
  const afterSubject = await bootstrap(student);
  check(afterSubject.cache === 'miss' && afterSubject.etag !== first.etag && afterSubject.data.subjects.some((s) => s.id === subject.id), 'subject creation invalidates the bootstrap');
  const material = (await json(await call('/api/materials', { method: 'POST', cookie: student, body: { subjectId: subject.id, title: '캐시 검사 자료', content: '세포막은 인지질 이중층으로 이루어져 있다. '.repeat(8), type: 'TXT' } }))).data;
  check(material?.id, `material created ${JSON.stringify(material)}`);
  created.materials.push(material.id);
  const afterMaterial = await bootstrap(student);
  check(afterMaterial.cache === 'miss' && afterMaterial.etag !== afterSubject.etag && afterMaterial.data.materials.some((m) => m.id === material.id), 'material creation invalidates the bootstrap');
  check((await bootstrap(student)).cache === 'hit', 'and the next read is a hit again');

  // 3. A card review invalidates (own card, created for this check).
  const card = (await json(await call('/api/cards', { method: 'POST', cookie: student, body: { subjectId: subject.id, front: '캐시', back: '검사', type: 'CONCEPT' } }))).data;
  check(card?.id, `card created ${JSON.stringify(card)}`);
  created.cards.push(card.id);
  const beforeReview = await bootstrap(student);
  const review = await call('/api/cards/review', { method: 'POST', cookie: student, body: { cardId: card.id, rating: 'GOOD', reviewId: randomUUID() } });
  check(review.status === 200, `card review ${review.status} ${await review.text()}`);
  const afterReview = await bootstrap(student);
  check(afterReview.cache === 'miss' && afterReview.etag !== beforeReview.etag, 'a card review invalidates the bootstrap');

  // 4. A profile change invalidates; restoring it invalidates again and yields the previous payload.
  const profile = afterReview.data.profile;
  const retention = profile.desiredRetention === 0.9 ? 0.85 : 0.9;
  check((await call('/api/profile', { method: 'PATCH', cookie: student, body: { desiredRetention: retention } })).status === 200, 'profile patch');
  const afterProfile = await bootstrap(student);
  check(afterProfile.cache === 'miss' && afterProfile.etag !== afterReview.etag && afterProfile.data.profile.desiredRetention === retention, 'a profile change invalidates the bootstrap');
  check((await call('/api/profile', { method: 'PATCH', cookie: student, body: { desiredRetention: profile.desiredRetention } })).status === 200, 'profile restored');
  const restored = await bootstrap(student);
  check(restored.cache === 'miss' && restored.etag === afterReview.etag && restored.text === afterReview.text, 'a freshly computed payload equals the one the cache served before');

  // 5. The parent's bootstrap is keyed by the child's version too: a child's write misses it.
  const parentFirst = await bootstrap(parent);
  check(parentFirst.status === 200 && parentFirst.cache === 'miss' && parentFirst.data.child?.id === 'demo-student', `parent bootstrap ${parentFirst.status} ${parentFirst.cache}`);
  check((await bootstrap(parent)).cache === 'hit', 'parent second read is a hit');
  const schedule = (await json(await call('/api/schedules', { method: 'POST', cookie: student, body: { title: '캐시 검사 일정', date: '2026-12-31', start: '19:00', end: '20:00', kind: 'FLEXIBLE', subjectId: subject.id } }))).data;
  check(schedule?.id, `schedule created ${JSON.stringify(schedule)}`);
  created.schedules.push(schedule.id);
  const parentAfter = await bootstrap(parent);
  check(parentAfter.cache === 'miss' && parentAfter.etag !== parentFirst.etag && parentAfter.data.schedules.some((s) => s.id === schedule.id), "the child's write invalidates the parent's bootstrap");

  // 6. The feed: a new post shows on the very next list.
  const feedBefore = (await json(await call('/api/posts', { cookie: student }))).data;
  const feedCached = (await json(await call('/api/posts', { cookie: student }))).data;
  check(JSON.stringify(feedCached) === JSON.stringify(feedBefore), 'cached feed equals the computed feed');
  const post = (await json(await call('/api/posts', { method: 'POST', cookie: student, body: { title: '캐시 검사 글', body: '캐시 검사 본문입니다.', category: 'FREE', anonymous: false } }))).data;
  check(post?.id, `post created ${JSON.stringify(post)}`);
  created.posts.push(post.id);
  const feedAfter = (await json(await call('/api/posts', { cookie: student }))).data;
  check(feedAfter.some((p) => p.id === post.id) && !feedBefore.some((p) => p.id === post.id), 'a new post is visible immediately');
  const bootWithPost = await bootstrap(student);
  check(bootWithPost.data.posts.some((p) => p.id === post.id), 'the bootstrap feed shows it too');
  // Another user's like changes the shared count for everyone.
  const like = await call(`/api/posts/${post.id}/like`, { method: 'POST', cookie: await login('STUDENT') });
  check(like.status === 200, `like ${like.status}`);
  const feedLiked = (await json(await call('/api/posts', { cookie: student }))).data;
  check(feedLiked.find((p) => p.id === post.id)?.likes === 1, "another user's like is visible immediately");

  // 7. School search reads the embedded directory (server/internal/schools) on every call: no cache
  //    layer, no X-Cache header, and two identical queries return the same body.
  const schoolsFirst = await call('/api/schools?q=고', { cookie: student });
  const schoolsSecond = await call('/api/schools?q=고', { cookie: student });
  const [s1, s2] = [await schoolsFirst.text(), await schoolsSecond.text()];
  check(schoolsFirst.status === 200 && schoolsSecond.status === 200 && s1 === s2 && JSON.parse(s1).data.length > 0, `school search ${schoolsFirst.status} ${schoolsSecond.status}`);
  check(schoolsFirst.headers.get('x-cache') === null && schoolsSecond.headers.get('x-cache') === null, 'the directory answers without the cache layer');

  // 8. Health reports the cache driver.
  const health = (await json(await call('/api/health'))).data;
  check(health.cache === 'ok' && typeof health.cacheDriver === 'string', `health ${JSON.stringify(health)}`);

  console.log(`CACHE_HTTP_OK (${checks} checks)`);
} finally {
  // Remove what this check created, dependents first.
  if (created.posts.length) await db.query('DELETE FROM "PostLike" WHERE "postId" = ANY($1)', [created.posts]).catch(() => {});
  if (created.posts.length) await db.query('DELETE FROM "Post" WHERE "id" = ANY($1)', [created.posts]);
  if (created.schedules.length) await db.query('DELETE FROM "Schedule" WHERE "id" = ANY($1)', [created.schedules]);
  if (created.cards.length) await db.query('DELETE FROM "CardReview" WHERE "cardId" = ANY($1)', [created.cards]);
  if (created.cards.length) await db.query('DELETE FROM "Card" WHERE "id" = ANY($1)', [created.cards]);
  if (created.materials.length) await db.query('DELETE FROM "Material" WHERE "id" = ANY($1)', [created.materials]);
  if (created.subjects.length) await db.query('DELETE FROM "Subject" WHERE "id" = ANY($1)', [created.subjects]);
  await db.end();
}
