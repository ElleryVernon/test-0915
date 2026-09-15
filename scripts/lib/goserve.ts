// Serves the static web build (`out/`) with the Go server on a free loopback port — the production
// shape — for browser and HTTP checks. Demo mode, AI key emptied, dedicated local database only.
import 'dotenv/config';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export async function freePort() {
  return new Promise<number>((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

export type GoServer = { url: string; port: number; stop: () => Promise<void>; output: () => string; env: Record<string, string> };

/** Builds server/cmd/server and runs it with STATIC_DIR pointing at the web build. */
export async function serveStatic(options: { staticDir?: string; env?: Record<string, string> } = {}): Promise<GoServer> {
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
    throw new Error('dedicated local database only');
  const staticDir = resolve(options.staticDir ?? 'out');
  if (!existsSync(join(staticDir, 'index.html'))) throw new Error(`${staticDir}/index.html is missing — run next build first`);
  const work = mkdtempSync(join(tmpdir(), 'memoryz-goserve-'));
  const bin = join(work, 'server');
  const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`go build: ${build.stderr}`);
  // A caller may pin the port (a check that restarts the server the page is already talking to).
  const port = options.env?.PORT ? Number(options.env.PORT) : await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    OPENROUTER_API_KEY: '',
    OPENROUTER_MODEL: '',
    ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_URL: url,
    STATIC_DIR: staticDir,
    DEMO_MODE: 'true',
    LOG_FORMAT: 'json',
    LOG_LEVEL: 'warn',
    AUTH_SECRET: randomBytes(24).toString('hex'),
    ...options.env,
  };
  const child: ChildProcess = spawn(bin, ['serve'], { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(work, { recursive: true, force: true });
  };
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`go server exited before it was ready:\n${output}`);
    }
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) return { url, port, stop, output: () => output, env };
    await new Promise((r) => setTimeout(r, 200));
  }
  await stop();
  throw new Error(`go server was not ready in 20s:\n${output}`);
}

/** Demo login through the API; returns the bare cookie pair. */
export async function demoLogin(url: string, role: 'STUDENT' | 'PARENT' | 'ADMIN') {
  const res = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify({ role }) });
  if (res.status !== 200) throw new Error(`demo login ${role}: ${res.status} ${await res.text()}`);
  const match = /memoryz_session=([a-f0-9]{64})/.exec(res.headers.get('set-cookie') ?? '');
  if (!match) throw new Error('no session cookie');
  return { name: 'memoryz_session', value: match[1], header: `memoryz_session=${match[1]}` };
}
