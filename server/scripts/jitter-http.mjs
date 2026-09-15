// Gate leaf-9 T6: every refusal a class can meet at once says when to come back (docs/JITTER.md).
// Against real servers on a scratch database with a fake model upstream (no paid call):
//  - the sign-in limit (120 a minute per address), the AI minute and day budgets, the parent link
//    lock, the PDF queue and the AI admission queue each answer 429 with an integer Retry-After and
//    a retryAfterMs in the designed range (the day budget: code AI_DAILY_LIMIT and the exact rest);
//  - a server without AI answers 503 with code AI_UNAVAILABLE and no hint, an unconfigured sign-in
//    provider 503 with PROVIDER_OFF and no hint;
//  - across the whole run, no 429 lacks either hint.
// Prints JITTER_HTTP_OK (<n> checks).
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const work = mkdtempSync(join(tmpdir(), 'memoryz-jitter-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`go build: ${build.stderr}`);
const staticDir = join(work, 'static');
mkdirSync(staticDir);
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>shell</title><div>memoryz shell</div>');

const admin = new pg.Client({ connectionString: database.href });
await admin.connect();
const dbName = `memoryz_jitter_${randomUUID().slice(0, 8)}`;
await admin.query(`CREATE DATABASE "${dbName}"`);
const scratch = new URL(database.href);
scratch.pathname = `/${dbName}`;
const migrate = spawnSync(bin, ['migrate', 'up'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: scratch.href, ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'warn' } });
if (migrate.status !== 0) throw new Error(`migrate: ${migrate.stdout}${migrate.stderr}`);
const db = new pg.Client({ connectionString: scratch.href });
await db.connect();

// The fake model: one valid quiz item (and OCR text) per call, or held until released.
const source = '나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다. 칼륨 이온이 세포 밖으로 나가면 재분극이 일어난다.';
const item = { prompt: '탈분극을 일으키는 이온의 이동은?', options: ['나트륨 유입', '나트륨 유출', '칼륨 유입', '칼륨 유출', '이동 없음'], answer: 0, explanation: '나트륨 이온이 세포 안으로 유입되어 탈분극이 발생해요.', citation: '나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.', past: '세포막', future: '막전위' };
const model = { mode: 'ok', inFlight: 0, calls: 0, held: [] };
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  model.calls++;
  model.inFlight++;
  if (model.mode === 'hold') await new Promise((release) => model.held.push(release));
  model.inFlight--;
  const name = body.tool_choice?.function?.name;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: 'gen-1', model: 'openai/gpt-5.6-luna', provider: 'Amazon Bedrock', choices: [{ finish_reason: 'stop', message: { content: null, tool_calls: [{ function: { name, arguments: JSON.stringify({ items: [item], text: '스캔한 쪽의 본문입니다. 광합성은 빛에너지를 화학 에너지로 바꾼다.' }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
const releaseModel = () => {
  model.mode = 'ok';
  model.held.splice(0).forEach((release) => release());
};

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
const servers = [];
async function startServer(extra) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(bin, ['serve'], {
    env: { ...process.env, DATABASE_URL: scratch.href, PORT: String(port), HOST: '127.0.0.1', ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'warn', STATIC_DIR: staticDir, APP_URL: base, AUTH_SECRET: randomBytes(24).toString('hex'), DEMO_MODE: 'true', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', VALKEY_ADDR: '', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((done) => child.on('exit', (code) => done(code)));
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error(`server did not start: ${output}`);
  const server = {
    base,
    stop: async () => {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 12_000))]);
    },
  };
  servers.push(server);
  return server;
}
const ai = { OPENROUTER_API_KEY: 'synthetic-provider-key', OPENROUTER_MODEL: 'openai/gpt-5.6-luna', OPENROUTER_REASONING_EFFORT: 'high', OPENROUTER_BASE_URL: upstreamURL };

// Every response this script reads passes through here, so the invariant covers the whole run.
const refusals = [];
async function call(base, path, { method = 'GET', body, cookie, headers = {}, form } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {}
  const out = { status: res.status, headers: res.headers, json, retryAfter: res.headers.get('retry-after') };
  if (res.status === 429) refusals.push({ path, retryAfter: out.retryAfter, retryAfterMs: json.retryAfterMs });
  return out;
}
const hinted = (r, loS, hiS, what) => {
  const secs = Number(r.retryAfter);
  const ms = r.json.retryAfterMs;
  // Hints are whole milliseconds rounded up: a draw at the very end of the spread reports hiS itself.
  check(r.status === 429 && /^\d+$/.test(r.retryAfter ?? '') && typeof ms === 'number' && Math.ceil(ms / 1000) === secs && ms >= loS * 1000 && ms <= hiS * 1000, `${what}: 429 with Retry-After ${r.retryAfter} / retryAfterMs ${ms} in [${loS}, ${hiS}] s (${r.status} ${JSON.stringify(r.json).slice(0, 120)})`);
};
const login = async (base, role = 'STUDENT', headers = {}) => {
  const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ role }) });
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('memoryz_session='));
  return raw ? raw.split(';')[0] : null;
};
const until = async (cond, ms, what) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

try {
  // ---- Server A: sign-in limit, AI minute budget, link lock ----
  const a = await startServer({ ...ai, TRUST_PROXY: 'true', AI_RATE_PER_MINUTE: '2', AI_RATE_PER_DAY: '200' });
  let last;
  for (let i = 0; i < 121; i++) last = await call(a.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' }, headers: { 'X-Forwarded-For': '203.0.113.50' } });
  hinted(last, 1, 76, 'sign-in limit (121st in a minute from one address)');
  const student = await login(a.base, 'STUDENT', { 'X-Forwarded-For': '203.0.113.51' });
  check(!!student, 'demo student signed in from another address');
  const subjectID = randomUUID();
  const materialID = randomUUID();
  await db.query(`INSERT INTO "Subject" ("id", "userId", "name") VALUES ($1, 'demo-student', '지터 검증')`, [subjectID]);
  await db.query(`INSERT INTO "Material" ("id", "userId", "subjectId", "title", "content") VALUES ($1, 'demo-student', $2, '막전위', $3)`, [materialID, subjectID, source]);
  const generate = (base, cookie, requestId = randomUUID()) => call(base, '/api/generate', { method: 'POST', cookie, body: { materialId: materialID, count: 1, mode: 'quiz', requestId } });
  const g1 = await generate(a.base, student);
  const g2 = await generate(a.base, student);
  check(g1.status === 201 && g2.status === 201, `two runs within the minute budget (${g1.status} ${g2.status})`);
  const refusedID = randomUUID();
  const g3 = await generate(a.base, student, refusedID);
  hinted(g3, 1, 76, 'AI minute budget (rest of the minute + U[0,15 s))');
  check((await db.query(`SELECT count(*)::int AS n FROM "AiRun" WHERE "requestId" = $1`, [refusedID])).rows[0].n === 0, 'a refused run leaves no AiRun row (the request id may be reused)');
  const parent = await login(a.base, 'PARENT', { 'X-Forwarded-For': '203.0.113.52' });
  let link;
  for (let i = 0; i < 5; i++) link = await call(a.base, '/api/link', { method: 'POST', cookie: parent, body: { code: '000000' } });
  check(link.status === 429 && link.retryAfter === '1800' && link.json.retryAfterMs === 1_800_000, `the fifth wrong code locks for exactly 30 min (${link.status} ${link.retryAfter} ${link.json.retryAfterMs})`);
  const locked = await call(a.base, '/api/link', { method: 'POST', cookie: parent, body: { code: '000000' } });
  check(locked.status === 429 && Number(locked.retryAfter) <= 1800 && Number(locked.retryAfter) >= 1790, `a locked parent hears the exact time left (${locked.retryAfter})`);
  const providerOff = await call(a.base, '/api/auth/google?role=STUDENT', { headers: { 'X-Forwarded-For': '203.0.113.53' } });
  check(providerOff.status === 503 && providerOff.json.code === 'PROVIDER_OFF' && providerOff.retryAfter === null && providerOff.json.retryAfterMs === undefined, `an unconfigured provider: 503 PROVIDER_OFF, no hint (${providerOff.status} ${providerOff.json.code})`);

  // ---- Server B: the day budget ----
  const b = await startServer({ ...ai, AI_RATE_PER_MINUTE: '100', AI_RATE_PER_DAY: '2' });
  const studentB = await login(b.base);
  await generate(b.base, studentB);
  await generate(b.base, studentB);
  const daily = await generate(b.base, studentB);
  check(daily.status === 429 && daily.json.code === 'AI_DAILY_LIMIT', `the day budget has its own code (${daily.status} ${daily.json.code})`);
  hinted(daily, 86_390, 86_401, 'AI day budget (the exact rest of the day, no spread)');

  // ---- Server C: the AI admission queue and the PDF queue (both wait 30 s) ----
  const c = await startServer({ ...ai, AI_RATE_PER_MINUTE: '100', AI_RATE_PER_DAY: '200', AI_CONCURRENCY: '2', PDF_WORKERS: '1' });
  const studentC = await login(c.base);
  model.mode = 'hold';
  const held = generate(c.base, studentC);
  await until(() => model.inFlight === 1, 10_000, 'the first generation to reach the model');
  const scanned = readFileSync('tests/fixtures/pdf/scanned.pdf');
  const upload = () => {
    const form = new FormData();
    form.append('file', new Blob([scanned], { type: 'application/pdf' }), 'scan.pdf');
    return call(c.base, '/api/upload', { method: 'POST', cookie: studentC, form });
  };
  const pdfHolding = upload();
  await until(() => model.inFlight === 2, 15_000, 'the scanned page to reach OCR');
  const started = Date.now();
  const [queuedRun, queuedPDF] = await Promise.all([generate(c.base, studentC), upload()]);
  const waited = Date.now() - started;
  check(waited >= 29_000, `both queues waited their 30 s (${waited} ms)`);
  hinted(queuedRun, 10, 20, 'AI admission queue (10 s + U[0,10 s))');
  hinted(queuedPDF, 30, 60, 'PDF queue (30 s + U[0,30 s))');
  check(queuedPDF.json.error === '지금 올리는 파일이 많아요. 잠시 후 다시 시도해 주세요.', 'the PDF queue says so');
  releaseModel();
  const [heldRun, heldPDF] = await Promise.all([held, pdfHolding]);
  check(heldRun.status === 201 && heldPDF.status === 200, `the held work finishes once the model answers (${heldRun.status} ${heldPDF.status})`);

  // ---- Server D: no AI configured ----
  const d = await startServer({ OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '' });
  const studentD = await login(d.base);
  const off = await generate(d.base, studentD);
  check(off.status === 503 && off.json.code === 'AI_UNAVAILABLE' && off.retryAfter === null && off.json.retryAfterMs === undefined, `a server without AI: 503 AI_UNAVAILABLE, no hint (${off.status} ${off.json.code} ${off.retryAfter})`);

  const bare = refusals.filter((r) => !/^\d+$/.test(r.retryAfter ?? '') || typeof r.retryAfterMs !== 'number');
  check(refusals.length >= 7 && bare.length === 0, `every 429 in the run carried both hints (${refusals.length} refusals, ${bare.length} bare: ${JSON.stringify(bare)})`);
  console.log(`JITTER_HTTP_OK (${checks} checks)`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  releaseModel();
  for (const s of servers) await s.stop().catch(() => {});
  upstream.close();
  await db.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
  rmSync(work, { recursive: true, force: true });
}
