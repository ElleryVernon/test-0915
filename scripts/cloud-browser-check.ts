// Gate leaf-6 Q10: the user's report ("체험계정에서 뭐 신청할때마다 401뜨고 무한대기", 2026-09-15) checked
// in the real cloud with a real browser. A logged-out first visit must not ask for /api/bootstrap (the
// 401 the user saw); the demo student signs in and home loads; logging out through the account sheet
// and reloading still produces no 401; the console stays clean. No paid AI call is made. The origin
// resolves through public DNS so a stale resolver cache on this machine cannot decide the result.
// Usage: npx tsx scripts/cloud-browser-check.ts   (CLOUD_URL overrides https://memoryz.kr)
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { Cdp, consoleErrors, launchChrome } from './lib/browser';

const origin = process.env.CLOUD_URL ?? 'https://memoryz.kr';
const host = new URL(origin).host;
const resolver = new dns.promises.Resolver();
resolver.setServers(['8.8.8.8', '1.1.1.1']);
const [ip] = await resolver.resolve4(host);

let checks = 0;
const check = (ok: unknown, message: string) => {
  assert.ok(ok, message);
  checks++;
};

type Hit = { url: string; method: string; status: number; at: number };
const chrome = await launchChrome([`--host-resolver-rules=MAP ${host} ${ip}`]);
try {
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method: string, params: object = {}) => chrome.cdp.send(method, params, sessionId);
  for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await send(`${domain}.enable`);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  const requests = new Map<string, { url: string; method: string }>();
  const hits: Hit[] = [];
  chrome.cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Network.requestWillBeSent')
      requests.set(m.params.requestId, {
        url: m.params.request.url,
        method: m.params.request.method,
      });
    if (m.method === 'Network.responseReceived') {
      const req = requests.get(m.params.requestId);
      if (req?.url.startsWith(`${origin}/api/`))
        hits.push({ ...req, status: m.params.response.status, at: Date.now() });
    }
  });
  const evaluate = async (expression: string) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        `evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    return r.result.value;
  };
  const waitFor = async (expression: string, label: string, timeout = 25000) => {
    for (const end = Date.now() + timeout; Date.now() < end;) {
      if (await evaluate(`!!(${expression})`).catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  const button = (text: string) =>
    `[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}) && !b.disabled)`;
  const settle = () => new Promise((r) => setTimeout(r, 2500));
  const since = (t: number) => hits.filter((h) => h.at >= t);
  const path = (h: Hit) => new URL(h.url).pathname;

  // 0. Control: a stale hint without a session must make the app ask for bootstrap and receive the
  // 401 — proof that this detector sees the request the user reported. Then start clean.
  await send('Network.setCookie', {
    name: 'memoryz_signed_in',
    value: '1',
    domain: host,
    path: '/',
    secure: true,
  });
  let mark = Date.now();
  await send('Page.navigate', { url: `${origin}/` });
  await waitFor(button('학생으로 체험하기'), 'the sign-in screen (control)');
  await settle();
  check(
    since(mark).some((h) => path(h) === '/api/bootstrap' && h.status === 401),
    `control: a stale hint produces the bootstrap 401 (${
      since(mark)
        .map((h) => `${path(h)} ${h.status}`)
        .join(', ') || 'no API calls'
    })`,
  );
  await send('Network.clearBrowserCookies');
  await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  hits.length = 0;
  // The control's 401 is expected; console errors are judged from here on.
  const controlEnd = chrome.cdp.events.length;

  // 1. A logged-out first visit: the sign-in screen, and no bootstrap request at all.
  mark = Date.now();
  await send('Page.navigate', { url: `${origin}/` });
  await waitFor(button('학생으로 체험하기'), 'the sign-in screen');
  await settle();
  check(
    !since(mark).some((h) => path(h) === '/api/bootstrap'),
    `a logged-out visit does not ask for bootstrap (${
      since(mark)
        .map((h) => `${h.method} ${path(h)} ${h.status}`)
        .join(', ') || 'no API calls'
    })`,
  );
  check(!since(mark).some((h) => h.status === 401), 'no 401 on the logged-out visit');

  // 2. The demo student signs in; the readable hint arrives with the session and home loads.
  mark = Date.now();
  await evaluate(`${button('학생으로 체험하기')}.click()`);
  await waitFor(`document.querySelector('.home-review')`, 'home after the demo login');
  const login = since(mark);
  check(
    login.some((h) => h.method === 'POST' && path(h) === '/api/session' && h.status === 200),
    'demo login answers 200',
  );
  check(
    login.some((h) => path(h) === '/api/bootstrap' && h.status === 200),
    'bootstrap answers 200 after sign-in',
  );
  check(
    /(?:^|; )memoryz_signed_in=1(?:;|$)/.test(await evaluate('document.cookie')),
    'the signed-in hint cookie is set',
  );

  // 3. A reload while signed in still loads home without a 401.
  mark = Date.now();
  await send('Page.reload');
  await waitFor(`document.querySelector('.home-review')`, 'home after a reload');
  await settle();
  check(!since(mark).some((h) => h.status === 401), 'no 401 on a signed-in reload');

  // 4. Log out through the account sheet; the hint goes with the session.
  await send('Page.navigate', { url: `${origin}/profile` });
  await waitFor(button('체험 계정 관리'), 'the profile screen');
  await evaluate(`${button('체험 계정 관리')}.click()`);
  await waitFor(button('로그아웃'), 'the account sheet');
  mark = Date.now();
  await evaluate(`${button('로그아웃')}.click()`);
  await waitFor(button('학생으로 체험하기'), 'the sign-in screen after logout');
  check(
    since(mark).some((h) => h.method === 'POST' && path(h) === '/api/logout' && h.status === 200),
    'logout answers 200',
  );
  check(
    !/memoryz_signed_in=1/.test(await evaluate('document.cookie')),
    'logout clears the hint cookie',
  );

  // 5. Reloading after logout: the sign-in screen again, still no bootstrap and no 401.
  mark = Date.now();
  await send('Page.reload');
  await waitFor(button('학생으로 체험하기'), 'the sign-in screen after a reload');
  await settle();
  check(
    !since(mark).some((h) => path(h) === '/api/bootstrap'),
    'a reload after logout does not ask for bootstrap',
  );
  check(
    !hits.some((h) => h.status === 401),
    `no 401 anywhere in the run (${hits
      .filter((h) => h.status === 401)
      .map((h) => path(h))
      .join(', ')})`,
  );

  const errors = consoleErrors({ events: chrome.cdp.events.slice(controlEnd) } as unknown as Cdp, [
    /favicon/,
  ]);
  check(errors.length === 0, `console errors: ${JSON.stringify(errors)}`);
  console.log(`CLOUD_BROWSER_OK (${checks} checks) origin=${origin} ip=${ip} api=${hits.length}`);
} finally {
  await chrome.close();
}
