// Gate K3: OpenTelemetry end to end in development. The server runs with the stdout exporter and
// JSON logs; one traced bootstrap request must produce a server span (named by route), pgx query
// spans as its children in the same trace, and a request log line carrying that trace id. The
// production validation must refuse the Cloud Trace exporter without a project.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const work = mkdtempSync(join(tmpdir(), 'memoryz-otel-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`go build: ${build.stderr}`);
const staticDir = join(work, 'static');
mkdirSync(staticDir);
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>shell</title><div>memoryz shell</div>');

let checks = 0;
const check = (ok, message) => {
  assert.ok(ok, message);
  checks++;
};
const port = await new Promise((done, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '',
  PORT: String(port), HOST: '127.0.0.1', ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'info', DEMO_MODE: 'true',
  STATIC_DIR: staticDir, APP_URL: base, AUTH_SECRET: randomBytes(24).toString('hex'), OTEL_EXPORTER: 'stdout',
};
const server = spawn(bin, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
server.stdout.on('data', (d) => (output += d));
server.stderr.on('data', (d) => (output += d));
try {
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (server.exitCode !== null) throw new Error(`server exited: ${output}`);
    ready = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error(`server not ready: ${output}`);
  const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ role: 'STUDENT' }) });
  check(login.status === 200, `login ${login.status}`);
  const cookie = `memoryz_session=${/memoryz_session=([a-f0-9]{64})/.exec(login.headers.get('set-cookie'))[1]}`;
  // The browser (or the load balancer) starts the trace; the server continues it.
  const traceId = randomBytes(16).toString('hex');
  const res = await fetch(`${base}/api/bootstrap`, { headers: { cookie, traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01` } });
  check(res.status === 200, `bootstrap ${res.status}`);
  // Cloud Run's front end forwards most requests as "not sampled" (its own rate limit); they must still be traced.
  const forwardedTrace = randomBytes(16).toString('hex');
  const me = await fetch(`${base}/api/me`, { headers: { cookie, traceparent: `00-${forwardedTrace}-${randomBytes(8).toString('hex')}-00` } });
  check(me.status === 200, `me ${me.status}`);
  const live =await fetch(`${base}/api/live`, { headers: { 'user-agent': 'telemetry-check learner agent', 'x-forwarded-for': '203.0.113.99' } });
  check(live.status === 200, `liveness ${live.status}`);
  const stopped = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM'); // shutdown flushes the batch span processor
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 10_000))]);

  const records = output.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const spans = records.filter((r) => r.SpanContext && r.Name);
  const serverSpan = spans.find((s) => s.Name === 'GET /api/bootstrap');
  check(serverSpan, `server span named by route (${spans.map((s) => s.Name).join(', ')})`);
  check(serverSpan.SpanContext.TraceID === traceId && serverSpan.Parent.Remote === true, `the incoming traceparent is continued (${serverSpan.SpanContext.TraceID})`);
  check(serverSpan.Attributes.some((a) => a.Key === 'http.response.status_code' && a.Value.Value === 200), 'server span carries the status code');
  const forwarded = spans.find((s) => s.Name === 'GET /api/me');
  check(forwarded && forwarded.SpanContext.TraceID === forwardedTrace && forwarded.Parent.Remote === true, `a request forwarded as not sampled is still traced in its trace (${forwarded?.SpanContext.TraceID ?? 'no span'})`);
  const byID = new Map(spans.map((s) => [s.SpanContext.SpanID, s]));
  const descends = (s) => {
    for (let p = byID.get(s.Parent.SpanID); p; p = byID.get(p.Parent.SpanID)) if (p === serverSpan) return true;
    return false;
  };
  // Query spans hang directly off the server span; a prepare span hangs off its query.
  const pgxSpans = spans.filter((s) => s.InstrumentationScope?.Name === 'github.com/exaring/otelpgx' && s.SpanContext.TraceID === traceId);
  const querySpans = pgxSpans.filter((s) => s.Parent.SpanID === serverSpan.SpanContext.SpanID);
  check(querySpans.length >= 10 && pgxSpans.every(descends), `pgx query spans descend from the server span (${querySpans.length} direct of ${pgxSpans.length}; parents: ${[...new Set(pgxSpans.map((s) => byID.get(s.Parent.SpanID)?.Name ?? 'none'))].join(', ')})`);
  check(querySpans.some((s) => /Subject/.test(s.Name)) && querySpans.every((s) => s.Attributes.some((a) => a.Key === 'db.system' || a.Key === 'db.system.name')), `query spans are named by their statement (${querySpans.slice(0, 3).map((s) => s.Name).join(' | ')})`);
  const requestLog = records.find((r) => r.message === 'request' && r.path === '/api/bootstrap');
  check(requestLog && requestLog.traceId === traceId && requestLog['logging.googleapis.com/spanId'] === serverSpan.SpanContext.SpanID, `request log carries the trace and span ids ${JSON.stringify(requestLog)}`);
  const sessionSpan = spans.find((s) => s.Name === 'POST /api/session');
  check(sessionSpan && sessionSpan.SpanContext.TraceID !== traceId, 'an untraced request starts its own trace');
  check(!spans.some((s) => s.Name === 'GET /api/health' || s.Name === 'GET /api/live'), 'health and liveness probes are not traced');
  // Spans keep counts about the client, never its address or agent (telemetry.Redact).
  check(!spans.some((s) => (s.Attributes ?? []).some((a) => ['client.address', 'network.peer.address', 'user_agent.original'].includes(a.Key))), 'no span carries a client address or user agent');
  const metrics = records.filter((r) => r.Resource && r.ScopeMetrics);
  const names = new Set(metrics.flatMap((m) => m.ScopeMetrics.flatMap((s) => s.Metrics.map((x) => x.Name))));
  check(names.has('memoryz.cache.requests') && names.has('memoryz.db.pool.connections') && names.has('http.server.request.duration'), `metrics exported (${[...names].join(', ')})`);

  // Production validation: the Cloud Trace exporter needs a project.
  const bad = spawnSync(bin, ['serve'], { encoding: 'utf8', env: { PATH: process.env.PATH, ENV: 'production', OTEL_EXPORTER: 'gcp', APP_URL: 'https://memoryz.example', AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' } });
  check(bad.status === 1 && /GOOGLE_CLOUD_PROJECT is required with OTEL_EXPORTER=gcp/.test(bad.stderr), `production refuses gcp without a project: ${bad.status} ${bad.stderr.trim()}`);
  const badRatio = spawnSync(bin, ['serve'], { encoding: 'utf8', env: { PATH: process.env.PATH, ENV: 'development', OTEL_SAMPLE_RATIO: '2', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' } });
  check(badRatio.status === 1 && /OTEL_SAMPLE_RATIO/.test(badRatio.stderr), 'an impossible sample ratio is refused');
  console.log(`TELEMETRY_OK (${checks} checks)`);
} catch (error) {
  console.error(error);
  console.error(`--- server output (tail) ---\n${output.slice(-4000)}`);
  process.exitCode = 1;
} finally {
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
}
