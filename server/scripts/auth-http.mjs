// Gate A2: the sign-in contract over real HTTP against a throwaway database — config, demo login
// (seeded once, even under concurrent first logins), cookies, logout, session errors, the static
// role gate, the sign-in rate limit and the social login entry points.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const work = mkdtempSync(join(tmpdir(), 'memoryz-auth-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`go build: ${build.stderr}`);
const staticDir = join(work, 'static');
mkdirSync(staticDir);
writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>shell</title><div>memoryz shell</div>');

const admin = new pg.Client({ connectionString: database.href });
await admin.connect();
const dbName = `memoryz_auth_${randomUUID().slice(0, 8)}`;
await admin.query(`CREATE DATABASE "${dbName}"`);
const scratch = new URL(database.href);
scratch.pathname = `/${dbName}`;
const migrate = spawnSync(bin, ['migrate', 'up'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: scratch.href, ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'warn' } });
if (migrate.status !== 0) throw new Error(`migrate: ${migrate.stdout}${migrate.stderr}`);
const db = new pg.Client({ connectionString: scratch.href });
await db.connect();

const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
let checks = 0;
const check = (ok, message) => {
  assert.ok(ok, message);
  checks++;
};
let current = null;
async function startServer(extra) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(bin, ['serve'], {
    env: { ...process.env, DATABASE_URL: scratch.href, PORT: String(port), HOST: '127.0.0.1', ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'warn', STATIC_DIR: staticDir, APP_URL: base, AUTH_SECRET: randomBytes(24).toString('hex'), GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', KAKAO_CLIENT_ID: '', KAKAO_CLIENT_SECRET: '', NAVER_CLIENT_ID: '', NAVER_CLIENT_SECRET: '', APPLE_CLIENT_ID: '', APPLE_CLIENT_SECRET: '', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((done) => child.on('exit', (code) => done(code)));
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error(`server did not start: ${output}`);
  current = {
    base,
    stop: async () => {
      child.kill('SIGTERM');
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10_000))]);
      current = null;
      if (code !== 0) throw new Error(`server exit ${code}: ${output.slice(-2000)}`);
    },
  };
  return current;
}
const call = (base, path, { method = 'GET', body, cookie, headers = {} } = {}) =>
  fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: base } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (res) => res.json().catch(() => ({}));
const cookieOf = (res) => {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('memoryz_session='));
  return raw ? { raw, header: raw.split(';')[0], token: raw.slice('memoryz_session='.length).split(';')[0] } : null;
};
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

