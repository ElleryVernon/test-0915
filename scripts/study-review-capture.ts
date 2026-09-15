// Browser evidence for the study review: a throwaway qa- account per viewport, driven through a local
// production server with headless Chrome over the DevTools protocol (no extra packages). Without
// TEST_APP_URL it serves the current `.next` build on a free loopback port and stops it afterwards, so the
// evidence always belongs to this tree's build. Learner data is never touched; the qa- account is deleted
// afterwards. Requires Chrome (CHROME_PATH overrides the macOS path).
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from './lib/db';
import { createSession, SESSION_COOKIE } from './lib/session';

async function serveBuild(): Promise<{ url: string; server: ChildProcess }> {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
  const server = spawn('node_modules/.bin/next', ['start', '--hostname', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('next start exited before it was ready');
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) return { url, server };
    await new Promise((r) => setTimeout(r, 200));
  }
  server.kill();
  throw new Error('next start was not ready in 20s');
}
const own = process.env.TEST_APP_URL ? null : await serveBuild();
const base = process.env.TEST_APP_URL ?? own!.url;
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = 'docs/screenshots/study-review';
const database = new URL(process.env.DATABASE_URL!);
assert(database.port === '15444' && database.pathname === '/memoryz', 'dedicated local database only');
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'loopback app only');
mkdirSync(out, { recursive: true });

