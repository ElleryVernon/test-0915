// Browser evidence for the planner follow-up (suggestion exposure rules R1–R7 and the fixed-schedule icon).
// Serves the tree's own build with the AI key emptied, so every suggestion is rule-based and nothing is paid
// for; a throwaway qa-planner account is seeded and deleted. Learner data is never touched.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/lib/server/db';
import { createSession, SESSION_COOKIE } from '../src/lib/server/auth';
import { assertLoopbackDatabase, consoleErrors, launchChrome, openPage, serveBuild } from './lib/browser';

assertLoopbackDatabase();
const out = 'docs/screenshots/schedule-review';
mkdirSync(out, { recursive: true });
const pad = (n: number) => String(n).padStart(2, '0');
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plus = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return key(d);
};
const [D0, D1, D2, D3] = [0, 1, 2, 3].map(plus);

async function seed(prefix: string) {
  const user = await db.user.create({
    data: { id: `${prefix}-student`, name: '시간표 검증', nickname: prefix.slice(0, 30), role: 'STUDENT', school: '검증고', grade: '고2', completedSubjects: [] },
  });
  const subjects: Record<string, string> = {};
  for (const name of ['생명과학I', '수학II', '한국사'])
    subjects[name] = (await db.subject.create({ data: { userId: user.id, name, semester: '2026 2학기' } })).id;
  for (const [name, count] of [['생명과학I', 6], ['한국사', 3]] as const)
    for (let i = 0; i < count; i++)
      await db.card.create({ data: { userId: user.id, subjectId: subjects[name], front: `${name} 카드 ${i + 1}`, back: '검증', nextReviewAt: new Date(Date.now() - 3600_000) } });
  const fixed = (date: string) => ({ userId: user.id, title: '학교', date, start: '08:40', end: '16:00', kind: 'FIXED' as const, done: false });
  await db.schedule.createMany({ data: [fixed(D0), fixed(D1), fixed(D2), fixed(D3)] });
  const cookie = (await createSession(user.id, new Request('http://127.0.0.1'))).split(';')[0].split('=')[1];
  return { user, cookie };
}

