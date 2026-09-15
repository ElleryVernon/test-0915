// Runs one shell command against a freshly built Go server on a free loopback port, with
// TEST_APP_URL pointing at it, then stops the server and exits with the command's status.
// Environment: the repository .env supplies DATABASE_URL (dedicated local database only); the
// caller may override anything the server reads (OPENROUTER_API_KEY=, OPENROUTER_BASE_URL=…).
// Usage: node server/scripts/serve.mjs "<command>"
import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const command = process.argv[2];
if (!command) {
  console.error('usage: node server/scripts/serve.mjs "<command>"');
  process.exit(2);
}
const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const work = mkdtempSync(join(tmpdir(), 'memoryz-serve-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stderr);
  process.exit(1);
}
const port = await new Promise((done, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});
const url = `http://127.0.0.1:${port}`;
// A production server always fronts the web build; a minimal shell keeps the HTML role gate in play.
const staticDir = join(work, 'static');
mkdirSync(staticDir);
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html lang="ko"><title>memoryz</title><div id="app">memoryz shell</div></html>');
// Verification never spends money: the AI key is dropped unless ALLOW_PAID_AI=1 is set on purpose.
const safeEnv = { ...process.env };
if (process.env.ALLOW_PAID_AI !== '1') {
  safeEnv.OPENROUTER_API_KEY = '';
  safeEnv.OPENROUTER_MODEL = safeEnv.OPENROUTER_MODEL ?? '';
}
const env = {
  STATIC_DIR: staticDir,
  ENV: 'development',
  LOG_FORMAT: 'json',
  LOG_LEVEL: 'warn',
  DEMO_MODE: 'true',
  AUTH_SECRET: randomBytes(24).toString('hex'),
  ...safeEnv,
  PORT: String(port),
  HOST: '127.0.0.1',
  APP_URL: url,
};
const server = spawn(bin, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', (d) => (output += d));
server.stderr.on('data', (d) => (output += d));
let status = 1;
try {
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (server.exitCode !== null) throw new Error(`server exited before it was ready: ${output}`);
    ready = await fetch(`${url}/api/health`).then((r) => r.ok, () => false);
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error(`server was not ready in 20s: ${output}`);
  console.log(`serving the Go server at ${url}`);
  status = spawnSync(command, { shell: true, stdio: 'inherit', env: { ...safeEnv, TEST_APP_URL: url } }).status ?? 1;
} catch (error) {
  console.error(error);
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 10_000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (status !== 0) console.error(`--- server log (tail) ---\n${output.slice(-3000)}`);
  rmSync(work, { recursive: true, force: true });
}
process.exit(status);
