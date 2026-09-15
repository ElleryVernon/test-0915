// Gate G3: the server boots against the local database and keeps the basic HTTP contract — health,
// JSON 404s, the CSRF origin rule, body limits, static SPA serving with the right cache headers,
// security headers, gzip, panic recovery and a graceful SIGTERM.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const work = mkdtempSync(join(tmpdir(), 'memoryz-http-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`go build: ${build.stderr}`);
const staticDir = join(work, 'static');
mkdirSync(join(staticDir, '_next', 'static'), { recursive: true });
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html lang="ko"><title>shell</title><div id="app">memoryz shell</div></html>');
writeFileSync(join(staticDir, '_next', 'static', 'chunk.js'), `// chunk\n${'console.log("memoryz chunk");\n'.repeat(80)}`);
writeFileSync(join(staticDir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
writeFileSync(join(staticDir, 'aurora.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
writeFileSync(join(staticDir, 'study.html'), '<!doctype html><title>study</title>prerendered study');

const port = await new Promise((done, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const child = spawn(bin, ['serve'], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'debug', STATIC_DIR: staticDir, APP_URL: base, DEMO_MODE: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));
const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));

// Raw requests keep the wire headers (fetch would transparently decompress).
function raw(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const json = (res) => JSON.parse(res.body.toString('utf8'));
let checks = 0;
const check = (ok, message) => {
  assert.ok(ok, message);
  checks++;
};

try {
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await raw('/api/health').then((r) => r.status === 200, () => false);
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, `server did not become healthy: ${output}`);

  const health = await raw('/api/health');
  check(health.status === 200 && JSON.stringify(json(health)) === '{"data":{"status":"ok","database":"connected","cache":"ok","cacheDriver":"memory"}}', `health ${health.body}`);
  check(health.headers['cache-control'] === 'no-store' && health.headers['x-content-type-options'] === 'nosniff' && /^[a-f0-9]{16}$/.test(health.headers['x-request-id'] ?? ''), `json headers ${JSON.stringify(health.headers)}`);
  check(health.headers['x-frame-options'] === 'DENY' && health.headers['referrer-policy'] === 'strict-origin-when-cross-origin' && /camera=\(self\)/.test(health.headers['permissions-policy'] ?? ''), 'security headers on the API');
  const uploads = await raw('/api/uploads/x');
  check((uploads.status === 401 || uploads.status === 404) && uploads.headers['x-frame-options'] === 'SAMEORIGIN', `uploads may be framed by the app itself (${uploads.status})`);

  const unknown = await raw('/api/nope');
  check(unknown.status === 404 && json(unknown).error === '요청한 기능을 찾을 수 없어요.', `unknown route ${unknown.body}`);
  const wrongMethod = await raw('/api/health', { method: 'POST', headers: { Origin: base } });
  check(wrongMethod.status === 404 && json(wrongMethod).error === '요청한 기능을 찾을 수 없어요.', 'unsupported method is the same 404');
  const evil = await raw('/api/nope', { method: 'POST', headers: { Origin: 'https://evil.example' } });
  check(evil.status === 403 && json(evil).error === '허용되지 않은 요청 출처예요.', `foreign origin ${evil.body}`);
  const crossSite = await raw('/api/nope', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  check(crossSite.status === 403, 'cross-site fetch refused');
  const sameOrigin = await raw('/api/nope', { method: 'POST', headers: { Origin: base } });
  check(sameOrigin.status === 404, 'own origin passes the CSRF rule');
  const badOrigin = await raw('/api/nope', { method: 'POST', headers: { Origin: 'not a url' } });
  check(badOrigin.status === 403, 'unparseable origin refused');

  const big = Buffer.alloc(3_100_000, 'a');
  const tooLarge = await raw('/api/_dev/echo', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'Content-Length': String(big.length) }, body: big });
  check(tooLarge.status === 413 && json(tooLarge).error === '입력 내용이 너무 커요.', `oversized body ${tooLarge.status}`);
  const badJson = await raw('/api/_dev/echo', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{nope' });
  check(badJson.status === 400 && json(badJson).error === '요청 내용을 읽을 수 없어요.', 'malformed JSON');
  const payload = JSON.stringify({ text: 'x'.repeat(2048), n: 1 });
  const echoed = await raw('/api/_dev/echo', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' }, body: payload });
  check(echoed.status === 200 && echoed.headers['content-encoding'] === 'gzip' && /Accept-Encoding/.test(echoed.headers.vary ?? ''), `json gzip ${echoed.headers['content-encoding']}`);
  const plain = await raw('/api/_dev/echo', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: payload });
  check(plain.status === 200 && plain.headers['content-encoding'] === undefined && json(plain).data.n === 1, 'no gzip without Accept-Encoding');
  check((await raw('/api/health', { headers: { 'Accept-Encoding': 'gzip' } })).headers['content-encoding'] === undefined, 'tiny responses stay uncompressed');
  const panicked = await raw('/api/_dev/panic');
  check(panicked.status === 500 && json(panicked).error === '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', 'panic becomes the generic 500');

  const home = await raw('/');
  check(home.status === 200 && /memoryz shell/.test(home.body.toString()) && home.headers['cache-control'] === 'no-cache' && /text\/html/.test(home.headers['content-type']), `index ${home.status} ${home.headers['cache-control']}`);
  const deep = await raw('/subjects/abc?x=1');
  check(deep.status === 200 && /memoryz shell/.test(deep.body.toString()) && deep.headers['cache-control'] === 'no-cache', 'deep link serves the shell');
  const prerendered = await raw('/study');
  check(prerendered.status === 200 && /prerendered study/.test(prerendered.body.toString()), 'exported route html is preferred');
  const chunk = await raw('/_next/static/chunk.js', { headers: { 'Accept-Encoding': 'gzip' } });
  check(chunk.status === 200 && chunk.headers['cache-control'] === 'public, max-age=31536000, immutable' && chunk.headers['content-encoding'] === 'gzip', `chunk ${chunk.headers['cache-control']} ${chunk.headers['content-encoding']}`);
  const sw = await raw('/sw.js');
  check(sw.status === 200 && sw.headers['cache-control'] === 'no-cache, no-store, must-revalidate', `sw ${sw.headers['cache-control']}`);
  const svg = await raw('/aurora.svg');
  check(svg.status === 200 && /image\/svg\+xml/.test(svg.headers['content-type']) && /max-age=3600/.test(svg.headers['cache-control']), 'asset served with a short cache');
  check((await raw('/missing.png')).status === 404, 'missing asset is a 404, not the shell');
  check((await raw('/..%2f..%2fetc/passwd')).status !== 200 || /memoryz shell/.test((await raw('/..%2f..%2fetc/passwd')).body.toString()), 'path traversal never leaves the static dir');
  check(home.headers['x-frame-options'] === 'DENY' && home.headers['x-content-type-options'] === 'nosniff', 'security headers on static files');

  // Graceful shutdown: a request in flight finishes, then the process exits cleanly.
  const slow = raw('/api/_dev/slow?ms=1500');
  await new Promise((r) => setTimeout(r, 200));
  const sent = Date.now();
  child.kill('SIGTERM');
  const slowRes = await slow;
  check(slowRes.status === 200 && json(slowRes).data.sleptMs === 1500, `in-flight request finished (${slowRes.status})`);
  const exit = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 10_000))]);
  check(exit.code === 0 && Date.now() - sent < 10_000, `clean exit after SIGTERM: ${JSON.stringify(exit)}`);
  check(/"message":"stopped"/.test(output) && /"message":"request"/.test(output) && /"severity":"INFO"/.test(output), 'structured logs with Cloud Logging keys');
  console.log(`FOUNDATION_HTTP_OK (${checks} checks)`);
} catch (error) {
  console.error(error);
  console.error('--- server output ---');
  console.error(output.slice(-4000));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
}