const DAY = 86400000;
const seoul = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(date);
const seoulPlus = (days: number) =>
  new Date(Date.parse(`${seoul(new Date())}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

async function seed(prefix: string) {
  const now = Date.now();
  const user = await db.user.create({
    data: { id: `${prefix}-student`, name: '검증 학생', nickname: `${prefix}`.slice(0, 30), role: 'STUDENT', school: '검증고', grade: '고2' },
  });
  const subject = (name: string, extra = {}) =>
    db.subject.create({ data: { userId: user.id, name, semester: '2026 2학기', ...extra } });
  const history = await subject('한국사');
  const bio = await subject('생명과학I', { examName: '중간고사', examDate: seoulPlus(12) });
  const math = await subject('수학II');
  await subject('영어');
  const material = (subjectId: string, title: string, ageDays: number) =>
    db.material.create({ data: { userId: user.id, subjectId, title, content: `${title} 본문. 수업에서 정리한 내용을 바탕으로 한 검증용 자료입니다.`, type: 'TXT', createdAt: new Date(now - ageDays * DAY) } });
  const koryo = await material(history.id, '고려 초 왕권 강화', 3);
  await material(bio.id, '4. 호르몬과 항상성', 1);
  const homeostasis = await material(bio.id, '3. 항상성과 몸의 조절', 1);
  await material(bio.id, '세포 호흡 · 수업 자료', 0);
  await material(math.id, '미분계수와 도함수', 2);
  const question = (subjectId: string, materialId: string, prompt: string) =>
    db.question.create({ data: { userId: user.id, subjectId, materialId, prompt, options: ['가', '나', '다', '라', '마'], answer: 0, explanation: '', citation: prompt, past: '', future: '' } });
  const q1 = await question(bio.id, homeostasis.id, '인슐린이 분비되는 조건은?');
  await question(bio.id, homeostasis.id, '혈당이 낮을 때 분비되는 호르몬은?');
  await question(history.id, koryo.id, '노비안검법을 실시한 왕은?');
  await db.attempt.create({ data: { userId: user.id, questionId: q1.id, correct: false, score: 0, answer: '1', createdAt: new Date(now - DAY) } });
  const cards: { id: string }[] = [];
  const card = async (subjectId: string, type: string, front: string, back: string, bucket: string, dueInMs: number, reviews = 0) => {
    const created = await db.card.create({
      data: { userId: user.id, subjectId, front, back, type: type as never, bucket: bucket as never, nextReviewAt: new Date(now + dueInMs) },
    });
    for (let i = 0; i < reviews; i++)
      await db.cardReview.create({ data: { id: randomUUID(), userId: user.id, cardId: created.id, rating: 'GOOD', result: {}, createdAt: new Date(now - (i + 1) * DAY) } });
    cards.push(created);
    return created;
  };
  await card(history.id, 'COMPARISON', '광종과 성종의 정책을 비교하면?', '광종은 노비안검법·과거제로 왕권을 세웠고, 성종은 시무 28조를 받아 12목을 설치했어요.\n\n공통점은 호족 억제와 중앙 집권. 차이는 광종이 힘으로, 성종이 제도로 했다는 점이에요.', 'GOOD', -60000, 2);
  await card(bio.id, 'CONCEPT', '식사 후 혈당량이 높아졌을 때 일어나는 반응은?', '이자의 β세포에서 인슐린이 분비되어 혈당을 낮춰요.', 'AGAIN', -120000, 1);
  await card(bio.id, 'CONCEPT', '도약 전도란?', '말이집 신경에서 흥분이 랑비에 결절을 따라 건너뛰듯 전도되는 현상이에요.', 'AGAIN', -180000);
  await card(bio.id, 'COMPARISON', '인슐린과 글루카곤의 공통점과 차이점', '둘 다 이자에서 분비되어 혈당을 조절해요. 인슐린은 낮추고 글루카곤은 높여요.', 'HARD', -240000, 3);
  await card(bio.id, 'RELATION', '탈분극은 어떻게 일어날까?', 'Na+ 통로가 열려 Na+이 세포 안으로 들어오면서 막전위가 올라가요.', 'HARD', -300000, 1);
  await card(math.id, 'CONCEPT', '미분계수의 기하학적 의미는?', '곡선 위 한 점에서 그은 접선의 기울기예요.', 'GOOD', -360000, 2);
  await card(math.id, 'CONCEPT', 'f(x)=x²의 도함수는?', "f'(x)=2x", 'EASY', -420000, 4);
  await card(history.id, 'CONCEPT', '시무 28조를 수용한 왕은?', '성종', 'AGAIN', -480000, 1);
  await card(math.id, 'RELATION', '미분 가능하면 반드시 연속일까?', '네. 미분 가능하면 연속이지만, 연속이라고 모두 미분 가능하지는 않아요.', 'GOOD', -540000, 2);
  const long = await card(bio.id, 'CONCEPT', '항상성 유지에서 음성 피드백이 중요한 이유는?', '음성 피드백은 어떤 변화가 일어났을 때 그 변화를 줄이는 방향으로 반응이 일어나게 해서, 체온·혈당·삼투압처럼 몸의 내부 환경이 좁은 범위 안에서 일정하게 유지되도록 만드는 조절 방식이기 때문에 항상성 유지의 핵심이에요. 호르몬 분비량도 이 원리로 조절돼요.\n\n예를 들어 혈당이 높아지면 인슐린이 분비되어 혈당을 낮추고, 혈당이 정상 범위로 돌아오면 인슐린 분비가 줄어요.', 'HARD', 3 * DAY, 2);
  await card(bio.id, 'CONCEPT', '뉴런이란?', '신경계를 구성하는 기본 단위 세포예요.', 'EASY', 7 * DAY, 3);
  await card(history.id, 'CONCEPT', '노비안검법을 실시한 왕은?', '광종', 'MASTERED', 400 * DAY, 5);
  await card(bio.id, 'RELATION', '인슐린의 역할은?', '세포의 포도당 흡수를 늘려 혈당을 낮춰요.', 'MASTERED', 400 * DAY, 5);
  // Yesterday's and the day before's reviews make "어제 N장" and the streak real data.
  for (let i = 0; i < 6; i++)
    await db.cardReview.create({ data: { id: randomUUID(), userId: user.id, cardId: cards[i % cards.length].id, rating: 'GOOD', result: {}, createdAt: new Date(now - DAY - i * 60000) } });
  const cookie = (await createSession(user.id, new Request(base))).split(';')[0].split('=')[1];
  return { user, bio, long, cookie };
}

class Cdp {
  private id = 0;
  private pending = new Map<number, (message: any) => void>();
  readonly events: any[] = [];
  constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const done = message.id ? this.pending.get(message.id) : undefined;
      if (done) {
        this.pending.delete(message.id);
        done(message);
      } else this.events.push(message);
    };
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'memoryz-cdp-'));
  const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank']);
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

async function run(width: number, height: number) {
  const prefix = `qa-capture-${width}-${randomUUID().slice(0, 8)}`;
  const { cdp, close } = await launch();
  const report: Record<string, unknown> = {};
  try {
    const fixture = await seed(prefix);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method: string, params: object = {}) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await send('Network.setCookie', { name: SESSION_COOKIE, value: fixture.cookie, domain: '127.0.0.1', path: '/', httpOnly: true });
    const evaluate = async (expression: string) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`evaluate: ${result.exceptionDetails.text} ${expression.slice(0, 80)}`);
      return result.result.value;
    };
    const waitFor = async (selector: string) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timeout waiting for ${selector}`);
    };
    const settle = () => new Promise((r) => setTimeout(r, 450));
    const shot = async (name: string, measure: string) => {
      await settle();
      const metrics = await evaluate(`(() => {
        const r = (el) => el ? Math.round(el.getBoundingClientRect().height * 100) / 100 : null;
        const center = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return Math.round((b.top + b.height / 2) * 100) / 100; };
        const all = (sel) => [...document.querySelectorAll(sel)].map(r);
        const main = document.querySelector('#main-content') || document.body;
        const small = [...main.querySelectorAll('*')].filter((el) => {
          if (el.closest('.bottom-nav, .demo-note')) return false;
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          return own && parseFloat(getComputedStyle(el).fontSize) < 12;
        }).map((el) => el.className + ':' + el.textContent.trim().slice(0, 20));
        const brand = ['rgb(255, 111, 15)', 'rgb(201, 77, 9)'];
        const orangeText = [...main.querySelectorAll('*')].filter((el) => {
          if (el.closest('.bottom-nav, .demo-note')) return false;
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          return own && brand.includes(getComputedStyle(el).color);
        }).map((el) => el.className + ':' + el.textContent.trim().slice(0, 20));
        return { route: location.pathname + location.search, width: innerWidth, height: innerHeight,
          documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          header: r(document.querySelector('.study-header')),
          headerTitle: center(document.querySelector('.study-header .study-header-title, .study-header h1')),
          headerButton: center(document.querySelector('.study-header .icon-button')),
          smallText: small, orangeText, ...(${measure}) };
      })()`);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(out, `${name}-${width}.png`), Buffer.from(data, 'base64'));
      writeFileSync(join(out, `${name}-${width}.json`), JSON.stringify(metrics, null, 2) + '\n');
      report[name] = metrics;
      assert.equal(metrics.horizontalOverflow, false, `${name}@${width}: horizontal overflow`);
      assert.deepEqual(metrics.smallText, [], `${name}@${width}: text under 12px`);
      assert.deepEqual(metrics.orangeText, [], `${name}@${width}: orange text`);
      // Same header line as every other screen: the mock's 44px assumed a status bar the web does not have.
      assert.equal(metrics.header, shared.height, `${name}@${width}: header height`);
      if (metrics.headerTitle !== null)
        assert.ok(Math.abs(metrics.headerTitle - shared.title) <= 0.5, `${name}@${width}: title line ${metrics.headerTitle} vs ${shared.title}`);
      if (metrics.headerButton !== null)
        assert.ok(Math.abs(metrics.headerButton - shared.button) <= 0.5, `${name}@${width}: button line ${metrics.headerButton} vs ${shared.button}`);
      return metrics;
    };
    const go = async (path: string, selector: string) => {
      await send('Page.navigate', { url: base + path });
      await waitFor(selector);
    };
    const click = (selector: string, text?: string) =>
      evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('missing ${selector} ${text ?? ''}'); el.click(); return true; })()`);

    await go('/community', 'header.screen-header h1');
    const shared = await evaluate(`(() => {
      const header = document.querySelector('header.screen-header');
      const center = (el) => { const b = el.getBoundingClientRect(); return Math.round((b.top + b.height / 2) * 100) / 100; };
      return { height: header.getBoundingClientRect().height, title: center(header.querySelector('h1')), button: center(header.querySelector('.icon-button')) };
    })()`);
    assert.deepEqual(shared, { height: 64, title: 32, button: 32 }, 'shared header reference (community)');
    writeFileSync(join(out, `shared-header-${width}.json`), JSON.stringify(shared, null, 2) + '\n');

    await go('/study', '.study-today');
    const home = await shot('study-home', `{ todayRow: r(document.querySelector('.study-today')), subjectRows: all('.subject-library-row'), methodRows: all('.study-methods button'), sectionTitle: getComputedStyle(document.querySelector('.study-section-head h2')).fontSize, todayText: document.querySelector('.study-today').innerText.replace(/\\n/g, ' · '), ddays: [...document.querySelectorAll('.study-dday')].map((e) => e.textContent) }`);
    assert.equal(home.todayRow, 56);
    assert.ok((home.subjectRows as number[]).every((h) => h >= 64));
    assert.ok((home.methodRows as number[]).every((h) => h >= 56));
    assert.ok(String(home.todayText).endsWith('바로 가기'));
    // "바로 가기" opens the card library, not a review session.
    await click('.study-today');
    await waitFor('.recall-summary');
    assert.equal(await evaluate(`location.pathname + location.search`), '/flashcards');
    assert.equal(await evaluate(`!!document.querySelector('.recall-card')`), false);
    await go('/study', '.study-today');
    await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await shot('study-home-lower', '{}');
    await evaluate(`window.scrollTo(0, 0)`);
    await click('.header-actions button[aria-label="만들기"]');
    await waitFor('.study-create');
    await shot('create-sheet', `{ options: [...document.querySelectorAll('.study-create strong')].map((e) => e.textContent) }`);

    await go(`/subjects/${fixture.bio.id}`, '.subject-detail-title');
    const detail = await shot('subject-detail', `{ title: getComputedStyle(document.querySelector('.subject-detail-title')).fontSize, eyebrow: document.querySelector('.subject-detail-eyebrow').innerText, meta: document.querySelector('.subject-detail-meta').innerText, materialRows: all('.material-library-row'), materialMeta: [...document.querySelectorAll('.material-library-copy small')].map((e) => e.textContent), insight: document.querySelector('.subject-insight')?.innerText ?? null, ctaBottom: document.querySelector('.study-fixed-cta').getBoundingClientRect().bottom, navTop: document.querySelector('.bottom-nav')?.getBoundingClientRect().top ?? null }`);
    assert.ok((detail.ctaBottom as number) <= ((detail.navTop as number) ?? height) + 0.5, 'upload CTA sits above the tab bar');
    await click('.header-actions button[aria-label="과목 설정"]');
    await waitFor('.study-exam');
    await shot('subject-settings', `{ examName: document.querySelector('input[aria-label="시험 이름"]').value, examDate: document.querySelector('input[aria-label="시험 날짜"]').value }`);

    await go('/flashcards', '.recall-summary');
    const library = await shot('card-library', `{ cardRows: all('button.recall-list-row'), groups: [...document.querySelectorAll('.recall-group-head h2')].map((e) => e.innerText), summary: document.querySelector('.recall-summary').innerText.replace(/\\n/g, ' · '), legend: [...document.querySelectorAll('.recall-legend span')].map((e) => e.textContent), todayFronts: [...document.querySelectorAll('.recall-group:first-child .recall-row-front')].map((e) => e.textContent) }`);
    assert.ok((library.cardRows as number[]).every((h) => h >= 52));
    assert.ok(String((library.groups as string[])[0]).startsWith('오늘'));
    const todayFronts = library.todayFronts as string[];
    assert.equal(todayFronts.length, 9);
    await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await shot('card-library-lower', '{}');

    await go('/flashcards?review=1', '.recall-card');
    const front = await shot('review-front', `{ title: document.querySelector('.study-header-title').innerText.replace(/\\n/g, ' · '), meta: document.querySelector('.recall-card-meta').innerText.replace(/\\n/g, ' · '), question: document.querySelector('.recall-question')?.textContent ?? null, cta: getComputedStyle(document.querySelector('.recall-actions .btn-primary')).backgroundColor }`);
    assert.equal(front.cta, 'rgb(255, 111, 15)');
    assert.equal(front.question, todayFronts[0], 'the session starts where the "오늘" list starts');
    await click('.recall-actions .btn-primary', '정답 보기');
    await waitFor('.recall-card.is-back');
    const back = await shot('review-back', `{ ratingHeights: all('.recall-rating'), topLine: getComputedStyle(document.querySelector('.recall-card.is-back'), '::before').height, topLineColor: getComputedStyle(document.querySelector('.recall-card.is-back'), '::before').backgroundColor, cardBackground: getComputedStyle(document.querySelector('.recall-card.is-back')).backgroundColor, answer: getComputedStyle(document.querySelector('.recall-answer')).fontSize, intervals: [...document.querySelectorAll('.recall-rating small')].map((e) => e.textContent) }`);
    assert.ok((back.ratingHeights as number[]).every((h) => h >= 60));
    assert.equal(back.topLine, '4px');
    assert.equal(back.cardBackground, 'rgb(255, 255, 255)');
    // Rate every due card: two "다시" so the result screen offers a retry.
    const plan = ['GOOD', 'AGAIN', 'AGAIN', 'HARD', 'GOOD', 'EASY', 'GOOD', 'HARD', 'EASY'];
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      if (await evaluate(`!!document.querySelector('.recall-done')`)) break;
      if (!(await evaluate(`!!document.querySelector('.recall-card.is-back')`))) {
        await click('.recall-actions .btn-primary', '정답 보기');
        await waitFor('.recall-card.is-back');
      }
      seen.push(await evaluate(`document.querySelector('.recall-back-question')?.textContent ?? ''`));
      const label = { AGAIN: '다시', HARD: '어려움', GOOD: '보통', EASY: '쉬움' }[plan[i] ?? 'GOOD'];
      await click('.recall-rating', label);
      for (let j = 0; j < 40; j++) {
        if (await evaluate(`!!document.querySelector('.recall-done') || !document.querySelector('.recall-card.is-back')`)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await waitFor('.recall-done');
    assert.deepEqual(seen, todayFronts, 'the session walks the "오늘" list in order');
    const done = await shot('review-done', `{ headline: document.querySelector('.recall-done h1').innerText.replace(/\\n/g, ' · '), meta: document.querySelector('.recall-done-meta')?.innerText ?? null, counts: [...document.querySelectorAll('.recall-result-counts span')].map((e) => e.innerText.replace(/\\n/g, ' ')), again: [...document.querySelectorAll('.recall-again .recall-list-row')].map((e) => e.innerText.replace(/\\n/g, ' · ')), cta: [...document.querySelectorAll('.study-fixed-cta button')].map((e) => e.innerText) }`);
    assert.match(String(done.headline), /^9장 복습 끝 · 다음 복습은 .+장이에요$/);
    assert.equal((done.again as string[]).length, 2);

    await go(`/flashcards?card=${fixture.long.id}`, '.recall-card');
    await click('.recall-actions .btn-primary', '정답 보기');
    await waitFor('.recall-card.is-back');
    await shot('review-long-answer', `{ more: document.querySelector('.recall-more')?.innerText ?? null, explanationShown: !!document.querySelector('.recall-explanation'), answer: getComputedStyle(document.querySelector('.recall-answer')).fontSize }`);

    const errors = cdp.events
      .filter((e) => (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) || e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
      .map((e) => JSON.stringify(e.params).slice(0, 300));
    writeFileSync(join(out, `console-${width}.json`), JSON.stringify(errors, null, 2) + '\n');
    assert.deepEqual(errors, [], `console errors at ${width}`);
    return report;
  } finally {
    await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
    assert.equal(await db.user.count({ where: { id: { startsWith: prefix } } }), 0);
    await close();
  }
}

try {
  const results = { '390': await run(390, 844), '360': await run(360, 800) };
  const screens = Object.keys(results['390']);
  writeFileSync(
    join(out, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>학습 리뷰 화면 검증</title><style>body{font:14px system-ui;margin:24px;background:#f3f3f3}section{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:32px}figure{margin:0;background:#fff;padding:12px;border-radius:12px}img{width:260px;display:block;border-radius:8px}figcaption{margin-top:8px;color:#525257}</style><h1>학습 탭 리뷰 적용 · 실제 브라우저 캡처</h1><p>로컬 프로덕션 서버 · 검증용 QA 계정(캡처 후 삭제) · 390×844 / 360×800 · 측정값은 같은 이름의 JSON.</p>${screens
      .map((s) => `<h2>${s}</h2><section>${['390', '360'].map((w) => `<figure><img src="${s}-${w}.png" alt="${s} ${w}px"><figcaption>${w}px · <a href="${s}-${w}.json">측정값</a></figcaption></figure>`).join('')}</section>`)
      .join('')}`,
  );
  console.log(`STUDY_REVIEW_CAPTURE_OK (${screens.length} screens × 2 widths; no overflow, no text under 12px, no orange text, headers on the shared 64px line, review order = "오늘" list, console clean)`);
} finally {
  await db.$disconnect();
  if (own) {
    const stopped = new Promise((resolve) => own.server.once('exit', resolve));
    own.server.kill();
    await stopped;
  }
}
