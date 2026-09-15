// Gate leaf-9 T8: a class bell against one local server shaped like production (docs/JITTER.md):
// Postgres (scratch database), a throwaway valkey/valkey:8 container, DB_POOL_MAX=6, DEMO_MODE=true
// (every trying student is demo-student), and a fake model upstream (no paid call).
//  1. After a cache flush, 50 sessions open /api/bootstrap evenly over 10 s: no 5xx and one fill for
//     the one cache key (X-Cache). After another flush, 50 open it in the same instant: still one
//     fill (singleflight), the rest shared or hit. The pool's acquire count is recorded.
//  2. 25 generations start together with AI_CONCURRENCY 16: at most 16 reach the model at once,
//     the waiters are admitted in arrival order as slots free, and each request id has one AiRun.
//  3. With the production budget (10 a minute) the same 25 give 10 runs and 15 refusals, every one
//     with Retry-After and retryAfterMs, spread over the refusal window rather than one instant.
// Prints BELL_CHECK_OK ….
import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
let checks = 0;
const check = (ok, message) => {
  assert.ok(ok, message);
  checks++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms, what) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
};

const work = mkdtempSync(join(tmpdir(), 'memoryz-bell-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`go build: ${build.stderr}`);
const staticDir = join(work, 'static');
mkdirSync(staticDir);
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>shell</title><div>memoryz shell</div>');
const admin = new pg.Client({ connectionString: database.href });
await admin.connect();
const dbName = `memoryz_bell_${randomUUID().slice(0, 8)}`;
await admin.query(`CREATE DATABASE "${dbName}"`);
const scratch = new URL(database.href);
scratch.pathname = `/${dbName}`;
const migrate = spawnSync(bin, ['migrate', 'up'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: scratch.href, ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'warn' } });
if (migrate.status !== 0) throw new Error(`migrate: ${migrate.stdout}${migrate.stderr}`);
const db = new pg.Client({ connectionString: scratch.href });
await db.connect();
const valkeyPort = await freePort();
const valkeyName = `memoryz-bell-${randomUUID().slice(0, 8)}`;
execFileSync('docker', ['run', '-d', '--rm', '--name', valkeyName, '-p', `127.0.0.1:${valkeyPort}:6379`, 'valkey/valkey:8'], { stdio: 'ignore' });

// The fake model: holds calls when asked, and records which material each call was about.
const source = '나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다. 칼륨 이온이 세포 밖으로 나가면 재분극이 일어난다.';
const item = { prompt: '탈분극을 일으키는 이온의 이동은?', options: ['나트륨 유입', '나트륨 유출', '칼륨 유입', '칼륨 유출', '이동 없음'], answer: 0, explanation: '나트륨 이온이 세포 안으로 유입되어 탈분극이 발생해요.', citation: '나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.', past: '세포막', future: '막전위' };
const model = { hold: false, inFlight: 0, peak: 0, arrivals: [], held: [] };
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = JSON.parse(raw);
  const marker = /자료 번호 (\d+)/.exec(raw)?.[1];
  model.arrivals.push(Number(marker));
  model.inFlight++;
  model.peak = Math.max(model.peak, model.inFlight);
  if (model.hold) await new Promise((release) => model.held.push(release));
  model.inFlight--;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: 'gen-1', model: 'openai/gpt-5.6-luna', provider: 'Amazon Bedrock', choices: [{ finish_reason: 'stop', message: { content: null, tool_calls: [{ function: { name: body.tool_choice?.function?.name, arguments: JSON.stringify({ items: [item] }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

let server = null;
async function startServer(extra) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(bin, ['serve'], {
    env: {
      ...process.env, DATABASE_URL: scratch.href, PORT: String(port), HOST: '127.0.0.1', ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'warn', STATIC_DIR: staticDir, APP_URL: base,
      AUTH_SECRET: randomBytes(24).toString('hex'), DEMO_MODE: 'true', DB_POOL_MAX: '6', VALKEY_ADDR: `127.0.0.1:${valkeyPort}`, VALKEY_IAM_AUTH: 'false', VALKEY_CA_PEM: '',
      OPENROUTER_API_KEY: 'synthetic-provider-key', OPENROUTER_MODEL: 'openai/gpt-5.6-luna', OPENROUTER_REASONING_EFFORT: 'high', OPENROUTER_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AI_CONCURRENCY: '16', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((done) => child.on('exit', done));
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await fetch(`${base}/api/health`).then(async (r) => r.ok && (await r.json()).data.cacheDriver?.startsWith('valkey'), () => false);
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`server did not start on Valkey: ${output}`);
  server = { base, stop: async () => (child.kill('SIGTERM'), await Promise.race([exited, sleep(12_000)])), output: () => output };
  return server;
}
const login = async (base) => {
  const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'STUDENT' }) });
  return res.headers.getSetCookie().find((c) => c.startsWith('memoryz_session='))?.split(';')[0];
};
const flush = async (base) => assert.equal((await fetch(`${base}/api/_dev/cache-flush`, { method: 'POST' })).status, 200);
const acquires = async (base) => (await (await fetch(`${base}/api/_dev/stats`)).json()).data.acquireCount;

try {
  // ---- 1. Bootstrap at the bell ----
  const s = await startServer({ AI_RATE_PER_MINUTE: '100' });
  const sessions = [];
  for (let i = 0; i < 50; i++) sessions.push(await login(s.base));
  check(sessions.every(Boolean), '50 demo sessions');
  const wave = async (spreadMs) => {
    await flush(s.base);
    const before = await acquires(s.base);
    const started = Date.now();
    const answers = await Promise.all(
      sessions.map(async (cookie, i) => {
        await sleep((i * spreadMs) / 50);
        const res = await fetch(`${s.base}/api/bootstrap`, { headers: { cookie } });
        await res.arrayBuffer();
        return { status: res.status, cache: res.headers.get('x-cache') };
      }),
    );
    const count = (k) => answers.filter((a) => a.cache === k).length;
    return { answers, misses: count('miss'), shared: count('shared'), hits: count('hit'), fivexx: answers.filter((a) => a.status >= 500).length, acquired: (await acquires(s.base)) - before, ms: Date.now() - started };
  };
  const even = await wave(10_000);
  check(even.fivexx === 0 && even.answers.every((a) => a.status === 200), `evenly over 10 s: no 5xx (${even.answers.map((a) => a.status).filter((x) => x !== 200)})`);
  check(even.misses === 1 && even.misses + even.shared + even.hits === 50, `evenly over 10 s: one fill for the one key (miss ${even.misses}, shared ${even.shared}, hit ${even.hits})`);
  const burst = await wave(0);
  check(burst.fivexx === 0 && burst.misses === 1 && burst.shared + burst.hits === 49, `50 in one instant: one fill, the rest shared or hit (miss ${burst.misses}, shared ${burst.shared}, hit ${burst.hits})`);

  // ---- 2. 25 generations at once: admission ----
  const subject = randomUUID();
  await db.query(`INSERT INTO "Subject" ("id", "userId", "name") VALUES ($1, 'demo-student', '종 검증')`, [subject]);
  const materials = [];
  for (let i = 0; i < 25; i++) {
    const id = randomUUID();
    materials.push(id);
    await db.query(`INSERT INTO "Material" ("id", "userId", "subjectId", "title", "content") VALUES ($1, 'demo-student', $2, $3, $4)`, [id, subject, `자료 ${i}`, `${source} 자료 번호 ${i}`]);
  }
  const cookie = sessions[0];
  const generate = (i, requestId = randomUUID()) =>
    fetch(`${s.base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ materialId: materials[i], count: 1, mode: 'quiz', requestId }) }).then(async (res) => ({
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      body: await res.json().catch(() => ({})),
      requestId,
    }));
  model.hold = true;
  const runs = [];
  for (let i = 0; i < 25; i++) {
    runs.push(generate(i));
    await sleep(30); // arrival order 0, 1, 2, … at the server
  }
  await until(() => model.inFlight === 16, 15_000, '16 calls at the model');
  await sleep(500);
  check(model.inFlight === 16 && model.arrivals.length === 16, `16 slots: 16 at the model, 9 waiting (${model.inFlight} in flight)`);
  // Free one slot at a time: the next waiter in arrival order takes it.
  for (let k = 0; k < 9; k++) {
    model.held.shift()();
    await until(() => model.arrivals.length === 17 + k, 10_000, `waiter ${k + 1} to be admitted`);
  }
  check(JSON.stringify(model.arrivals.slice(16)) === JSON.stringify([16, 17, 18, 19, 20, 21, 22, 23, 24]), `waiters admitted in arrival order (${model.arrivals.slice(16)})`);
  model.hold = false;
  model.held.splice(0).forEach((release) => release());
  const done = await Promise.all(runs);
  check(model.peak <= 16, `never more than 16 at the model (peak ${model.peak})`);
  check(done.every((r) => r.status === 201), `all 25 finish (${done.map((r) => r.status)})`);
  const rows = (await db.query(`SELECT "requestId", count(*)::int AS n FROM "AiRun" WHERE "requestId" = ANY($1) GROUP BY 1`, [done.map((r) => r.requestId)])).rows;
  check(rows.length === 25 && rows.every((r) => r.n === 1), `one AiRun per request id (${rows.length} ids)`);
  await s.stop();

  // ---- 3. The production budget: 10 a minute for the one demo account ----
  const p = await startServer({ AI_RATE_PER_MINUTE: '10' });
  await flush(p.base);
  const cookieP = await login(p.base);
  const same = await Promise.all(
    materials.map((id) =>
      fetch(`${p.base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookieP }, body: JSON.stringify({ materialId: id, count: 1, mode: 'quiz', requestId: randomUUID() }) }).then(async (res) => ({
        status: res.status,
        retryAfter: res.headers.get('retry-after'),
        body: await res.json().catch(() => ({})),
      })),
    ),
  );
  const refused = same.filter((r) => r.status === 429);
  check(same.filter((r) => r.status === 201).length === 10 && refused.length === 15, `10 runs, 15 refusals (${same.map((r) => r.status)})`);
  check(refused.every((r) => /^\d+$/.test(r.retryAfter ?? '') && typeof r.body.retryAfterMs === 'number' && Math.ceil(r.body.retryAfterMs / 1000) === Number(r.retryAfter)), 'every refusal carries Retry-After and retryAfterMs');
  const waits = refused.map((r) => r.body.retryAfterMs);
  const range = Math.max(...waits) - Math.min(...waits);
  check(range >= 5000 && Math.max(...waits) <= 75_000, `the 15 refusals come back spread over the window, not at one instant (range ${range} ms)`);
  await p.stop();
  console.log(`BELL_CHECK_OK bootstrap(even: miss=${even.misses} acquires=${even.acquired}; burst: miss=${burst.misses} shared=${burst.shared} acquires=${burst.acquired}) generations(peak=${model.peak} fifo=ok runs=25) refusals(15, spread ${range} ms) checks=${checks}`);
} catch (error) {
  console.error(error);
  if (server) console.error(server.output().slice(-3000));
  process.exitCode = 1;
} finally {
  model.hold = false;
  model.held.splice(0).forEach((release) => release());
  if (server) await server.stop().catch(() => {});
  upstream.close();
  spawnSync('docker', ['rm', '-f', valkeyName], { stdio: 'ignore' });
  await db.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
  rmSync(work, { recursive: true, force: true });
}
