// Gate leaf-3.2 J4 / leaf-3.3 O2: the deployed Cloud Run service, over HTTPS, as a real client.
// Reads the URL from the service, uses the demo student (demo mode is on in the PoC), never calls
// the paid model (only checks aiAvailable). --oauth checks the Google sign-in entry points.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import dns from 'node:dns';

const PROJECT = 'memoryz-prod';
const REGION = 'asia-northeast3';
const env = { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: 'memoryz' };
const gcloud = (...a) => execFileSync('gcloud', [...a, `--project=${PROJECT}`], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// The origin learners use: the service's APP_URL (the custom domain after the cutover), else run.app.
const service = JSON.parse(gcloud('run', 'services', 'describe', 'memoryz', `--region=${REGION}`, '--format=json'));
const runUrl = service.status.url;
const appUrl = (service.spec.template.spec.containers[0].env ?? []).find((e) => e.name === 'APP_URL')?.value;
const url = process.env.CLOUD_URL ?? appUrl ?? runUrl;
// After a DNS change an operator's resolver may keep the old answer for up to the parent TTL (1 day
// for .kr). The smoke measures what the public sees: the origin's host resolves through public DNS.
const originHost = new URL(url).host;
if (!originHost.endsWith('.run.app')) {
  const resolver = new dns.promises.Resolver();
  resolver.setServers(['8.8.8.8', '1.1.1.1']);
  const [publicIp] = await resolver.resolve4(originHost);
  const system = dns.lookup;
  dns.lookup = (host, options, cb) => {
    if (typeof options === 'function') [cb, options] = [options, {}];
    if (host !== originHost) return system(host, options, cb);
    return options?.all ? cb(null, [{ address: publicIp, family: 4 }]) : cb(null, publicIp, 4);
  };
  console.log(`resolving ${originHost} through public DNS: ${publicIp}`);
}
const oauth = process.argv.includes('--oauth');
let checks = 0;
const check = (ok, message) => {
  assert.ok(ok, message);
  checks++;
};
const get = (path, init = {}) => fetch(url + path, { redirect: 'manual', ...init });
const cookieOf = (res) => /memoryz_session=([a-f0-9]{64})/.exec(res.headers.get('set-cookie') ?? '')?.[1];

if (oauth) {
  const config = await (await get('/api/config')).json();
  check(config.data.providers.includes('google'), `google is a configured provider: ${JSON.stringify(config.data.providers)}`);
  const start = await get('/api/auth/google?role=STUDENT');
  const location = start.headers.get('location') ?? '';
  const target = location ? new URL(location) : null;
  check(start.status === 302 && target?.host === 'accounts.google.com', `sign-in starts at Google (${start.status} ${target?.host})`);
  check(target?.searchParams.get('redirect_uri') === `${url}/api/auth/google/callback`, `redirect_uri is the service callback (${target?.searchParams.get('redirect_uri')})`);
  check(target?.searchParams.get('code_challenge_method') === 'S256' && (target?.searchParams.get('scope') ?? '').split(' ').includes('openid'), 'PKCE S256 with openid scope');
  const stateCookie = start.headers.get('set-cookie') ?? '';
  check(/memoryz_oauth=/.test(stateCookie) && /HttpOnly/.test(stateCookie) && /Secure/.test(stateCookie), 'state cookie is HttpOnly and Secure');
  const bad = await get('/api/auth/google/callback?state=bogus&code=bogus');
  check(bad.status === 400 || bad.status === 403, `a forged callback is refused (${bad.status})`);
  console.log(`CLOUD_OAUTH_OK (${checks} checks)`);
} else {
  const health = await get('/api/health');
  const body = await health.json();
  check(health.status === 200 && body.data.database === 'connected' && body.data.cache === 'ok' && /^valkey:/.test(body.data.cacheDriver), `health ${JSON.stringify(body)}`);
  const shell = await get('/', { headers: { 'accept-encoding': 'br' } });
  const html = await shell.text();
  check(shell.status === 200 && /text\/html/.test(shell.headers.get('content-type') ?? '') && /\/_next\/static\//.test(html) && shell.headers.get('etag'), 'shell with ETag');
  const study = await get('/study');
  check(study.status === 200 && /text\/html/.test(study.headers.get('content-type') ?? ''), '/study document');
  check(shell.headers.get('x-content-type-options') === 'nosniff' && shell.headers.get('x-frame-options') === 'DENY' && shell.headers.get('strict-transport-security') !== null, `security headers (hsts=${shell.headers.get('strict-transport-security')})`);
  const chunk = /\/_next\/static\/[^"]+\.js/.exec(html)?.[0];
  const asset = await get(chunk, { headers: { 'accept-encoding': 'br' } });
  check(asset.status === 200 && asset.headers.get('content-encoding') === 'br' && /immutable/.test(asset.headers.get('cache-control') ?? ''), `hashed asset brotli + immutable (${asset.headers.get('content-encoding')})`);
  // The sign-in rate limit is keyed by the client address. A forged first X-Forwarded-For entry rides
  // along; the server must take the entry the platform appended (behind the load balancer: the one
  // before the balancer's own address), which its span reports as counts only (hop, entries).
  const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const loginTrace = hex(16);
  const behindLB = !originHost.endsWith('.run.app');
  const login = await get('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: url, traceparent: `00-${loginTrace}-${'b'.repeat(16)}-01`, 'x-forwarded-for': '203.0.113.77' }, body: JSON.stringify({ role: 'STUDENT' }) });
  const token = cookieOf(login);
  check(login.status === 200 && token && /Secure/.test(login.headers.get('set-cookie') ?? ''), `demo login sets a Secure cookie (${login.status})`);
  const cookie = `memoryz_session=${token}`;
  const traceId = hex(16);
  const boot1 = await get('/api/bootstrap', { headers: { cookie, traceparent: `00-${traceId}-${'a'.repeat(16)}-01` } });
  const boot2 = await get('/api/bootstrap', { headers: { cookie } });
  const boot3 = await get('/api/bootstrap', { headers: { cookie, 'if-none-match': boot1.headers.get('etag') } });
  const data = (await boot1.json()).data;
  // The first read is a miss or a hit depending on the last minute's traffic on the shared demo
  // account (60 s TTL); what must hold is that a repeat is served from Valkey and revalidates to 304.
  const first = boot1.headers.get('x-cache');
  check(boot1.status === 200 && ['miss', 'hit'].includes(first) && boot2.headers.get('x-cache') === 'hit' && boot3.status === 304, `bootstrap ${first}→hit→304 (${first} ${boot2.headers.get('x-cache')} ${boot3.status})`);
  check(data.profile.id === 'demo-student' && data.materials.length > 0 && !('content' in data.materials[0]) && data.aiAvailable === true, 'demo data, lazy materials, AI available (not called)');
  const material = data.materials.find((m) => m.uploadId) ?? data.materials[0];
  const detail = await get(`/api/materials/${material.id}`, { headers: { cookie } });
  const detailBody = await detail.json();
  check(detail.status === 200 && typeof detailBody.data.content === 'string' && detailBody.data.contentHash === material.contentHash, 'material detail');
  if (material.uploadId) {
    const file = await get(`/api/uploads/${material.uploadId}`, { headers: { cookie } });
    check(file.status === 200 && Number(file.headers.get('content-length')) > 1000, `upload bytes from GCS (${file.status})`);
  }
  const requestId = boot1.headers.get('x-request-id');
  check(!!requestId, 'request id header');
  // Logging and tracing: the request must be visible in Cloud Logging with its trace id, and the trace in Cloud Trace.
  let logged = null;
  let traced = null;
  let loginTraced = null;
  // Cloud Trace reads have a small per-minute quota: one token, a 10 s pace, and each trace is read
  // only until it holds what the checks below need; a refused read (429) just waits for the next round.
  // A trace is assembled from export batches that become readable separately (a cold miss on a fresh
  // revision spans two batches), so "found" is not "complete".
  const traceToken = gcloud('auth', 'print-access-token');
  const fetchTrace = async (id) => {
    const res = await fetch(`https://cloudtrace.googleapis.com/v1/projects/${PROJECT}/traces/${id}`, { headers: { authorization: `Bearer ${traceToken}` } });
    return res.status === 200 ? res.json() : null;
  };
  const bootstrapComplete = (t) => !!t?.spans?.some((s) => s.name === 'GET /api/bootstrap') && (first === 'hit' || t.spans.some((s) => /Subject|Material/.test(s.name)));
  const loginComplete = (t) => !!t?.spans?.some((s) => s.name === 'POST /api/session' && s.labels?.['memoryz.client.hop'] !== undefined);
  for (let i = 0; i < 18 && !(logged && bootstrapComplete(traced) && loginComplete(loginTraced)); i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    if (!logged) {
      const entries = JSON.parse(gcloud('logging', 'read', `resource.type="cloud_run_revision" AND jsonPayload.requestId="${requestId}"`, '--limit=1', '--format=json', '--freshness=10m') || '[]');
      if (entries[0]) logged = entries[0];
    }
    if (!bootstrapComplete(traced)) traced = (await fetchTrace(traceId)) ?? traced;
    if (!loginComplete(loginTraced)) loginTraced = (await fetchTrace(loginTrace)) ?? loginTraced;
  }
  check(logged && logged.jsonPayload?.traceId === traceId && logged.trace === `projects/${PROJECT}/traces/${traceId}`, `request log carries the trace (${logged ? logged.jsonPayload?.traceId : 'no log'})`);
  // The front end usually forwards this request (right after the login) as "not sampled": its own
  // rate limit. The server's sampler keeps it anyway; the platform's flag is reported, not required.
  const platform = JSON.parse(gcloud('logging', 'read', `resource.type="cloud_run_revision" AND logName="projects/${PROJECT}/logs/run.googleapis.com%2Frequests" AND trace="projects/${PROJECT}/traces/${traceId}"`, '--limit=1', '--format=json', '--freshness=10m') || '[]')[0];
  // Query spans exist only when that request missed the cache.
  const spans = traced?.spans ?? [];
  check(traced && spans.some((s) => s.name === 'GET /api/bootstrap') && (first === 'hit' || spans.some((s) => /Subject|Material/.test(s.name))), `Cloud Trace has the server span${first === 'miss' ? ' and the query spans' : ''} (${traced ? spans.length : 'no trace'} spans, first read ${first}, platform sampled=${platform?.traceSampled === true})`);
  console.log(`bootstrap trace: ${spans.length} spans in Cloud Trace (first read ${first}), platform sampled=${platform ? platform.traceSampled === true : 'no request log'}`);
  const loginSpan = (loginTraced?.spans ?? []).find((s) => s.name === 'POST /api/session');
  const hop = loginSpan?.labels?.['memoryz.client.hop'];
  const entries = loginSpan?.labels?.['memoryz.client.entries'];
  check(hop === (behindLB ? '1' : '0') && entries === (behindLB ? '3' : '2'), `the rate-limit key is the platform-appended client, not the forged entry${behindLB ? ' or the load balancer' : ''} (hop ${hop} of ${entries} entries)`);
  await get('/api/logout', { method: 'POST', headers: { cookie, origin: url } });
  if (new URL(url).host !== new URL(runUrl).host) {
    // Behind the load balancer the service takes no direct traffic: run.app answers 404 from Cloud Run.
    const direct = await fetch(`${runUrl}/api/health`, { redirect: 'manual' });
    check(direct.status === 404 || direct.status === 403, `run.app is closed to direct traffic (${direct.status})`);
  }
  console.log(`CLOUD_SMOKE_OK (${checks} checks) origin=${url}`);
}
