// Local production run on :3000 — what `npm run start` does now that the web is a static build
// served by the Go server: build the Go binary, build and precompress the web (`out/`), then serve
// both from one process on http://127.0.0.1:3000 against the dedicated local database.
// Flags: --no-web (reuse out/), --no-go (reuse the last binary), --port <n>, --detach (background,
// pid in .data/local-server.pid, log in .data/local-server.log).
import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const port = Number(args[args.indexOf('--port') + 1]) || 3000;
const root = resolve('.');
const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`${cmd} ${argv.join(' ')} failed`);
    process.exit(r.status ?? 1);
  }
};
mkdirSync(join(root, '.data'), { recursive: true });
const bin = join(root, '.data', 'memoryz-server');
if (!flag('--no-go') || !existsSync(bin)) run('go', ['build', '-o', bin, './cmd/server'], { cwd: join(root, 'server') });
if (!flag('--no-web') || !existsSync(join(root, 'out', 'index.html'))) {
  run('node_modules/.bin/next', ['build']);
  run('node', ['scripts/precompress.mjs', 'out']);
}
const env = {
  ...process.env,
  ENV: 'development',
  HOST: '127.0.0.1',
  PORT: String(port),
  APP_URL: `http://127.0.0.1:${port}`,
  STATIC_DIR: join(root, 'out'),
  DEMO_MODE: process.env.DEMO_MODE ?? 'true',
  LOG_FORMAT: process.env.LOG_FORMAT ?? 'text',
};
if (flag('--detach')) {
  const log = openSync(join(root, '.data', 'local-server.log'), 'a');
  const child = spawn(bin, ['serve'], { env, detached: true, stdio: ['ignore', log, log] });
  writeFileSync(join(root, '.data', 'local-server.pid'), String(child.pid));
  child.unref();
  console.log(`memoryz server started on http://127.0.0.1:${port} (pid ${child.pid}, log .data/local-server.log)`);
} else {
  const child = spawn(bin, ['serve'], { env, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}
