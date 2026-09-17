// Frontier check for the community v3 leaf: typed notifications (FIRST_ANSWER once, MORE_ANSWERS
// bundled in place, ACCEPTED), the nickname 30-day rule, owner-only cooldown echo, profile
// relation stats — then a real headless-Chrome pass over /community at a phone width.
// Dedicated local DB + loopback server only; QA rows are prefixed and deleted in finally.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { db, useServer } from './lib/db';
import { createSession } from './lib/session';
import { serveStatic } from './lib/goserve';
import { consoleErrors, launchChrome, openPage } from './lib/browser';

const prefix = 'qa-frontier-' + randomUUID();
let checks = 0;

async function call(
  base: string,
  path: string,
  body?: unknown,
  method?: string,
  cookie?: string,
  status = 200,
) {
  const response = await fetch(base + '/api' + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(payload)}`);
  checks++;
  return payload.data;
}

const server = await serveStatic();
const base = server.url;
useServer(base);
try {
  const author = await db.user.create({
    data: { id: `${prefix}-author`, name: '검증 질문자', nickname: `${prefix}-author`, role: 'STUDENT' },
  });
  const answerer = await db.user.create({
    data: { id: `${prefix}-answerer`, name: '검증 답변자', nickname: `${prefix}-answerer`, role: 'STUDENT' },
  });
  const ac = (await createSession(author.id, new Request(base))).split(';')[0];
  const bc = (await createSession(answerer.id, new Request(base))).split(';')[0];

  // 1. A 질문 post → B answers once → A gets FIRST_ANSWER (kind typed in bootstrap).
  const post = await call(
    base,
    '/posts',
    { title: `${prefix} 이 문제 어디서 틀렸을까요`, body: '질문 본문', category: '질문', anonymous: false },
    undefined,
    ac,
    201,
  );
  const first = await call(base, `/posts/${post.id}/comments`, { body: '첫 번째 답변이에요' }, undefined, bc, 201);
  let boot = await call(base, '/bootstrap', undefined, undefined, ac);
  const firstAnswer = boot.notifications.filter(
    (n: { kind?: string; href: string }) => n.kind === 'FIRST_ANSWER' && n.href.includes(post.id),
  );
  assert.equal(firstAnswer.length, 1, 'first answer earns exactly one FIRST_ANSWER');
  checks++;

  // 2. Two more answers fold into ONE MORE_ANSWERS row whose count refreshes in place.
  await call(base, `/posts/${post.id}/comments`, { body: '두 번째 답변이에요' }, undefined, bc, 201);
  await call(base, `/posts/${post.id}/comments`, { body: '세 번째 답변이에요' }, undefined, bc, 201);
  boot = await call(base, '/bootstrap', undefined, undefined, ac);
  const bundled = boot.notifications.filter(
    (n: { kind?: string; href: string }) => n.kind === 'MORE_ANSWERS' && n.href.includes(post.id),
  );
  assert.equal(bundled.length, 1, 'later answers bundle into a single MORE_ANSWERS row');
  assert.match(bundled[0].body, /2개 더/, bundled[0].body);
  checks += 2;

  // 3. Accept the first answer → B's bootstrap carries ACCEPTED pointing at the thread.
  await call(base, `/posts/${post.id}/accept`, { commentId: first.id }, undefined, ac);
  const bootB = await call(base, '/bootstrap', undefined, undefined, bc);
  assert(
    bootB.notifications.some(
      (n: { kind?: string; href: string }) => n.kind === 'ACCEPTED' && n.href.includes(post.id),
    ),
    'accepted answer notifies its author with kind ACCEPTED',
  );
  checks++;

  // 4. Profile relation line: A viewing B sees the real intersection of their history.
  const profile = await call(
    base,
    `/community/profiles/${answerer.id}`,
    undefined,
    undefined,
    ac,
  );
  assert.ok(profile.relation, 'relation is present on another student\'s profile');
  // answersToMe counts distinct questions answered — the three answers were on one post.
  assert.equal(profile.relation.answersToMe, 1);
  assert.equal(profile.relation.acceptedForMe, 1);
  assert.equal(profile.visibility.nicknameChangedAt, undefined, 'cooldown marker is owner-only');
  checks += 3;

  // 5. Nickname: first change lands, a second inside 30 days is refused by the server.
  const renamed = await call(
    base,
    '/community/profile',
    { nickname: 'qa별명' },
    'PATCH',
    ac,
  );
  assert.ok(renamed.visibility.nicknameChangedAt, 'owner sees the cooldown marker');
  await call(base, '/community/profile', { nickname: 'qa별명2' }, 'PATCH', ac, 429);
  checks += 2;

  // 6. Browser pass: the QA author's /community feed at phone width.
  const chrome = await launchChrome();
  try {
    const page = await openPage(chrome.cdp, {
      width: 390,
      height: 844,
      cookie: {
        name: 'memoryz_session',
        value: ac.split('=')[1],
      },
    });
    chrome.cdp.on(
      (m: { method: string; params: { request?: { url: string }; response?: { status: number; url: string } } }) => {
        const url = m.params.request?.url ?? m.params.response?.url ?? '';
        if (m.method === 'Network.requestWillBeSent')
          console.log('REQ', url.slice(-70));
        if (m.method === 'Network.responseReceived')
          console.log('RES', m.params.response?.status, url.slice(-70));
        if (m.method === 'Network.loadingFailed')
          console.log('LOADFAIL', url.slice(-70));
      },
    );
    const nav = await page.send('Page.navigate', { url: `${base}/community` });
    if (nav.errorText) console.log('NAV:', nav.errorText);
    // A stall before the lazy chunk settles gets one reload; then we wait on the feed itself.
    await page.waitUntil('document.readyState === "complete"', 'load', 20000).catch(async () => {
      await page.send('Page.navigate', { url: `${base}/community` });
      await page.waitUntil('document.readyState === "complete"', 'reload', 20000);
    });
    try {
      await page.waitUntil(
        "document.body.innerText.includes('이 문제 어디서 틀렸을까요')",
        'feed row',
        20000,
      );
    } catch {
      await page.send('Page.reload');
      await page.waitUntil('document.readyState === "complete"', 'reload load', 20000);
    }
    try {
      await page.waitUntil(
        "document.body.innerText.includes('이 문제 어디서 틀렸을까요')",
        'feed row',
        30000,
      );
    } catch (e) {
      console.log('URL:', await page.evaluate('location.href'));
      console.log('BODY:', (await page.evaluate('document.body.innerText')).slice(0, 900));
      console.log('READY:', await page.evaluate('document.readyState'));
      console.log('MAIN:', await page.evaluate('document.querySelector("main")?.innerHTML.slice(0, 400) ?? "no main"'));
      console.log(
        'CLASSES:',
        await page.evaluate(
          `[...document.querySelectorAll('main button')].map((b) => b.className).filter((c) => c.includes('post')).join(' | ')`,
        ),
      );
      console.log(
        'ROW HTML:',
        await page.evaluate(
          `document.querySelector("[class*='postRow']")?.outerHTML.slice(0, 500) ?? 'no postRow'`,
        ),
      );
      console.log('ERRORS:', JSON.stringify(consoleErrors(chrome.cdp)));
      console.log('SERVER:', server.output().slice(-2000));
      throw e;
    }
    const feedText = await page.evaluate('document.body.innerText');
    assert.ok(feedText.includes('팔로잉'), 'following strip is visible');
    assert.ok(
      feedText.includes('이 문제 어디서 틀렸을까요'),
      'QA post renders in the feed',
    );
    const overflow = await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    assert.ok(overflow <= 1, `no horizontal overflow (got ${overflow}px)`);
    checks += 3;

    // Open the thread: the detail shows the adopted answer state after acceptance.
    await page.click("[class*='postRow']", '이 문제 어디서 틀렸을까요');
    await page.waitUntil(
      `document.body.innerText.includes('해결됨')`,
      'solved badge',
    );
    const detailText = await page.evaluate('document.body.innerText');
    assert.ok(detailText.includes('세 번째 답변이에요'), 'answers render in detail');
    checks++;

    const errors = consoleErrors(chrome.cdp, [/favicon/, /manifest/i]);
    assert.deepEqual(errors, [], 'no console errors');
    checks++;
    mkdirSync('.unlazy/community-v3-frontier', { recursive: true });
    writeFileSync('.unlazy/community-v3-frontier/community-detail.png', await page.shot());
  } finally {
    await chrome.close();
  }

  console.log(`COMMUNITY_V3_FRONTIER_OK (${checks} checks: notification kinds, relation stats, nickname 30-day, feed + detail at 390px, console clean)`);
} finally {
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.$disconnect();
  await server.stop();
}
