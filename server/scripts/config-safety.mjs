// Gate G4: a missing DATABASE_URL is refused with a clear message, and secrets never reach the logs.
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
const work = mkdtempSync(join(tmpdir(), 'memoryz-config-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`go build: ${build.stderr}`);
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATABASE_URL|AUTH_SECRET|OPENROUTER_API_KEY|APP_URL|ENV|PORT|HOST|GOOGLE_CLIENT_SECRET)$/.test(k)));
let checks = 0;
const check = (ok, message) => {
  assert.ok(ok, message);
  checks++;
};
try {
  const missing = spawnSync(bin, ['serve'], { encoding: 'utf8', env: { ...baseEnv, ENV: 'production' } });
  check(missing.status !== 0 && /DATABASE_URL/.test(missing.stderr) && /APP_URL/.test(missing.stderr) && /AUTH_SECRET/.test(missing.stderr), `refused without secrets: ${missing.status} ${missing.stderr}`);
  const badPool = spawnSync(bin, ['serve'], { encoding: 'utf8', env: { ...baseEnv, DATABASE_URL: database.href, DB_POOL_MAX: '0' } });
  check(badPool.status !== 0 && /DB_POOL_MAX/.test(badPool.stderr), 'invalid values are named');

  const port = await new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
  const authSecret = `cfgsafety-${randomBytes(24).toString('hex')}`;
  const apiKey = `sk-or-cfgsafety-${randomBytes(16).toString('hex')}`;
  const clientSecret = `GOCSPX-cfgsafety-${randomBytes(12).toString('hex')}`;
  const child = spawn(bin, ['serve'], {
    env: { ...baseEnv, DATABASE_URL: database.href, ENV: 'development', PORT: String(port), HOST: '127.0.0.1', LOG_FORMAT: 'json', LOG_LEVEL: 'debug', AUTH_SECRET: authSecret, OPENROUTER_API_KEY: apiKey, OPENROUTER_MODEL: 'openai/gpt-5.6-luna', GOOGLE_CLIENT_ID: 'cfgsafety-client', GOOGLE_CLIENT_SECRET: clientSecret, APP_URL: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((done) => child.on('exit', (code) => done(code)));
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false);
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, `server did not start: ${output}`);
  await fetch(`http://127.0.0.1:${port}/api/nope`).catch(() => {});
  child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10_000))]);
  check(code === 0, `clean exit ${code}`);
  const password = decodeURIComponent(database.password);
  for (const secret of [authSecret, apiKey, clientSecret, password, database.href]) check(!output.includes(secret), 'a secret reached the logs');
  check(/"authSecret":"<set>"/.test(output) && /"openRouterApiKey":"<set>"/.test(output) && /"databaseUrl":"<set>"/.test(output) && /"oauthProviders":\["google"\]/.test(output), `redacted config line present: ${output.slice(0, 600)}`);
  console.log(`CONFIG_SAFETY_OK (${checks} checks)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
