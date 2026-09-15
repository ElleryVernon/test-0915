// Gate leaf-2.1 W3: the development setup — `next dev` in front, the Go server behind, joined by
// the /api rewrite in next.config.ts. Starts both on free ports, checks that API answers, cookies
// and the shell all pass through Next, then stops both.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
const waitFor = async (url, child, label) => {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(`${label} exited early`);
    if (await fetch(url).then((r) => r.status < 500, () => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${label} not ready in 60s`);
};
let checks = 0;
const check = (ok, message) => {
  assert.ok(ok, message);
  checks++;
};

const work = mkdtempSync(join(tmpdir(), 'memoryz-devproxy-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(build.stderr);
const goPort = await freePort();
const nextPort = await freePort();
const goURL = `http://127.0.0.1:${goPort}`;
const nextURL = `http://127.0.0.1:${nextPort}`;
const distDir = join(work, 'next-dist');
const go = spawn(bin, ['serve'], {
  // APP_URL is the browser origin (Next's), so the CSRF rule accepts requests that come through the proxy.
  env: { ...process.env, OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '', ENV: 'development', HOST: '127.0.0.1', PORT: String(goPort), APP_URL: nextURL, DEMO_MODE: 'true', LOG_FORMAT: 'json', LOG_LEVEL: 'warn', AUTH_SECRET: randomBytes(24).toString('hex') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let goOut = '';
go.stdout.on('data', (d) => (goOut += d));
go.stderr.on('data', (d) => (goOut += d));
const next = spawn('node_modules/.bin/next', ['dev', '--hostname', '127.0.0.1', '--port', String(nextPort)], {
  env: { ...process.env, GO_API_URL: goURL, NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let nextOut = '';
next.stdout.on('data', (d) => (nextOut += d));
next.stderr.on('data', (d) => (nextOut += d));
try {
  await waitFor(`${goURL}/api/health`, go, 'go server');
  await waitFor(`${nextURL}/`, next, 'next dev');
  const health = await fetch(`${nextURL}/api/health`).then((r) => r.json());
  check(health.data?.cacheDriver, `health through next is the Go answer: ${JSON.stringify(health)}`);
  const login = await fetch(`${nextURL}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: nextURL }, body: JSON.stringify({ role: 'STUDENT' }) });
  const cookie = login.headers.get('set-cookie') ?? '';
  check(login.status === 200 && /^memoryz_session=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\//.test(cookie), `login through next sets the cookie (${login.status} ${cookie.slice(0, 40)})`);
  const boot = await fetch(`${nextURL}/api/bootstrap`, { headers: { cookie: cookie.split(';')[0] } });
  check(boot.status === 200 && boot.headers.get('x-cache') && (await boot.json()).data.profile.id === 'demo-student', `bootstrap through next ${boot.status}`);
  const shell = await fetch(`${nextURL}/study`);
  const html = await shell.text();
  check(shell.status === 200 && /text\/html/.test(shell.headers.get('content-type') ?? '') && /__next|id="app"/.test(html), `dev shell for /study ${shell.status}`);
  const missing = await fetch(`${nextURL}/api/does-not-exist`);
  check(missing.status === 404 && /application\/json/.test(missing.headers.get('content-type') ?? ''), `unknown api path is Go's 404 (${missing.status})`);
  console.log(`DEV_PROXY_OK (${checks} checks)`);
} catch (error) {
  console.error(error);
  console.error(`--- next (tail) ---\n${nextOut.slice(-2000)}\n--- go (tail) ---\n${goOut.slice(-2000)}`);
  process.exitCode = 1;
} finally {
  for (const child of [next, go]) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 8000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  rmSync(work, { recursive: true, force: true });
}
