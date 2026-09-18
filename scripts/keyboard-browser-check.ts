import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { launchChrome, openPage } from './lib/browser';

const OUT = mkdtempSync(join(tmpdir(), 'memoryz-kb-check-'));
let BASE = process.env.KB_BASE ?? 'http://127.0.0.1:3000';
let checks = 0;
const ok = (label: string) => {
  checks++;
  console.log(`  ok ${checks}. ${label}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profile = {
  id: 'qa-kb-user',
  name: '검증계정',
  nickname: '키보드검증',
  role: 'STUDENT',
  // The stored value is School.Identity() = "이름 · 주소" — the community scoping key.
  // Screens must render the name only; the address belongs to search results.
  school: '서울제2고등학교 · 서울특별시 강남구 테헤란로 101길 2',
  grade: '고2',
  streak: 0,
  points: 0,
  privacy: { accuracy: false, time: false, wrongNotes: false },
  completedSubjects: [],
};
const subject = {
  id: 'kb-subject',
  name: '검증과목',
  icon: '',
  semester: '',
  color: '#4f7cff',
  materialCount: 0,
  questionCount: 0,
  cardCount: 0,
};
const stats = {
  todayCards: 0,
  todayQuestions: 0,
  accuracy: 0,
  studyMinutes: 0,
  weekly: [0, 0, 0, 0, 0, 0, 0],
};
const post = {
  id: 'p-kb-1',
  author: '검증친구',
  authorId: 'qa-peer',
  role: 'STUDENT',
  category: '질문',
  title: '키보드 검증용 글',
  body: '본문',
  anonymous: false,
  likes: 0,
  liked: false,
  saved: false,
  commentCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
};
const morePosts = Array.from({ length: 14 }, (_, i) => ({
  ...post,
  id: `p-fill-${i}`,
  title: `스크롤 채우기 ${i + 1} — 아주 길어서 줄이 여러 줄로 넘어가는 제목 텍스트입니다`,
}));
const schoolsA = Array.from({ length: 14 }, (_, i) => ({
  id: `s${i + 1}`,
  name: i === 0 ? '서울특별시제일과학예술영재자율형사립고등학교' : `서울제${i + 1}고등학교`,
  address: `서울특별시 강남구 테헤란로 ${100 + i}길 ${i + 1}`,
}));
const schoolsB = [{ id: 'b1', name: '부산과학고등학교', address: '부산광역시 해운대구 센텀로 77' }];
const peerUser = { id: 'qa-peer', nickname: '검증친구' };
const threadMessages = Array.from({ length: 40 }, (_, i) => ({
  id: `m${i + 1}`,
  senderId: i % 3 === 0 ? 'qa-kb-user' : 'qa-peer',
  recipientId: i % 3 === 0 ? 'qa-peer' : 'qa-kb-user',
  body: `검증 메시지 ${i + 1} — 스크롤을 만들기 위한 충분히 긴 본문 텍스트`,
  createdAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
  readAt: `2026-01-01T01:${String(i).padStart(2, '0')}:00Z`,
  ordinal: i + 1,
}));

function appData(onboardingRequired: boolean) {
  return {
    profile: { ...profile, onboardingRequired },
    subjects: [subject],
    materials: [],
    questions: [],
    essays: [],
    cards: [],
    attempts: [],
    schedules: [],
    posts: [post, ...morePosts],
    cheers: [],
    notifications: [],
    stats,
    aiAvailable: false,
    demo: true,
  };
}

const VV_STUB = `(() => {
  const L = {};
  const vv = {
    width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0,
    pageTop: 0, pageLeft: 0, scale: 1,
    addEventListener: (t, f) => { (L[t] = L[t] || []).push(f); },
    removeEventListener: (t, f) => { if (L[t]) L[t] = L[t].filter((x) => x !== f); },
    dispatchEvent: (e) => { (L[e.type] || []).forEach((f) => f(e)); return true; },
  };
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  window.__vv = {
    set(patch) { Object.assign(vv, patch); },
    fire(type) { (L[type] || []).slice().forEach((f) => f()); },
  };
})()`;

const SET_INPUT = `((el, v) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})`;

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function serveExport(root: string) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      const file = resolve(base, `.${sep}${pathname}`);
      if (!file.startsWith(base + sep) && file !== base) {
        res.writeHead(403).end();
        return;
      }
      let target: string | null = null;
      for (const candidate of [file, join(file, 'index.html'), `${file}.html`]) {
        try {
          if ((await stat(candidate)).isFile()) {
            target = candidate;
            break;
          }
        } catch {}
      }
      if (!target && !pathname.startsWith('/_next/')) target = join(base, 'index.html');
      if (!target) {
        res.writeHead(404).end();
        return;
      }
      const body = await readFile(target);
      res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
      req.method === 'HEAD' ? res.end() : res.end(body);
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function main() {
  let staticServer: { stop: () => Promise<void> } | null = null;
  if (process.env.KB_EXPORT) {
    const server = await serveExport(process.env.KB_EXPORT);
    staticServer = server;
    BASE = server.url;
    console.log(`serving export ${process.env.KB_EXPORT} at ${BASE}`);
  }
  const { cdp, close } = await launchChrome();
  try {
    const page = await openPage(cdp, {
      width: 390,
      height: 844,
      cookie: { name: 'memoryz_signed_in', value: '1' },
    });
    const { send, evaluate, waitFor, waitUntil, click, shot } = page;
    const save = async (name: string) => {
      const file = join(OUT, `${name}.png`);
      writeFileSync(file, await shot());
      return file;
    };

    await send('Page.addScriptToEvaluateOnNewDocument', { source: VV_STUB });
    await send('Network.setCookie', { name: 'memoryz_signed_in', value: '1', url: BASE });

    let onboardingDone = false;
    const patchBodies: Record<string, unknown>[] = [];
    const profilePatches: Record<string, unknown>[] = [];
    const heldSchools: { requestId: string; q: string }[] = [];
    const fulfillFailures: string[] = [];
    const intentionalErrors = new Set<object>();
    let holdSchools = false;
    let failSchools = false;
    const seenApi: string[] = [];

    const fulfill = async (
      requestId: string,
      payload: unknown,
      status = 200,
      label = '',
    ): Promise<boolean> => {
      try {
        await send('Fetch.fulfillRequest', {
          requestId,
          responseCode: status,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        });
        return true;
      } catch (e) {
        const message = String(e);
        if (!/invalid request|invalid interception|not found|no resource|closed/i.test(message))
          fulfillFailures.push(`${label || requestId}: ${message}`);
        return false;
      }
    };

    cdp.on(async (msg) => {
      if (msg.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = msg.params;
      const u = new URL(request.url);
      seenApi.push(`${request.method} ${u.pathname}${u.search}`);
      if (u.pathname === '/api/bootstrap') {
        await fulfill(requestId, { data: appData(!onboardingDone) }, 200, 'bootstrap');
      } else if (u.pathname === '/api/onboarding' && request.method === 'GET') {
        await fulfill(
          requestId,
          {
            data: {
              draft: {
                step: 2,
                role: 'STUDENT',
                nickname: '키보드검증',
                grade: '고2',
                school: '',
              },
              complete: false,
            },
          },
          200,
          'onboarding-get',
        );
      } else if (u.pathname === '/api/onboarding' && request.method === 'PATCH') {
        const body = JSON.parse(request.postData ?? '{}');
        patchBodies.push(body);
        if (body.complete) onboardingDone = true;
        await fulfill(requestId, { data: { ok: true } }, 200, 'onboarding-patch');
      } else if (u.pathname === '/api/profile' && request.method === 'PATCH') {
        profilePatches.push(JSON.parse(request.postData ?? '{}'));
        await fulfill(requestId, { data: { ok: true } }, 200, 'profile-patch');
      } else if (u.pathname === '/api/schools') {
        const q = u.searchParams.get('q') ?? '';
        if (failSchools) {
          await fulfill(requestId, { error: '학교 검색 실패' }, 500, 'schools-500');
        } else if (holdSchools) {
          heldSchools.push({ requestId, q });
        } else {
          await fulfill(
            requestId,
            { data: q.includes('부산') ? schoolsB : schoolsA },
            200,
            'schools',
          );
        }
      } else if (u.pathname === '/api/messages' && u.searchParams.get('peer') === '1') {
        await fulfill(requestId, { data: peerUser }, 200, 'peer');
      } else if (u.pathname === '/api/messages' && u.searchParams.has('inbox')) {
        await fulfill(requestId, { data: [] }, 200, 'inbox');
      } else if (u.pathname === '/api/messages' && u.searchParams.has('before')) {
        await fulfill(requestId, { data: [] }, 200, 'before');
      } else if (u.pathname === '/api/messages' && u.searchParams.has('userId')) {
        await fulfill(requestId, { data: threadMessages }, 200, 'thread');
      } else if (u.pathname === '/api/messages' && request.method === 'PATCH') {
        await fulfill(requestId, { data: { ok: true } }, 200, 'messages-patch');
      } else if (u.pathname === '/api/messages' && request.method === 'POST') {
        await fulfill(requestId, { data: { id: 'm-new' } }, 201, 'messages-post');
      } else if (u.pathname === '/api/social') {
        await fulfill(
          requestId,
          {
            data: {
              followers: [],
              following: [],
              users: [],
              blocked: [],
              counts: { posts: 0, comments: 0, followers: 0, following: 0 },
            },
          },
          200,
          'social',
        );
      } else if (/^\/api\/posts\/[^/]+\/comments$/.test(u.pathname) && request.method === 'GET') {
        await fulfill(requestId, { data: [] }, 200, 'comments');
      } else if (u.pathname === '/api/posts' && request.method === 'GET') {
        await fulfill(requestId, { data: [post, ...morePosts] }, 200, 'posts');
      } else {
        await fulfill(requestId, { data: {} }, 200, `fallback-${u.pathname}`);
      }
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });

    const kbOpen = async (height: number, top = 0) => {
      await evaluate(`__vv.set({height:${height}, offsetTop:${top}}); __vv.fire('resize'); true`);
      await sleep(90);
    };
    const kbPan = async (top: number) => {
      await evaluate(`__vv.set({offsetTop:${top}}); __vv.fire('scroll'); true`);
      await sleep(60);
    };
    const kbState = () =>
      evaluate(
        `({flag: document.documentElement.dataset.keyboard ?? null,
           inset: getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset').trim(),
           height: getComputedStyle(document.documentElement).getPropertyValue('--vv-height').trim(),
           top: getComputedStyle(document.documentElement).getPropertyValue('--vv-top').trim()})`,
      );
    const rect = (sel: string) =>
      evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
          const r = el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height}; })()`,
      );
    const type = (sel: string, value: string) =>
      evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no input ${sel}');
          el.focus(); return (${SET_INPUT})(el, ${JSON.stringify(value)}); })()`,
      );
    const noXOverflow = () =>
      evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
    const swipe = async (x0: number, y0: number, x1: number, y1: number) => {
      await send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: x0, y: y0 }],
      });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }],
        });
        await sleep(20);
      }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(120);
    };
    const navDisplay = () =>
      evaluate(
        `(() => { const el = document.querySelector('.bottom-nav'); return el ? getComputedStyle(el).display : 'missing'; })()`,
      );

    console.log('phase 1 · onboarding picker at 390x844 (simulated viewport)');
    await send('Page.navigate', { url: `${BASE}/` });
    await waitFor('button[aria-haspopup="dialog"]', 30000);
    ok('onboarding step 2 renders the school trigger');
    assert.ok(await noXOverflow());
    ok('no horizontal overflow at 390px');

    await evaluate(`document.querySelector('button[aria-haspopup="dialog"]').click()`);
    await waitFor('[data-school-picker]');
    ok('school trigger opens the modal picker');
    assert.equal(
      await evaluate(`document.activeElement && document.activeElement.id`),
      'onboarding-school',
    );
    ok('search input focused on open');
    assert.equal(
      await evaluate(`!!document.querySelector('[data-school-picker] button[type="submit"]')`),
      false,
    );
    ok('no submit CTA inside the picker');

    await waitFor('[data-browse-list] li button', 8000);
    assert.equal(
      await evaluate(`document.querySelectorAll('[data-browse-list] li button').length`),
      14,
    );
    ok('idle picker shows the browse-all school list');
    assert.equal(
      await evaluate(`document.querySelectorAll('.schoolRegions button, [class*="schoolRegions"] button').length`),
      17,
    );
    ok('idle picker shows 17 region quick-select chips');
    await evaluate(
      `[...document.querySelectorAll('[data-school-results] button')].find(b => b.textContent.trim() === '부산').click()`,
    );
    await waitUntil(
      `document.querySelector('#onboarding-school').value === '부산'`,
      'chip fills query',
    );
    await waitFor('[data-results-list] li button', 8000);
    const chipResults = await evaluate(
      `[...document.querySelectorAll('[data-results-list] li button')].map(b => b.textContent).join('|')`,
    );
    assert.match(chipResults, /부산과학고/);
    ok('region chip runs the query and shows matching results');
    await evaluate(
      `[...document.querySelectorAll('[data-school-picker] button')].find(b => b.getAttribute('aria-label') === '검색어 지우기').click()`,
    );
    await waitUntil(
      `document.querySelector('#onboarding-school').value === ''`,
      'query cleared',
    );
    await waitFor('[data-browse-list] li button', 8000);
    ok('clearing the query restores the idle browse view');

    await kbOpen(340);
    let kb = await kbState();
    assert.equal(kb.flag, 'open');
    assert.equal(kb.inset, '504px');
    const head = await rect('[data-school-picker] > div');
    assert.ok(head && head.top >= -1 && head.bottom <= 341, JSON.stringify(head));
    ok('search header stays fully visible above the 340px fold');
    const inputRect = await rect('#onboarding-school');
    assert.ok(inputRect && inputRect.bottom <= 341);
    ok('search field visible at keyboard height');

    await type('#onboarding-school', '서울');
    await waitFor('[data-results-list] li button', 8000);
    assert.equal(
      await evaluate(`document.querySelectorAll('[data-results-list] li button').length`),
      14,
    );
    const scrollableResults = await evaluate(
      `(() => { const el = document.querySelector('[data-school-results]');
        return {sh: el.scrollHeight, ch: el.clientHeight}; })()`,
    );
    assert.ok(scrollableResults.sh > scrollableResults.ch, JSON.stringify(scrollableResults));
    ok('result list is independently scrollable');
    const headBefore = await rect('[data-school-picker] > div');
    const resultsRect = await rect('[data-school-results]');
    const midX = Math.round((resultsRect!.left + resultsRect!.right) / 2);
    const startY = Math.min(Math.round(resultsRect!.bottom) - 15, 330);
    await swipe(midX, startY, midX, Math.round(headBefore!.bottom) + 10);
    const st1 = await evaluate(`document.querySelector('[data-school-results]').scrollTop`);
    assert.ok(st1 > 20, `upward touch scrolled results down (${st1})`);
    await swipe(midX, Math.round(headBefore!.bottom) + 10, midX, startY);
    const st2 = await evaluate(`document.querySelector('[data-school-results]').scrollTop`);
    assert.ok(st2 < st1, `downward touch scrolled results up (${st2})`);
    assert.deepEqual(await rect('[data-school-picker] > div'), headBefore);
    ok('touch swipes scroll only the results; the header never moves');
    const shots1 = await save('01-picker-results-390');
    console.log('    evidence', shots1);

    await kbPan(120);
    kb = await kbState();
    assert.equal(kb.top, '120px');
    const pickerRect = await rect('[data-school-picker]');
    assert.ok(pickerRect && Math.abs(pickerRect.top - 120) < 2);
    ok('picker follows visual-viewport pan');
    await kbPan(0);

    const patchBefore = patchBodies.length;
    await evaluate(
      `document.querySelector('#onboarding-school').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
    );
    await sleep(300);
    assert.equal(patchBodies.length, patchBefore);
    ok('Enter in the search field does not submit onboarding');

    holdSchools = true;
    heldSchools.length = 0;
    await type('#onboarding-school', '서울특별');
    for (let i = 0; i < 50 && heldSchools.length === 0; i++) await sleep(100);
    assert.equal(heldSchools.length, 1, 'first query held');
    await type('#onboarding-school', '부산');
    for (let i = 0; i < 50 && heldSchools.length === 1; i++) await sleep(100);
    assert.equal(heldSchools.length, 2, 'second query held');
    await fulfill(heldSchools[1].requestId, { data: schoolsB }, 200, 'schools-B');
    await waitFor('[data-results-list] li button', 8000);
    await fulfill(heldSchools[0].requestId, { data: schoolsA }, 200, 'schools-stale');
    await sleep(400);
    const shown = await evaluate(
      `[...document.querySelectorAll('[data-results-list] li button')].map(b => b.textContent).join('|')`,
    );
    assert.match(shown, /부산과학고/);
    assert.doesNotMatch(shown, /서울제2고등학교/);
    ok('latest query wins; the stale response is dropped');
    holdSchools = false;

    failSchools = true;
    await type('#onboarding-school', '오류');
    await waitFor('[data-school-results] [role="alert"]', 8000);
    ok('failed query shows the error state');
    failSchools = false;
    for (const e of cdp.events) {
      if (
        e.method === 'Log.entryAdded' &&
        e.params.entry.level === 'error' &&
        /\/api\/schools/.test(e.params.entry.url ?? '') &&
        /500/.test(e.params.entry.text ?? '')
      )
        intentionalErrors.add(e);
    }
    assert.ok(intentionalErrors.size > 0, 'the intentional schools 500 was logged');
    await click('[data-school-results] button', '다시 시도');
    await waitFor('[data-results-list] li button', 8000);
    ok('retry re-runs the query');

    holdSchools = true;
    heldSchools.length = 0;
    await type('#onboarding-school', '없는학교');
    for (let i = 0; i < 50 && heldSchools.length === 0; i++) await sleep(100);
    await fulfill(heldSchools.pop()!.requestId, { data: [] }, 200, 'schools-empty');
    await waitUntil(
      `document.querySelector('[data-school-results]').textContent.includes('검색 결과가 없어요')`,
      'empty state',
    );
    ok('empty state renders');
    holdSchools = false;

    await type('#onboarding-school', '서울');
    await waitFor('[data-results-list] li button', 8000);
    await evaluate(`document.querySelector('[data-results-list] li button').click()`);
    await waitUntil(`!document.querySelector('[data-school-picker]')`, 'picker closed');
    assert.match(
      await evaluate(`document.querySelector('button[aria-haspopup="dialog"]').textContent`),
      /서울특별시제일과학/,
    );
    assert.equal(
      await evaluate(
        `document.activeElement === document.querySelector('button[aria-haspopup="dialog"]')`,
      ),
      true,
    );
    ok('selecting closes the picker, updates the trigger, restores focus');

    await evaluate(`document.querySelector('button[aria-haspopup="dialog"]').click()`);
    await waitFor('[data-school-picker]');
    await type('#onboarding-school', '다른학교');
    await sleep(150);
    await evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
    );
    await waitUntil(`!document.querySelector('[data-school-picker]')`, 'escape closes');
    assert.match(
      await evaluate(`document.querySelector('button[aria-haspopup="dialog"]').textContent`),
      /서울특별시제일과학/,
    );
    ok('Escape cancels the picker and preserves the selection');

    await click('button', '학교 선택 해제');
    await sleep(150);
    await click('button', '내 학습 시작하기');
    for (let i = 0; i < 50 && patchBodies.length === patchBefore; i++) await sleep(100);
    const submitted = patchBodies.at(-1)!;
    assert.equal(submitted.school, '');
    assert.equal(submitted.schoolId, undefined);
    assert.equal(submitted.complete, true);
    ok('optional skip PATCH carries school:"" and no schoolId');
    const shots2 = await save('02-onboarding-done');
    console.log('    evidence', shots2);

    console.log('phase 2 · profile edit sheet at 390x844 (simulated viewport)');
    await send('Page.navigate', { url: `${BASE}/profile` });
    await waitUntil(
      `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '편집')`,
      'edit button',
      30000,
    );
    const profileText = await evaluate(`document.body.innerText`);
    assert.match(profileText, /서울제2고등학교 · 고2/);
    assert.doesNotMatch(profileText, /테헤란로|강남구/);
    ok('the profile header shows the school name only, never the stored address');
    await click('button', '편집');
    await waitFor('.sheet-content');
    assert.ok(
      await evaluate(
        `document.querySelector('.sheet-content').textContent.includes('프로필 편집')`,
      ),
    );
    ok('profile edit sheet opens');
    await evaluate(
      `(() => { const el = document.querySelector('.sheet-content .field'); el.focus(); return true; })()`,
    );
    await kbOpen(340);
    const bodySel = '.sheet-content .sheet-body';
    const schoolSel = 'input[placeholder="학교 이름을 검색해 주세요"]';
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(schoolSel)}).value`),
      '서울제2고등학교',
    );
    ok('the school field shows the name only, not the stored identity');
    await evaluate(
      `document.querySelector(${JSON.stringify(schoolSel)}).focus({preventScroll:true})`,
    );
    await sleep(250);
    const schoolRect = await rect(schoolSel);
    const bodyRect = await rect(bodySel);
    const visibleBottom = Math.min(bodyRect!.bottom, 340);
    assert.ok(
      schoolRect && schoolRect.top >= bodyRect!.top - 1 && schoolRect.bottom <= visibleBottom - 20,
      `school field revealed inside the sheet band ${JSON.stringify(schoolRect)}`,
    );
    ok('the last sheet field is revealed inside the visible band');
    const schoolResultsScroll = await evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(schoolSel)});
        return el.closest('.sheet-body') ? el.closest('.sheet-body').scrollTop : -1; })()`,
    );
    assert.ok(schoolResultsScroll >= 0);
    await evaluate(
      `document.querySelector(${JSON.stringify(bodySel)}).scrollTop = document.querySelector(${JSON.stringify(bodySel)}).scrollHeight`,
    );
    await sleep(80);
    const saveRect = await evaluate(
      `(() => { const b = [...document.querySelectorAll('.sheet-content button')].find(x => x.textContent.includes('저장하기'));
        if (!b) return null; const r = b.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()`,
    );
    assert.ok(saveRect && saveRect.bottom <= 341 && saveRect.top >= 0, JSON.stringify(saveRect));
    ok('저장하기 stays reachable by scrolling the sheet body');
    const sheetSwipeRect = await rect(bodySel);
    const sx = Math.round((sheetSwipeRect!.left + sheetSwipeRect!.right) / 2);
    await swipe(sx, 300, sx, 200);
    const sheetSt = await evaluate(`document.querySelector(${JSON.stringify(bodySel)}).scrollTop`);
    await swipe(sx, 200, sx, 300);
    const sheetSt2 = await evaluate(`document.querySelector(${JSON.stringify(bodySel)}).scrollTop`);
    assert.ok(sheetSt2 < sheetSt, `sheet body swipes keep direction (${sheetSt} -> ${sheetSt2})`);
    ok('sheet body swipes scroll in the drag direction');
    const shots3 = await save('03-profile-sheet-340');
    console.log('    evidence', shots3);
    await type(schoolSel, '부산');
    await waitUntil(
      `[...document.querySelectorAll('.sheet-content button')].some(b => b.textContent.includes('부산과학고등학교'))`,
      'school result',
      8000,
    );
    assert.match(
      await evaluate(
        `[...document.querySelectorAll('.sheet-content button')].find(b => b.textContent.includes('부산과학고등학교')).textContent`,
      ),
      /해운대구 센텀로 77/,
    );
    ok('search results keep the address for disambiguation');
    await evaluate(
      `[...document.querySelectorAll('.sheet-content button')].find(b => b.textContent.includes('부산과학고등학교')).click()`,
    );
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(schoolSel)}).value`),
      '부산과학고등학교',
    );
    ok('selecting a school leaves the name only in the field');
    await click('button', '저장하기');
    await waitUntil(`!document.querySelector('.sheet-content')`, 'sheet closed');
    assert.equal(
      profilePatches.at(-1)?.school,
      '부산과학고등학교 · 부산광역시 해운대구 센텀로 77',
    );
    ok('the profile PATCH keeps the name · address scoping identity');
    await kbOpen(844);
    kb = await kbState();
    assert.equal(kb.flag, null);
    assert.equal(kb.inset, '0px');
    ok('closing the sheet and keyboard restores the inset');

    console.log('phase 3 · comments composer at 390x844 (simulated viewport)');
    await send('Page.navigate', { url: `${BASE}/community?post=${post.id}` });
    await waitFor(`form[aria-label="댓글 작성"]`, 30000);
    await evaluate(`document.querySelector('form[aria-label="댓글 작성"] textarea')?.focus()`);
    await kbOpen(340);
    const composer = await rect('form[aria-label="댓글 작성"]');
    assert.ok(
      composer && Math.abs(composer.bottom - 340) < 4,
      `composer bottom ${composer?.bottom} vs 340`,
    );
    ok('comments composer rides the keyboard inset');
    const shots4 = await save('04-comments-keyboard');
    console.log('    evidence', shots4);

    console.log('phase 4 · DM thread at 390x844 (simulated viewport)');
    await send('Page.navigate', { url: `${BASE}/messages?peer=${peerUser.id}` });
    await waitFor('[data-dm-thread] textarea', 30000);
    await waitFor('[data-message-id]', 15000);
    const threadScroller = `[...document.querySelectorAll('[data-dm-thread] *')].find(e => e.scrollHeight > e.clientHeight + 20 && e.clientHeight > 100)`;
    await evaluate(`${threadScroller}.scrollTop = ${threadScroller}.scrollHeight`);
    await evaluate(`document.querySelector('[data-dm-thread] textarea').focus()`);
    await kbOpen(300);
    const dmComposer = await rect('[data-dm-thread] form');
    assert.ok(
      dmComposer && Math.abs(dmComposer.bottom - 300) < 4,
      `DM composer bottom ${dmComposer?.bottom} vs 300`,
    );
    const bottomDist = await evaluate(
      `${threadScroller}.scrollHeight - ${threadScroller}.scrollTop - ${threadScroller}.clientHeight`,
    );
    assert.ok(bottomDist < 8, `thread still pinned at bottom after resize (${bottomDist})`);
    ok('DM composer aligns to the keyboard bottom and the thread stays pinned');
    const shots5 = await save('05-dm-keyboard');
    console.log('    evidence', shots5);
    await evaluate(`${threadScroller}.scrollTop = 0`);
    const before0 = await evaluate(`${threadScroller}.scrollTop`);
    await kbOpen(260, 120);
    await kbPan(120);
    const after0 = await evaluate(`${threadScroller}.scrollTop`);
    assert.equal(after0, before0, 'scrolled-up position survives shrink+pan');
    ok('scrolled-up DM thread keeps its position through shrink and pan');
    await kbPan(0);
    await kbOpen(340);

    console.log('phase 5 · community editor and nested poll sheet (simulated viewport)');
    await send('Page.navigate', { url: `${BASE}/community` });
    await waitUntil(
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes('글쓰기'))`,
      'write button',
      30000,
    );
    await click('button', '글쓰기');
    await waitFor('[data-community-editor]', 15000);
    await type('input[aria-label="글 제목"]', '제목 보존 검증');
    await kbOpen(340);
    kb = await kbState();
    assert.equal(kb.flag, 'open');
    const editorRect = await rect('[data-community-editor]');
    assert.ok(editorRect && editorRect.height <= 341 && editorRect.height >= 300);
    const titleRect = await rect('input[aria-label="글 제목"]');
    assert.ok(
      titleRect && titleRect.bottom <= 341 && titleRect.top >= -1,
      JSON.stringify(titleRect),
    );
    ok('the focused title field sits fully inside the visible band');
    await evaluate(`document.querySelector('[aria-label="글 내용"]').focus({preventScroll:true})`);
    await sleep(250);
    const editorBodyRect = await evaluate(
      `(() => { const r = document.activeElement.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()`,
    );
    assert.ok(
      editorBodyRect && editorBodyRect.bottom > 0 && editorBodyRect.top < 340,
      `body field intersects the visible band ${JSON.stringify(editorBodyRect)}`,
    );
    const toolsRect = await rect('[aria-label="첨부 도구"]');
    const headerAction = await evaluate(
      `(() => { const b = [...document.querySelectorAll('[data-community-editor] button')].find(x => x.textContent.trim() === '등록');
        if (!b) return null; const r = b.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()`,
    );
    assert.ok(toolsRect && toolsRect.bottom <= 341, JSON.stringify(toolsRect));
    assert.ok(
      headerAction && headerAction.top >= -1 && headerAction.bottom <= 341,
      JSON.stringify(headerAction),
    );
    ok('body field revealed while the header action and toolbar stay visible');
    const shots6 = await save('06-editor-keyboard');
    console.log('    evidence', shots6);
    await click('[aria-label="첨부 도구 더보기"]');
    await waitUntil(
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes('투표'))`,
      'poll tool row',
    );
    await click('button', '투표');
    await waitUntil(
      `[...document.querySelectorAll('label')].some(l => l.textContent.includes('투표 질문'))`,
      'poll question field',
    );
    await evaluate(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '선택지 추가'); b && b.click(); return true; })()`,
    );
    await evaluate(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '선택지 추가'); b && b.click(); return true; })()`,
    );
    await evaluate(
      `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].at(-1);
        const q = [...d.querySelectorAll('label')].find(l => l.textContent.includes('투표 질문')).querySelector('input');
        (${SET_INPUT})(q, '점심 메뉴 투표');
        const opts = [...d.querySelectorAll('label')].filter(l => /선택지 \\d/.test(l.textContent));
        const menu = ['김치찌개', '비빔밥', '불고기', '순두부'];
        opts.forEach((l, i) => (${SET_INPUT})(l.querySelector('input'), menu[i] || '메뉴' + i));
        return opts.length; })()`,
    );
    await sleep(120);
    const lastOption = await evaluate(
      `(() => { const labels = [...document.querySelectorAll('label')].filter(l => /선택지 \\d/.test(l.textContent));
        const last = labels.at(-1).querySelector('input'); last.focus({preventScroll:true}); return labels.length; })()`,
    );
    assert.equal(lastOption, 4);
    await sleep(250);
    const optRect = await evaluate(
      `(() => { const r = document.activeElement.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()`,
    );
    assert.ok(
      optRect && optRect.bottom <= 341 && optRect.top >= 0,
      `last poll option visible at keyboard height ${JSON.stringify(optRect)}`,
    );
    ok('nested attachment sheet: final poll option reachable with keyboard open');
    await kbPan(120);
    const dialogRect = await evaluate(
      `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].at(-1); const r = d.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()`,
    );
    assert.ok(
      dialogRect && dialogRect.bottom <= 460 && dialogRect.top >= 115,
      JSON.stringify(dialogRect),
    );
    ok('nested sheet follows the panned viewport');
    await kbPan(0);
    await evaluate(
      `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].at(-1);
        const body = [...d.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 10);
        if (body) body.scrollTop = body.scrollHeight;
        return true; })()`,
    );
    await sleep(80);
    const pollFooter = await evaluate(
      `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].at(-1);
        const b = [...d.querySelectorAll('button')].find(x => x.textContent.includes('투표 첨부하기'));
        if (!b) return null; const r = b.getBoundingClientRect();
        return {top:r.top,bottom:r.bottom,disabled:b.disabled}; })()`,
    );
    assert.ok(
      pollFooter && pollFooter.top >= 0 && pollFooter.bottom <= 341,
      `poll primary action inside the keyboard band ${JSON.stringify(pollFooter)}`,
    );
    assert.equal(pollFooter.disabled, false, 'poll primary action enabled after filling fields');
    ok('poll footer primary stays inside the visible band after scrolling');
    const shots7 = await save('07-poll-sheet');
    console.log('    evidence', shots7);
    await evaluate(
      `(() => { const d = [...document.querySelectorAll('[role="dialog"]')].at(-1);
        const b = [...d.querySelectorAll('button[aria-label]')].find(x => x.getAttribute('aria-label').includes('닫기'));
        b.click(); return true; })()`,
    );
    await waitUntil(
      `document.querySelectorAll('[role="dialog"]').length === 1 && document.querySelector('[data-community-editor]')`,
      'only the editor remains',
    );
    assert.equal(
      await evaluate(`document.querySelector('input[aria-label="글 제목"]').value`),
      '제목 보존 검증',
    );
    ok('closing only the nested sheet preserves the parent draft');

    console.log('phase 6 · create-card document fields (simulated viewport)');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 600,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await send('Page.navigate', { url: `${BASE}/create-card` });
    await waitFor('textarea', 30000);
    assert.ok(
      await evaluate(`document.scrollingElement.scrollHeight > innerHeight + 40`),
      'create-card page is scrollable',
    );
    await evaluate(
      `(() => { [...document.querySelectorAll('textarea')].at(-1).focus({preventScroll:true}); document.scrollingElement.scrollTop = 0; return true; })()`,
    );
    await kbOpen(340);
    kb = await kbState();
    assert.equal(kb.flag, 'open');
    assert.equal(await evaluate(`document.activeElement.tagName`), 'TEXTAREA');
    const cardScroller = `document.scrollingElement`;
    const c0 = await evaluate(`${cardScroller}.scrollTop`);
    await swipe(195, 300, 195, 200);
    const c1 = await evaluate(`${cardScroller}.scrollTop`);
    assert.ok(c1 > c0, `upward swipe scrolls down with keyboard open (${c0}->${c1})`);
    await swipe(195, 200, 195, 300);
    const c2 = await evaluate(`${cardScroller}.scrollTop`);
    assert.ok(c2 < c1, `downward swipe scrolls up with keyboard open (${c1}->${c2})`);
    await evaluate(`document.activeElement.blur()`);
    await kbOpen(600);
    kb = await kbState();
    assert.equal(kb.flag, null);
    const cardCta = await evaluate(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('카드 저장하기'));
        if (!b) return null; b.scrollIntoView({block:'end'}); const r = b.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; })()`,
    );
    assert.ok(
      cardCta && cardCta.top >= 0 && cardCta.bottom <= 601,
      `card save action reachable after dismissal ${JSON.stringify(cardCta)}`,
    );
    ok('card document scrolls both directions and the save action is reachable after dismissal');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });

    console.log('phase 7 · feed search field, swipes, nav restore at 390x844');
    await send('Page.navigate', { url: `${BASE}/community` });
    await waitFor('[aria-label="게시글 검색"]', 30000);
    assert.ok(
      await evaluate(`document.scrollingElement.scrollHeight > innerHeight + 40`),
      'feed is scrollable',
    );
    await click('[aria-label="게시글 검색"]');
    await waitFor('[aria-label="게시글 검색어"]');
    await evaluate(`document.querySelector('[aria-label="게시글 검색어"]').focus()`);
    assert.equal(await evaluate(`document.activeElement.tagName`), 'INPUT');
    await kbOpen(340);
    kb = await kbState();
    assert.equal(kb.flag, 'open', 'keyboard flag set with the search field focused');
    assert.equal(await navDisplay(), 'none', 'bottom nav hidden while typing');
    await swipe(195, 300, 195, 200);
    const fy1 = await evaluate(`scrollY`);
    assert.ok(fy1 > 20, `upward swipe scrolls down with keyboard open (scrollY=${fy1})`);
    await swipe(195, 200, 195, 300);
    const fy2 = await evaluate(`scrollY`);
    assert.ok(fy2 < fy1, `downward swipe scrolls up (scrollY=${fy2})`);
    ok('document swipes keep direction with the keyboard open');
    const shots8 = await save('08-feed-keyboard');
    console.log('    evidence', shots8);
    await evaluate(`document.activeElement.blur()`);
    await kbOpen(844);
    kb = await kbState();
    assert.equal(kb.flag, null);
    assert.equal(kb.inset, '0px');
    assert.notEqual(await navDisplay(), 'none', 'bottom nav restored after close');
    ok('closing the keyboard restores the nav and clears the inset');
    const cy0 = await evaluate(`scrollY`);
    await swipe(195, 500, 195, 400);
    const cy1 = await evaluate(`scrollY`);
    assert.ok(cy1 > cy0, `closed upward swipe scrolls down (${cy0}->${cy1})`);
    await swipe(195, 400, 195, 500);
    const cy2 = await evaluate(`scrollY`);
    assert.ok(cy2 < cy1, `closed downward swipe scrolls up (${cy1}->${cy2})`);
    ok('document swipes keep direction with the keyboard closed');
    assert.ok(await noXOverflow());
    ok('no horizontal overflow on the feed');

    console.log('phase 8 · onboarding picker at 320x640 (simulated viewport)');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 640,
      deviceScaleFactor: 2,
      mobile: true,
    });
    onboardingDone = false;
    await send('Page.navigate', { url: `${BASE}/` });
    await waitFor('button[aria-haspopup="dialog"]', 30000);
    await evaluate(`document.querySelector('button[aria-haspopup="dialog"]').click()`);
    await waitFor('[data-school-picker]');
    await kbOpen(280);
    const headS = await rect('[data-school-picker] > div');
    assert.ok(headS && headS.bottom <= 281, `header visible at 320x640/280`);
    await type('#onboarding-school', '서울');
    await waitFor('[data-results-list] li button', 8000);
    const shots9 = await save('09-picker-open-320');
    console.log('    evidence', shots9);
    await evaluate(`document.querySelector('[data-results-list] li button').click()`);
    await waitUntil(`!document.querySelector('[data-school-picker]')`, 'picker closes at 320px');
    assert.match(
      await evaluate(`document.querySelector('button[aria-haspopup="dialog"]').textContent`),
      /서울특별시제일과학/,
    );
    ok('selection works on the small viewport');
    await evaluate(`document.activeElement.blur()`);
    await kbOpen(640);
    kb = await kbState();
    assert.equal(kb.flag, null);
    const footerRect = await rect('footer');
    assert.ok(footerRect && Math.abs(footerRect.bottom - 640) < 2, JSON.stringify(footerRect));
    ok('closed state: footer sits at the viewport bottom with no dead gap');
    assert.ok(await noXOverflow());
    ok('no horizontal overflow at 320px');
    const shots10 = await save('10-closed-320');
    console.log('    evidence', shots10);

    const devNoise = [
      /favicon/i,
      /turbopack|hmr|webpack|Fast Refresh|hot-reloader|WebSocket|hot-update/i,
      /Download the React DevTools/i,
      /preload|source map/i,
    ];
    const unexpected = cdp.events
      .filter(
        (e) =>
          (e.method === 'Runtime.consoleAPICalled' &&
            ['error', 'warning'].includes(e.params.type)) ||
          e.method === 'Runtime.exceptionThrown' ||
          (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'),
      )
      .filter((e) => !intentionalErrors.has(e))
      .map((e) => JSON.stringify(e.params).slice(0, 300))
      .filter((line) => !devNoise.some((pattern) => pattern.test(line)));
    assert.deepEqual(unexpected, [], `unexpected console errors: ${unexpected.join(' | ')}`);
    const realFulfillFailures = fulfillFailures.filter((f) => f !== 'schools-stale');
    assert.deepEqual(
      realFulfillFailures,
      [],
      `fulfill failures beyond the aborted stale request: ${realFulfillFailures.join(', ')}`,
    );
    console.log(`\n${checks} simulated-viewport checks passed at ${BASE}`);
    console.log(`KEYBOARD_BROWSER_OK evidence=${OUT}`);
  } finally {
    await close();
    await staticServer?.stop();
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
