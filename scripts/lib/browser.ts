// Shared browser-evidence plumbing for capture scripts: serve the tree's own `.next` build on a free
// loopback port, drive headless Chrome over the DevTools protocol (no extra packages), and clean up.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Serves the current build. `env` overrides win over `.env` (Next never replaces a defined variable). */
export async function serveBuild(env: Record<string, string> = {}): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const server: ChildProcess = spawn('node_modules/.bin/next', ['start', '--hostname', '127.0.0.1', '--port', String(port)], {
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (server.exitCode !== null) return;
    const stopped = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await stopped;
  };
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('next start exited before it was ready');
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) return { url, stop };
    await new Promise((r) => setTimeout(r, 200));
  }
  await stop();
  throw new Error('next start was not ready in 20s');
}

export class Cdp {
  private id = 0;
  private pending = new Map<number, (message: any) => void>();
  private listeners: ((message: any) => void)[] = [];
  readonly events: any[] = [];
  constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const done = message.id ? this.pending.get(message.id) : undefined;
      if (done) {
        this.pending.delete(message.id);
        done(message);
      } else {
        this.events.push(message);
        for (const listener of this.listeners) listener(message);
      }
    };
  }
  on(listener: (message: any) => void) {
    this.listeners.push(listener);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

export async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'memoryz-cdp-'));
  const proc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--lang=ko-KR',
    'about:blank',
  ]);
  const url = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    proc.stderr.on('data', (chunk) => {
      buffer += String(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match) resolve(match[1]);
    });
    proc.on('exit', () => reject(new Error('chrome exited before DevTools was ready')));
  });
  const ws = new WebSocket(url);
  await new Promise((resolve) => (ws.onopen = resolve));
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  return {
    cdp: new Cdp(ws),
    close: async () => {
      ws.close();
      proc.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** One page target with small helpers; every helper throws with the selector it waited for. */
export async function openPage(cdp: Cdp, { width, height, cookie }: { width: number; height: number; cookie: { name: string; value: string } }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method: string, params: object = {}) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  await send('Network.setCookie', { ...cookie, domain: '127.0.0.1', path: '/', httpOnly: true });
  const evaluate = async (expression: string) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`evaluate: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text} · ${expression.slice(0, 120)}`);
    return result.result.value;
  };
  const waitUntil = async (expression: string, label: string, timeout = 10000) => {
    for (const end = Date.now() + timeout; Date.now() < end; ) {
      if (await evaluate(`!!(${expression})`)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  const waitFor = (selector: string, timeout?: number) => waitUntil(`document.querySelector(${JSON.stringify(selector)})`, selector, timeout);
  const click = (selector: string, text?: string) =>
    evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('missing ${selector.replace(/'/g, '')} ${(text ?? '').replace(/'/g, '')}'); el.click(); return true; })()`);
  const shot = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  return { send, evaluate, waitUntil, waitFor, click, shot };
}

export function consoleErrors(cdp: Cdp, ignore: RegExp[] = []) {
  return cdp.events
    .filter(
      (e) =>
        (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) ||
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'),
    )
    .map((e) => JSON.stringify(e.params).slice(0, 300))
    .filter((line) => !ignore.some((pattern) => pattern.test(line)));
}

export function assertLoopbackDatabase() {
  const database = new URL(process.env.DATABASE_URL!);
  assert(database.port === '15444' && database.pathname === '/memoryz', 'dedicated local database only');
}
