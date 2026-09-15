// Gate H5: the Go server's GET /api/bootstrap equals the previous TypeScript server's for the same
// demo student and demo parent on the same local database. The TS server is the existing .next
// build started with `next start`; the Go server is built from source. New fields the Go server
// adds (contentLength, excerpt, contentHash) are removed before the deep comparison. The Go answer
// must also carry an ETag and answer 304 to If-None-Match. Demo data is read, never written
// (apart from two temporary sessions).
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
async function waitFor(base, output) {
  for (let i = 0; i < 150; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start at ${base}: ${output()}`);
}
function launch(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  return { child, output: () => output.slice(-2000) };
}
const work = mkdtempSync(join(tmpdir(), 'memoryz-parity-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`go build: ${build.stderr}`);
const [goPort, tsPort] = [await freePort(), await freePort()];
const goBase = `http://127.0.0.1:${goPort}`;
const tsBase = `http://127.0.0.1:${tsPort}`;
const go = launch(bin, ['serve'], { ...process.env, PORT: String(goPort), HOST: '127.0.0.1', ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'warn', APP_URL: goBase, DEMO_MODE: 'true', AUTH_SECRET: randomBytes(24).toString('hex'), STATIC_DIR: '' });
const ts = launch('node_modules/.bin/next', ['start', '--hostname', '127.0.0.1', '--port', String(tsPort)], { ...process.env, DEMO_MODE: 'true' });
const client = new pg.Client({ connectionString: database.href });
await client.connect();
const sessions = [];
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sessionFor = async (userId) => {
  const token = randomBytes(32).toString('hex');
  await client.query(`INSERT INTO "Session" ("id", "userId", "expiresAt") VALUES ($1, $2, now() + interval '1 hour')`, [sha(token), userId]);
  sessions.push(sha(token));
  return `memoryz_session=${token}`;
};
const strip = (value) => {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!['contentLength', 'excerpt', 'contentHash'].includes(k)) out[k] = strip(v);
    return out;
  }
  return value;
};
let verdict = 'BOOTSTRAP_PARITY_FAILED';
try {
  await waitFor(goBase, go.output);
  await waitFor(tsBase, ts.output);
  // Make sure the demo accounts exist (the Go server seeds them on first demo sign-in).
  const seeded = await fetch(`${goBase}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: goBase }, body: JSON.stringify({ role: 'STUDENT' }) });
  assert.equal(seeded.status, 200, 'demo sign-in on the Go server');
  const seededCookie = seeded.headers.getSetCookie().find((c) => c.startsWith('memoryz_session='));
  if (seededCookie) sessions.push(sha(seededCookie.split(';')[0].slice('memoryz_session='.length)));
  const report = [];
  for (const [label, userId] of [['student', 'demo-student'], ['parent', 'demo-parent']]) {
    const cookie = await sessionFor(userId);
    const [goRes, tsRes] = await Promise.all([
      fetch(`${goBase}/api/bootstrap`, { headers: { cookie } }),
      fetch(`${tsBase}/api/bootstrap`, { headers: { cookie } }),
    ]);
    assert.equal(goRes.status, 200, `go bootstrap ${label}`);
    assert.equal(tsRes.status, 200, `ts bootstrap ${label}`);
    const goBody = await goRes.json();
    const tsBody = await tsRes.json();
    const goData = strip(goBody.data);
    const tsData = strip(tsBody.data);
    try {
      assert.deepEqual(goData, tsData, `${label} bootstrap differs`);
    } catch (error) {
      for (const key of Object.keys(tsData)) {
        if (JSON.stringify(goData[key]) !== JSON.stringify(tsData[key])) console.log(`${label}.${key} differs\n  go: ${JSON.stringify(goData[key]).slice(0, 600)}\n  ts: ${JSON.stringify(tsData[key]).slice(0, 600)}`);
      }
      throw error;
    }
    const etag = goRes.headers.get('etag');
    const again = await fetch(`${goBase}/api/bootstrap`, { headers: { cookie, 'If-None-Match': etag } });
    assert.ok(etag && again.status === 304, `${label}: ETag ${etag} → ${again.status}`);
    report.push(`${label}: ${Object.keys(tsData).length} keys equal, ${JSON.stringify(tsBody).length} bytes (ts) vs ${JSON.stringify(goBody).length} bytes (go incl. summaries), materials ${tsData.materials.length}, cards ${tsData.cards.length}, posts ${tsData.posts.length}, 304 ok`);
  }
  console.log(report.join('\n'));
  verdict = 'BOOTSTRAP_PARITY_OK';
} catch (error) {
  console.error(error);
  console.error(`--- go log ---\n${go.output()}\n--- ts log ---\n${ts.output()}`);
} finally {
  for (const id of sessions) await client.query(`DELETE FROM "Session" WHERE "id" = $1`, [id]);
  await client.end();
  for (const p of [go, ts]) {
    if (p.child.exitCode === null) {
      p.child.kill('SIGTERM');
      await Promise.race([new Promise((r) => p.child.once('exit', r)), new Promise((r) => setTimeout(r, 10_000))]);
      if (p.child.exitCode === null) p.child.kill('SIGKILL');
    }
  }
  rmSync(work, { recursive: true, force: true });
}
console.log(verdict);
process.exit(verdict === 'BOOTSTRAP_PARITY_OK' ? 0 : 1);
