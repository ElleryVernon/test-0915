// Gate V4: the PoC's peak, reproduced against a Go server on this machine — 50 concurrent students
// pulling bootstrap and the community feed for 30 s each, 20 students reviewing cards at once,
// five PDF uploads in parallel, and bootstrap again with GOMAXPROCS=1 (a 1 vCPU Cloud Run
// instance). Errors must be zero and p95 within the capacity model's targets. Uses throwaway
// qa- accounts on the dedicated local database and removes them afterwards.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const DURATION = process.env.LOAD_DURATION ?? '30s';
const work = mkdtempSync(join(tmpdir(), 'memoryz-load-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(build.stderr);
const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const client = new pg.Client({ connectionString: database.href });
await client.connect();
const prefix = `qa-load-${randomUUID().slice(0, 8)}`;
const users = [];
async function startServer(extraEnv = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(bin, ['serve'], {
    env: { ...process.env, DATABASE_URL: database.href, PORT: String(port), HOST: '127.0.0.1', ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'warn', APP_URL: base, DEMO_MODE: 'true', AUTH_SECRET: randomBytes(24).toString('hex'), OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '', DB_POOL_MAX: '6', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return { base, child, output: () => output };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start: ${output}`);
}
async function stop(server) {
  server.child.kill('SIGTERM');
  await Promise.race([new Promise((r) => server.child.once('exit', r)), new Promise((r) => setTimeout(r, 10_000))]);
}
async function sessionFor(userId) {
  const token = randomBytes(32).toString('hex');
  await client.query(`INSERT INTO "Session" ("id", "userId", "expiresAt") VALUES ($1, $2, now() + interval '2 hours')`, [sha(token), userId]);
  return `memoryz_session=${token}`;
}
function oha(url, cookie, concurrency) {
  const res = spawnSync('oha', ['-z', DURATION, '-w', '-c', String(concurrency), '--no-tui', '--output-format', 'json', '-H', `Cookie: ${cookie}`, url], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (res.status !== 0) throw new Error(`oha: ${res.stderr}`);
  const j = JSON.parse(res.stdout);
  const total = Object.values(j.statusCodeDistribution).reduce((a, b) => a + b, 0);
  const ok = j.statusCodeDistribution['200'] ?? 0;
  const p95 = Math.round(j.latencyPercentiles.p95 * 1000);
  return { rps: Math.round(j.summary.requestsPerSec), p95, errors: total - ok + Object.values(j.errorDistribution ?? {}).reduce((a, b) => a + b, 0), total };
}
const report = [];
let ok = true;
try {
  // A student with realistic data for the bootstrap and feed runs.
  const student = `${prefix}-s`;
  await client.query(`INSERT INTO "User" ("id", "name", "nickname", "role") VALUES ($1, '부하 학생', $1, 'STUDENT')`, [student]);
  users.push(student);
  const subject = randomUUID();
  await client.query(`INSERT INTO "Subject" ("id", "userId", "name") VALUES ($1, $2, '부하 과목')`, [subject, student]);
  for (let i = 0; i < 20; i++) await client.query(`INSERT INTO "Material" ("id", "userId", "subjectId", "title", "content") VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), student, subject, `자료 ${i}`, '본문 '.repeat(300)]);
  for (let i = 0; i < 60; i++) await client.query(`INSERT INTO "Card" ("id", "userId", "subjectId", "front", "back") VALUES ($1, $2, $3, '앞', '뒤')`, [randomUUID(), student, subject]);
  const question = randomUUID();
  await client.query(`INSERT INTO "Question" ("id", "userId", "subjectId", "materialId", "prompt", "options", "answer", "explanation", "citation", "past", "future") VALUES ($1, $2, $3, (SELECT "id" FROM "Material" WHERE "userId" = $2 LIMIT 1), '문제', ARRAY['a','b','c','d','e'], 0, '설명', '인용 문장입니다.', '과거', '미래')`, [question, student, subject]);
  for (let i = 0; i < 300; i++) await client.query(`INSERT INTO "Attempt" ("id", "userId", "questionId", "answer", "correct", "score", "createdAt") VALUES ($1, $2, $3, '0', $4, 0, now() - ($5 || ' minutes')::interval)`, [randomUUID(), student, question, i % 2 === 0, String(i)]);
  const cookie = await sessionFor(student);

  const server = await startServer();
  const boot = oha(`${server.base}/api/bootstrap`, cookie, 50);
  report.push(`bootstrap c=50: ${boot.rps} req/s, p95 ${boot.p95} ms, errors ${boot.errors}/${boot.total}`);
  ok &&= boot.errors === 0 && boot.p95 < 300;
  const feed = oha(`${server.base}/api/posts?role=STUDENT`, cookie, 50);
  report.push(`posts c=50: ${feed.rps} req/s, p95 ${feed.p95} ms, errors ${feed.errors}/${feed.total}`);
  ok &&= feed.errors === 0 && feed.p95 < 300;

  // 20 students reviewing their own cards at once for 20 s.
  const reviewers = [];
  for (let i = 0; i < 20; i++) {
    const id = `${prefix}-r${i}`;
    await client.query(`INSERT INTO "User" ("id", "name", "nickname", "role") VALUES ($1, '복습 학생', $1, 'STUDENT')`, [id]);
    users.push(id);
    const subj = randomUUID();
    await client.query(`INSERT INTO "Subject" ("id", "userId", "name") VALUES ($1, $2, '복습 과목')`, [subj, id]);
    const cards = [];
    for (let c = 0; c < 10; c++) {
      const cardId = randomUUID();
      cards.push(cardId);
      await client.query(`INSERT INTO "Card" ("id", "userId", "subjectId", "front", "back") VALUES ($1, $2, $3, '앞', '뒤')`, [cardId, id, subj]);
    }
    reviewers.push({ cookie: await sessionFor(id), cards });
  }
  const ratings = ['AGAIN', 'HARD', 'GOOD', 'EASY'];
  const latencies = [];
  let reviewErrors = 0;
  let reviews = 0;
  const until = Date.now() + 20_000;
  await Promise.all(
    reviewers.map(async (r) => {
      let i = 0;
      while (Date.now() < until) {
        const started = performance.now();
        const res = await fetch(`${server.base}/api/cards/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: r.cookie, Origin: server.base }, body: JSON.stringify({ cardId: r.cards[i++ % r.cards.length], rating: ratings[i % 4], reviewId: randomUUID() }) });
        latencies.push(performance.now() - started);
        reviews++;
        if (res.status !== 200) reviewErrors++;
        await res.arrayBuffer();
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  const reviewP95 = Math.round(latencies[Math.floor(latencies.length * 0.95)] ?? 0);
  report.push(`reviews 20 users/20s: ${reviews} reviews (${Math.round(reviews / 20)} req/s), p95 ${reviewP95} ms, errors ${reviewErrors}`);
  ok &&= reviewErrors === 0 && reviewP95 < 300;

  // Five PDF uploads at once.
  const pdf = readFileSync('tests/fixtures/pdf/document.pdf');
  const uploadStarted = performance.now();
  const uploads = await Promise.all(
    Array.from({ length: 5 }, () => {
      const form = new FormData();
      form.append('file', new Blob([pdf], { type: 'application/pdf' }), '부하.pdf');
      return fetch(`${server.base}/api/upload`, { method: 'POST', headers: { Cookie: cookie, Origin: server.base }, body: form }).then((r) => r.status);
    }),
  );
  const uploadMs = Math.round(performance.now() - uploadStarted);
  report.push(`uploads x5 parallel: statuses ${uploads.join(',')} in ${uploadMs} ms`);
  ok &&= uploads.every((s) => s === 200);
  await stop(server);

  // One vCPU, as on Cloud Run.
  const single = await startServer({ GOMAXPROCS: '1' });
  const bootSingle = oha(`${single.base}/api/bootstrap`, cookie, 50);
  report.push(`bootstrap c=50 GOMAXPROCS=1: ${bootSingle.rps} req/s, p95 ${bootSingle.p95} ms, errors ${bootSingle.errors}/${bootSingle.total}`);
  ok &&= bootSingle.errors === 0 && bootSingle.p95 < 600;
  await stop(single);
  console.log(report.join('\n'));
  const errors = boot.errors + feed.errors + reviewErrors + uploads.filter((s) => s !== 200).length + bootSingle.errors;
  console.log(`${ok ? 'LOAD_PEAK_OK' : 'LOAD_PEAK_FAILED'} errors=${errors}`);
} catch (error) {
  console.error(error);
  ok = false;
} finally {
  await client.query(`DELETE FROM "User" WHERE "id" = ANY($1)`, [users]);
  await client.query(`DELETE FROM "Upload" WHERE "userId" = ANY($1)`, [users]);
  await client.query(`DELETE FROM ops.blob WHERE key LIKE 'uploads/%' AND NOT EXISTS (SELECT 1 FROM "Upload" u WHERE key = 'uploads/' || u."id" OR key LIKE 'uploads/' || u."id" || '/%')`);
  await client.end();
  rmSync(work, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