const server = await serveBuild({ OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '' });
const prefix = `qa-planner-${randomUUID().slice(0, 8)}`;
const { cdp, close } = await launchChrome();
const report: Record<string, unknown> = {};
try {
  const { cookie } = await seed(prefix);
  const boot = await fetch(`${server.url}/api/bootstrap`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } }).then((r) => r.json());
  assert.equal(boot.data?.aiAvailable, false, 'the verification server must not reach a paid AI provider');

  const page = await openPage(cdp, { width: 390, height: 844, cookie: { name: SESSION_COOKIE, value: cookie } });
  const { evaluate, waitFor, waitUntil, click, shot, send } = page;
  const posts: string[] = [];
  cdp.on((m) => {
    if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'POST' && m.params.request.url.includes('/api/planner/suggest')) posts.push(m.params.requestId);
  });
  const state = () =>
    evaluate(`({
      sheet: document.querySelector('.sheet-content .sheet-heading h2')?.textContent ?? null,
      plans: document.querySelectorAll('.sheet-content .planner-plan').length,
      day: document.querySelector('.week-day[aria-pressed=true]')?.dataset.date ?? null,
      cta: document.querySelector('.planner-cta .btn')?.textContent ?? null,
      notice: document.querySelector('.planner-ready')?.textContent ?? null,
      toast: document.querySelector('.toast')?.textContent ?? null,
    })`);
  const save = async (name: string, extra: object = {}) => {
    // Sheets slide in; a screenshot mid-animation is not evidence of the settled screen.
    await evaluate(`Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 1500))])`);
    const metrics = await evaluate(`({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth })`);
    writeFileSync(join(out, `followup-${name}-390.png`), await shot());
    writeFileSync(join(out, `followup-${name}-390.json`), JSON.stringify({ ...metrics, ...(await state()), ...extra }, null, 2) + '\n');
    assert.equal(metrics.horizontalOverflow, false, `${name}: horizontal overflow`);
  };
  const open = async (path: string) => {
    await send('Page.navigate', { url: server.url + path });
    await waitFor('.week-strip');
  };
  const tab = async (label: string, ready: string) => {
    await click('.bottom-nav .nav-item', label);
    await waitFor(ready);
  };
  const nextDay = () => evaluate(`document.querySelector('.week-day[aria-pressed=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  const goTo = async (date: string) => {
    for (let i = 0; i < 7 && (await state()).day !== date; i++) {
      await nextDay();
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal((await state()).day, date, `could not reach ${date}`);
  };
  const closeSheet = async () => {
    await click('.sheet-content .sheet-heading .icon-button');
    await waitUntil(`!document.querySelector('.sheet-content')`, 'sheet to close');
  };
  // Long enough for the entry lookup (IndexedDB + status GET) that used to reopen the sheet.
  const settle = () => new Promise((r) => setTimeout(r, 3000));
  const noSheet = async (rule: string) => {
    await settle();
    const s = await state();
    assert.equal(s.sheet, null, `${rule}: a sheet opened by itself (${s.sheet})`);
    return s;
  };

  // Today: the fixed card and the add sheet carry no lock (leaf-1.2).
  await open('/planner');
  await waitFor('.planner-list');
  const lockOnCards = await evaluate(`document.querySelectorAll('.planner-screen svg[data-icon="LockKeyhole"]').length`);
  await save('timetable', { lockIcons: lockOnCards, fixedCards: await evaluate(`document.querySelectorAll('.planner-item[data-state=fixed], .planner-item[data-state=current]').length`) });
  await click('.header-actions button[aria-label="일정 추가"]');
  await waitFor('.planner-editor .segmented-control');
  await evaluate(`document.activeElement?.blur()`);
  const segment = await evaluate(`(() => { const options = [...document.querySelectorAll('.planner-editor .segmented-control .segment-option')]; return { lockIcons: document.querySelectorAll('.sheet-content svg[data-icon="LockKeyhole"]').length, labels: options.map((o) => o.textContent.trim()), heights: options.map((o) => Math.round(o.getBoundingClientRect().height)), fontSizes: options.map((o) => getComputedStyle(o).fontSize), icons: options.map((o) => o.querySelectorAll('svg').length) }; })()`);
  await save('add-sheet', { segment });
  await closeSheet();

  // R2: a request made here opens its answer. Then R1/R5: closing it keeps it quiet across tab switches.
  await goTo(D1);
  await waitFor('.planner-cta .btn');
  assert.match(String((await state()).cta), /^빈 .+ 채우기$/, 'fresh day offers the fill CTA');
  await click('.planner-cta .btn');
  await waitFor('.sheet-content .planner-plan', 15000);
  assert.equal(posts.length, 1, 'one request for the first fill');
  const firstBlock = await evaluate(`(() => { const b = document.querySelector('.planner-plan[aria-pressed=true] .planner-plan-block'); return { start: b.querySelector('b').textContent, length: b.querySelector('small').textContent }; })()`);
  await closeSheet();
  await tab('학습', '.study-today');
  await tab('시간표', '.week-strip');
  let s = await noSheet('R1 tab switch');
  assert.equal(s.day, D0, 'R1: entering the planner keeps today selected');
  assert.equal(s.notice, null, 'a seen suggestion raises no notice');
  await send('Page.reload');
  await waitFor('.week-strip');
  s = await noSheet('R1 reload');
  assert.equal(s.day, D0, 'R1: a reload keeps today selected');
  await goTo(D1);
  await waitUntil(`document.querySelector('.planner-cta .btn')?.textContent === '추천 다시 보기'`, 'R5: "추천 다시 보기" on the suggestion day');
  await save('reopen');
  await click('.planner-cta .btn');
  await waitFor('.sheet-content .planner-plan');
  assert.equal(posts.length, 1, 'R5: reopening a seen suggestion sends no request');
  await closeSheet();

  // R6: a schedule that takes the first suggested block makes the suggestion stale.
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const time = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const start = minutes(firstBlock.start);
  const created = await fetch(`${server.url}/api/schedules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${cookie}` },
    body: JSON.stringify({ title: '겹치는 일정', date: D1, start: time(start), end: time(start + 20), kind: 'FIXED' }),
  });
  assert.ok(created.ok, `overlapping schedule was saved (${created.status})`);
  await send('Page.reload');
  await waitFor('.week-strip');
  await noSheet('R6 reload');
  await goTo(D1);
  await waitUntil(`/^빈 .+ 채우기$/.test(document.querySelector('.planner-cta .btn')?.textContent ?? '')`, 'R6: stale suggestion returns the fill CTA');
  await save('stale');
  await click('.planner-cta .btn');
  await waitFor('.sheet-content .planner-plan', 15000);
  assert.equal(posts.length, 2, 'R6: a stale suggestion is replaced by a new request');
  await closeSheet();

  // R3/R4: a request that finishes while the learner is away is announced, never opened by itself.
  await goTo(D2);
  await waitFor('.planner-cta .btn');
  await send('Fetch.enable', {
    patterns: [
      { urlPattern: '*/api/planner/suggest*', requestStage: 'Response' },
      { urlPattern: '*/api/ai-runs/*', requestStage: 'Request' },
    ],
  });
  const held: string[] = [];
  cdp.on((m) => {
    if (m.method === 'Fetch.requestPaused') held.push(m.params.requestId);
  });
  await click('.planner-cta .btn');
  for (let i = 0; i < 100 && !held.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(held.length > 0, 'the away request reached the server');
  await tab('학습', '.study-today');
  for (const id of held) await send('Fetch.failRequest', { requestId: id, errorReason: 'Aborted' }).catch(() => {});
  await send('Fetch.disable');
  await tab('시간표', '.week-strip');
  await waitUntil(`document.querySelector('.planner-ready')`, 'R4: notice for the other day', 12000);
  s = await noSheet('R3 finished while away');
  assert.equal(s.day, D0, 'R3: no jump to the suggestion day');
  const noticeDay = await evaluate(`document.querySelector('.planner-ready')?.dataset.date ?? null`);
  assert.equal(noticeDay, D2, 'R4: the notice names the suggestion day');
  const toasts = await evaluate(`[...document.querySelectorAll('.toast')].map((t) => t.textContent)`);
  assert.ok(!toasts.some((t: string) => t.includes('추천이 준비됐어요')), `R4: another day is announced by the notice alone (${toasts})`);
  await save('notice');
  await click('.planner-ready');
  await waitFor('.sheet-content .planner-plan');
  s = await state();
  assert.equal(s.day, D2, 'R4: the notice opens its day');
  assert.equal(posts.length, 3, 'R4: opening a finished suggestion sends no request');

  // Applying ends it: it never comes back.
  await click('.sheet-content .planner-submit .btn-primary', '담기');
  await waitUntil(`!document.querySelector('.sheet-content')`, 'sheet to close after applying', 15000);
  await tab('학습', '.study-today');
  await tab('시간표', '.week-strip');
  s = await noSheet('applied suggestion');
  assert.equal(s.notice, null, 'an applied suggestion raises no notice');
  await goTo(D2);
  assert.ok(!/추천 (다시 )?보기/.test(String((await state()).cta)), 'an applied suggestion leaves no reopen CTA');

  // R7: a failed request is shown as the answer to the tap, then stays quiet across tab switches.
  await goTo(D3);
  await waitFor('.planner-cta .btn');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/planner/suggest*', requestStage: 'Request' }] });
  const fail = (m: any) => {
    if (m.method === 'Fetch.requestPaused')
      void send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 422, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: '검증용으로 실패시킨 추천이에요.' })).toString('base64') });
  };
  cdp.on(fail);
  await click('.planner-cta .btn');
  await waitFor('.sheet-content .planner-error', 15000);
  await send('Fetch.disable');
  await closeSheet();
  await tab('학습', '.study-today');
  await tab('시간표', '.week-strip');
  s = await noSheet('R7 failed request');
  assert.equal(s.notice, null, 'R7: a failed request raises no notice');

  // Only the requests this script failed or held on purpose may log; anything else is a real error.
  const errors = consoleErrors(cdp, [/\/api\/planner\/suggest/, /\/api\/ai-runs\//, /검증용으로 실패시킨 추천이에요/]);
  writeFileSync(join(out, 'followup-console.json'), JSON.stringify(errors, null, 2) + '\n');
  assert.deepEqual(errors, [], 'console errors');
  report.posts = posts.length;
  report.segment = segment;
  console.log(JSON.stringify(report));
  console.log(`PLANNER_FOLLOWUP_CAPTURE_OK (${posts.length} requests, all rule-based; R1–R7 held; lock icons on cards ${lockOnCards}, in the add sheet ${segment.lockIcons})`);
} finally {
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  assert.equal(await db.user.count({ where: { id: { startsWith: prefix } } }), 0);
  await close();
  await server.stop();
  await db.$disconnect();
}
