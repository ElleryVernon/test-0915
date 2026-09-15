// Development API: runs the Go server on :8080 with the repository .env (dedicated local database),
// demo mode and the browser origin of `next dev` (:3000) as APP_URL so the CSRF rule accepts
// requests that arrive through Next's /api rewrite. Usage: npm run dev:api [-- --port 8080]
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8080;
const webPort = Number(args[args.indexOf('--web-port') + 1]) || 3000;
const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const env = {
  ...process.env,
  ENV: 'development',
  HOST: '127.0.0.1',
  PORT: String(port),
  APP_URL: `http://127.0.0.1:${webPort}`,
  DEMO_MODE: process.env.DEMO_MODE ?? 'true',
  LOG_FORMAT: process.env.LOG_FORMAT ?? 'text',
};
const child = spawn('go', ['run', './cmd/server', 'serve'], { cwd: resolve('server'), env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