try {
  // Phase A: demo mode, no social provider.
  // Cloud Run shape: the client is the last X-Forwarded-For entry that is not a trusted proxy
  // (198.51.100.250 plays the load balancer's forwarding rule).
  const a = await startServer({ DEMO_MODE: 'true', TRUST_PROXY: 'true', TRUSTED_PROXIES: '198.51.100.250' });
  const cfg = await json(await call(a.base, '/api/config'));
  check(cfg.data.demo === true && Array.isArray(cfg.data.providers) && cfg.data.providers.length === 0, `config ${JSON.stringify(cfg)}`);

  const firstLogins = await Promise.all(Array.from({ length: 5 }, () => call(a.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' } })));
  const firstBodies = await Promise.all(firstLogins.map(json));
  check(firstLogins.every((r) => r.status === 200) && firstBodies.every((b) => b.data.id === 'demo-student' && b.data.name === '김지우' && b.data.role === 'STUDENT'), `concurrent first logins ${firstLogins.map((r) => r.status)}`);
  check((await db.query('SELECT count(*)::int AS n FROM "User"')).rows[0].n === 6, 'demo seeded exactly once (6 users)');
  const first = cookieOf(firstLogins[0]);
  // The lifetime is 8 d − U[0, 12 h): Max-Age in [647999, 691200], one draw shared by both cookies.
  const ageOf = (c) => Number(/; Max-Age=(\d+)/.exec(c ?? '')?.[1] ?? -1);
  const inLifetime = (n) => n >= 647999 && n <= 691200;
  check(first && /^memoryz_session=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+$/.test(first.raw) && inLifetime(ageOf(first.raw)), `session cookie ${first?.raw}`);
  check(firstLogins[0].headers.getSetCookie().some((c) => /^memoryz_signed_in=1; SameSite=Lax; Path=\/; Max-Age=\d+$/.test(c) && ageOf(c) === ageOf(first.raw)), 'signed-in hint issued with the session (readable, same lifetime)');
  const loginAges = firstLogins.map((r) => ageOf(cookieOf(r)?.raw));
  check(loginAges.every(inLifetime) && new Set(loginAges).size >= 3, `five logins in the same second draw different lifetimes (${loginAges})`);
  const profile = firstBodies[0].data;
  check(profile.srsMode === 'FIXED' && profile.desiredRetention === 0.9 && JSON.stringify(profile.privacy) === '{"accuracy":true,"time":true,"wrongNotes":false}' && profile.completedSubjects.length === 3 && profile.points === 1200 && profile.streak === 7, `profile ${JSON.stringify(profile)}`);

  const again = await call(a.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' }, cookie: first.header });
  const second = cookieOf(again);
  check(again.status === 200 && second && second.token !== first.token, 'a new login issues a new token');
  check((await db.query('SELECT count(*)::int AS n FROM "Session" WHERE "id" = $1', [sha256(first.token)])).rows[0].n === 0, 'the previous session is deleted');
  const me = await json(await call(a.base, '/api/me', { cookie: second.header }));
  check(me.data?.id === 'demo-student', `me ${JSON.stringify(me)}`);
  check((await call(a.base, '/api/session', { method: 'POST', body: { role: 'ADMIN' } })).status === 403 && (await json(await call(a.base, '/api/session', { method: 'POST', body: { role: 'ADMIN' } }))).error === '관리자 데모 로그인이 비활성화되어 있어요.', 'admin demo login is off');
  check((await json(await call(a.base, '/api/session', { method: 'POST', body: { role: 'TEACHER' } }))).error === '입력값을 확인해 주세요.', 'unknown role is a 400');
  const noCookie = await call(a.base, '/api/me');
  check(noCookie.status === 401 && (await json(noCookie)).error === '로그인이 필요해요.', 'no cookie');
  check((await json(await call(a.base, '/api/me', { cookie: 'memoryz_session=short' }))).error === '로그인이 필요해요.', 'malformed cookie');
  const expiredToken = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO "Session" ("id", "userId", "expiresAt") VALUES ($1, 'demo-student', now() - interval '1 hour')`, [sha256(expiredToken)]);
  const expired = await call(a.base, '/api/me', { cookie: `memoryz_session=${expiredToken}` });
  check(expired.status === 401 && (await json(expired)).error === '세션이 만료됐어요. 다시 로그인해 주세요.', 'expired session');
  const logout = await call(a.base, '/api/logout', { method: 'POST', body: {}, cookie: second.header });
  check(logout.status === 200 && (await json(logout)).data.loggedOut === true && logout.headers.getSetCookie().some((c) => /^memoryz_session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/.test(c)), 'logout clears the cookie');
  check(logout.headers.getSetCookie().some((c) => /^memoryz_signed_in=; SameSite=Lax; Path=\/; Max-Age=0$/.test(c)), 'signed-in hint cleared on logout');
  // A live session without the readable flag (signed in before the flag existed, or the flag evicted)
  // gets it back on its next authenticated request; a request that already carries it gets no cookie.
  const fresh = cookieOf(await call(a.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' } }));
  const hintless = await call(a.base, '/api/me', { cookie: fresh.header });
  check(hintless.status === 200 && hintless.headers.getSetCookie().some((c) => /^memoryz_signed_in=1; SameSite=Lax; Path=\/; Max-Age=\d+$/.test(c) && ageOf(c) <= ageOf(fresh.raw) && ageOf(c) >= ageOf(fresh.raw) - 5), `an authenticated request without the hint re-issues it with the session's remaining life (${hintless.status})`);
  const hinted = await call(a.base, '/api/me', { cookie: `${fresh.header}; memoryz_signed_in=1` });
  check(hinted.status === 200 && !hinted.headers.getSetCookie().some((c) => c.startsWith('memoryz_signed_in=')), 'a request that carries the hint is not sent it again');
  // Sliding renewal: under 4 d left, the next authenticated request moves the session forward and
  // re-issues both cookies with one new Max-Age; a session past its absolute cap (30 d + at most
  // 28 d) is left to expire.
  const aging = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO "Session" ("id", "userId", "expiresAt", "createdAt") VALUES ($1, 'demo-student', now() + interval '1 day', now() - interval '6 days')`, [sha256(aging)]);
  const renewal = await call(a.base, '/api/me', { cookie: `memoryz_session=${aging}; memoryz_signed_in=1` });
  const renewedAges = renewal.headers.getSetCookie().filter((c) => /^memoryz_(session|signed_in)=/.test(c)).map(ageOf);
  check(renewal.status === 200 && renewedAges.length === 2 && renewedAges[0] === renewedAges[1] && inLifetime(renewedAges[0]), `renewal re-issues both cookies with one new Max-Age (${renewedAges})`);
  const storedLeft = (await db.query(`SELECT extract(epoch FROM "expiresAt" - now())::int AS left FROM "Session" WHERE "id" = $1`, [sha256(aging)])).rows[0].left;
  check(storedLeft > 647000, `the renewed expiry is stored (${storedLeft}s left)`);
  const settledRenewal = await call(a.base, '/api/me', { cookie: `memoryz_session=${aging}; memoryz_signed_in=1` });
  check(settledRenewal.status === 200 && settledRenewal.headers.getSetCookie().length === 0, 'the next request does not renew again');
  const old = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO "Session" ("id", "userId", "expiresAt", "createdAt") VALUES ($1, 'demo-student', now() + interval '1 day', now() - interval '59 days')`, [sha256(old)]);
  const capped = await call(a.base, '/api/me', { cookie: `memoryz_session=${old}; memoryz_signed_in=1` });
  check(capped.status === 200 && !capped.headers.getSetCookie().some((c) => c.startsWith('memoryz_session=')), 'a session past its absolute cap is not renewed');
  check((await call(a.base, '/api/me', { cookie: second.header })).status === 401, 'logged-out session is refused');

  await db.query(`UPDATE "User" SET "suspended" = true WHERE "id" = 'demo-peer-2'`);
  const suspendedToken = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO "Session" ("id", "userId", "expiresAt") VALUES ($1, 'demo-peer-2', now() + interval '1 day')`, [sha256(suspendedToken)]);
  const suspended = await call(a.base, '/api/me', { cookie: `memoryz_session=${suspendedToken}` });
  check(suspended.status === 403 && (await json(suspended)).error === '이용이 제한된 계정이에요.', 'suspended account');

  const parentLogin = await call(a.base, '/api/session', { method: 'POST', body: { role: 'PARENT' } });
  const parent = cookieOf(parentLogin);
  const studentLogin = await call(a.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' } });
  const student = cookieOf(studentLogin);
  const parentProfile = (await json(parentLogin)).data;
  check(parentProfile?.role === 'PARENT' && parentProfile.id === 'demo-parent' && parentProfile.points === 5000, `parent demo login ${JSON.stringify(parentProfile)}`);
  const gated = await call(a.base, '/study', { cookie: parent.header });
  check(gated.status === 403 && /이 계정에서 볼 수 없는 화면이에요/.test(await gated.text()) && gated.headers.get('cache-control') === 'no-store', 'parent on a student screen');
  check((await call(a.base, '/parent', { cookie: student.header })).status === 403, 'student on a parent screen');
  check((await call(a.base, '/admin', { cookie: student.header })).status === 403, 'student on admin');
  check((await call(a.base, '/parent', { cookie: parent.header })).status === 200, 'parent on the parent screen');
  const studentScreen = await call(a.base, '/study', { cookie: student.header });
  check(studentScreen.status === 200 && /memoryz shell/.test(await studentScreen.text()), 'student on a student screen');
  const broken = await call(a.base, '/study', { cookie: `memoryz_session=${randomBytes(32).toString('hex')}` });
  check(broken.status === 302 && broken.headers.get('location') === '/', 'broken session goes home');
  check((await call(a.base, '/study')).status === 200, 'no cookie serves the shell');

  // 120 sign-ins a minute per address: two classes behind one school NAT at the bell fit twice over.
  let statuses = [];
  let chain = null;
  let refusal = null;
  for (let i = 0; i < 121; i++) {
    const res = await call(a.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' }, cookie: chain, headers: { 'X-Forwarded-For': '203.0.113.9' } });
    statuses.push(res.status);
    if (res.status === 429) refusal = res;
    const c = cookieOf(res);
    if (c) chain = c.header;
  }
  check(statuses.slice(0, 120).every((s) => s === 200) && statuses[120] === 429, `rate limit: 120 a minute per address, the 121st refused (${[...new Set(statuses)].join(',')})`);
  const refusalBody = refusal ? await json(refusal) : {};
  const retrySecs = Number(refusal?.headers.get('retry-after'));
  check(Number.isInteger(retrySecs) && retrySecs >= 1 && retrySecs <= 75 && refusalBody.retryAfterMs > 0 && Math.ceil(refusalBody.retryAfterMs / 1000) === retrySecs, `the refusal says when to come back: rest of the window + U[0,15 s) (Retry-After ${retrySecs}, retryAfterMs ${refusalBody.retryAfterMs})`);
  const busy = await call(a.base, '/api/auth/google?role=STUDENT', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  const busyTarget = new URL(busy.headers.get('location') ?? '/', a.base);
  check(busy.status === 303 && busyTarget.pathname === '/' && busyTarget.searchParams.get('loginError') === 'busy' && Number(busyTarget.searchParams.get('retryAfter')) >= 1 && Number(busyTarget.searchParams.get('retryAfter')) <= 75, `a refused OAuth start goes back to sign-in with the wait (${busy.status} ${busy.headers.get('location')})`);
  const spoofed = await call(a.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' }, headers: { 'X-Forwarded-For': '203.0.113.9, 198.51.100.7' } });
  check(spoofed.status === 200, `a forged entry left of the platform-appended one never counts (${spoofed.status})`);
  const viaBalancer = await call(a.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' }, headers: { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9, 198.51.100.250' } });
  check(viaBalancer.status === 429, `behind the load balancer the entry before its address is the client (${viaBalancer.status})`);
  const onlyBalancer = await call(a.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' }, headers: { 'X-Forwarded-For': '198.51.100.250' } });
  check(onlyBalancer.status === 200, `a header of trusted proxies only falls back to the socket peer (${onlyBalancer.status})`);
  check((await json(await call(a.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' }, headers: { 'X-Forwarded-For': '203.0.113.9' } }))).error === '요청이 많아요. 잠시 후 다시 시도해 주세요.', 'rate limit message');
  check((await call(a.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' }, headers: { 'X-Forwarded-For': '203.0.113.10' } })).status === 200, 'another address is unaffected');

  const off = await call(a.base, '/api/auth/google?role=STUDENT');
  check(off.status === 503 && (await json(off)).error === '이 로그인 서비스가 아직 연결되지 않았어요.', 'unconfigured provider');
  check((await call(a.base, '/api/auth/nope')).status === 503, 'unknown provider');
  const badStep = await call(a.base, '/api/auth/google/other');
  check(badStep.status === 404 && (await json(badStep)).error === '잘못된 로그인 경로예요.', 'bad auth step');
  await a.stop();

  // Phase B: demo off.
  const b = await startServer({ DEMO_MODE: 'false' });
  const spoofNoProxy = await call(b.base, '/api/config', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  check(spoofNoProxy.status === 200, 'without TRUST_PROXY a forwarded header is ignored, not refused');
  const demoOff = await call(b.base, '/api/session', { method: 'POST', body: { role: 'STUDENT' } });
  check(demoOff.status === 403 && (await json(demoOff)).error === '데모 로그인이 비활성화되어 있어요. 소셜 로그인을 이용해 주세요.', 'demo login off');
  check((await json(await call(b.base, '/api/config'))).data.demo === false, 'config reports demo off');
  await b.stop();

  // Phase C: Google configured (fake credentials; the flow stops before any network call).
  const c = await startServer({ DEMO_MODE: 'true', GOOGLE_CLIENT_ID: 'fake-client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fake-secret' });
  check(JSON.stringify((await json(await call(c.base, '/api/config'))).data.providers) === '["google"]', 'google is listed');
  const start = await call(c.base, '/api/auth/google?role=PARENT');
  const location = new URL(start.headers.get('location'));
  const q = location.searchParams;
  check(start.status === 302 && location.origin === 'https://accounts.google.com' && location.pathname === '/o/oauth2/v2/auth', `redirects to google (${start.status} ${location.origin}${location.pathname})`);
  check(q.get('client_id') === 'fake-client-id.apps.googleusercontent.com' && q.get('redirect_uri') === `${c.base}/api/auth/google/callback` && q.get('response_type') === 'code' && q.get('scope') === 'openid profile' && q.get('code_challenge_method') === 'S256' && (q.get('code_challenge') ?? '').length >= 43 && (q.get('state') ?? '').length >= 32 && (q.get('nonce') ?? '').length >= 32, `authorize params ${location.search}`);
  const stateCookie = start.headers.getSetCookie().find((x) => x.startsWith('memoryz_oauth='));
  check(stateCookie && /; Path=\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=600$/.test(stateCookie) && !/Secure/.test(stateCookie), `state cookie ${stateCookie}`);
  const badState = await call(c.base, `/api/auth/google/callback?code=x&state=wrong`, { cookie: stateCookie.split(';')[0] });
  check(badState.status === 303 && badState.headers.get('location') === `${c.base}/?loginError=1` && badState.headers.getSetCookie().some((x) => /^memoryz_oauth=; Path=\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=0$/.test(x)) && !badState.headers.getSetCookie().some((x) => x.startsWith('memoryz_session=')), `bad state → login error (${badState.status} ${badState.headers.get('location')})`);
  const crossSitePost = await fetch(`${c.base}/api/auth/google/callback`, { method: 'POST', redirect: 'manual', headers: { Origin: 'https://accounts.google.com', 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' }, body: 'code=x&state=y' });
  check(crossSitePost.status === 303 && crossSitePost.headers.get('location') === `${c.base}/?loginError=1`, 'provider form posts are not blocked by the CSRF rule');
  await c.stop();
  console.log(`AUTH_HTTP_OK (${checks} checks)`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (current) await current.stop().catch(() => {});
  await db.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
  rmSync(work, { recursive: true, force: true });
}
