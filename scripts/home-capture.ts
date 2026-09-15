// Gate leaf-7 H3: the home screen's empty "이어서 하기" states in a real headless Chrome against the
// static build served by the Go server. Isolated qa students: (A) sample material only → "오늘 시작하기"
// with three verb-chip rows; (B) no material → the first-material onboarding card; (C) the sample
// button on B turns it into A without an upload; (D) the demo student's review card whose CTA no
// longer repeats the count; (E) 사진 찍기 with a subject; (F) 복습 카드 만들기 keeps its sheet open;
// (G) 사진 찍기 with no subject opens the subject editor. Captures go to docs/screenshots/home/. AI key empty; qa data removed.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consoleErrors, launchChrome, openPage } from './lib/browser';
import { db, useServer } from './lib/db';
import { serveStatic } from './lib/goserve';
import { createSession, tokenHash } from './lib/session';

const outDir = 'docs/screenshots/home';
mkdirSync(outDir, { recursive: true });
let checks = 0;
let captures = 0;
const check = (ok: unknown, message: string) => {
  assert.ok(ok, message);
  checks++;
};
const save = (name: string, png: Buffer) => {
  writeFileSync(join(outDir, name), png);
  captures++;
};
const settled = async (page: {
  evaluate: (expression: string) => Promise<unknown>;
  shot: () => Promise<Buffer>;
}) => {
  await page.evaluate(
    `new Promise((done) => { const wait = () => (document.getAnimations().every((a) => a.playState === 'finished' || a.playState === 'idle') ? done(true) : setTimeout(wait, 50)); wait(); })`,
  );
  await new Promise((r) => setTimeout(r, 150));
  return page.shot();
};
const text = (page: { evaluate: (expression: string) => Promise<unknown> }) =>
  page.evaluate(`document.body.innerText`) as Promise<string>;
const prefix = `qa-home-${randomUUID().slice(0, 8)}`;

const server = await serveStatic();
useServer(server.url);
const chrome = await launchChrome();
const cleanup: (() => Promise<void>)[] = [];
try {
  const student = async (name: string) => {
    const user = await db.user.create({
      data: {
        id: `${prefix}-${name}`,
        name: '홈 검증',
        nickname: `${prefix}-${name}`,
        role: 'STUDENT',
        points: 0,
      },
    });
    cleanup.push(async () => {
      await db.session.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
    });
    const token = (await createSession(user.id, new Request(server.url)))
      .split(';')[0]
      .split('=')[1];
    const page = await openPage(chrome.cdp, {
      width: 390,
      height: 844,
      cookie: { name: 'memoryz_session', value: token },
    });
    return { user, page };
  };

  // (B) then (C): a brand-new student.
  const fresh = await student('fresh');
  await fresh.page.send('Page.navigate', { url: `${server.url}/` });
  await fresh.page.waitFor('.home-start-card', 20000);
  let body = await text(fresh.page);
  check(
    /첫 자료로 시작하기/.test(body) && /사진 찍기/.test(body) && /샘플 자료로 체험/.test(body),
    'B: onboarding card with both actions',
  );
  check(
    !/이어서 하기|오늘 시작하기|최근 자료|진행 중인 공부가 없어요/.test(body),
    'B: no continue, start or recent-material section',
  );
  check(/공부 시간 정하기 · 2분/.test(body), 'B: agenda row invites a first study time');
  save('start-onboarding.png', await settled(fresh.page));
  await fresh.page.click('.home-start-plain');
  await fresh.page.waitFor('.home-action-chip', 20000);
  body = await text(fresh.page);
  check(
    /오늘 시작하기/.test(body) && /3\. 항상성과 몸의 조절/.test(body),
    'C: the sample turns the card into "오늘 시작하기" on the sample chapter',
  );
  check(
    /문제 2개 풀기/.test(body) && /서술형 1개 쓰기/.test(body) && /복습 카드 만들기/.test(body),
    'C: three actions from the sample material',
  );
  const chips: string[] = (await fresh.page.evaluate(
    `Array.from(document.querySelectorAll('.home-action-chip')).map((c) => c.textContent)`,
  )) as string[];
  check(chips.join(',') === '풀기,쓰기,만들기', `C: verb chips (${chips.join(',')})`);
  check(
    (await db.material.count({ where: { userId: fresh.user.id } })) === 1 &&
      (await db.question.count({ where: { userId: fresh.user.id } })) === 2,
    'C: sample stored once',
  );
  save('start-after-sample.png', await settled(fresh.page));

  // (A) a student who already has the sample and nothing in progress, opened cold.
  const settledStudent = await student('sample');
  const made = await fetch(`${server.url}/api/materials/sample`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `memoryz_session=${(await createSession(settledStudent.user.id, new Request(server.url))).split(';')[0].split('=')[1]}`,
    },
    body: '{}',
  });
  check(made.status === 201, `A: sample made for the cold student (${made.status})`);
  await settledStudent.page.send('Page.navigate', { url: `${server.url}/` });
  await settledStudent.page.waitFor('.home-action-chip', 20000);
  body = await text(settledStudent.page);
  check(/오늘 시작하기/.test(body) && !/이어서 하기/.test(body), 'A: start section on a cold load');
  const rowHeights: number[] = (await settledStudent.page.evaluate(
    `Array.from(document.querySelectorAll('.home-action-chip')).map((c) => Math.round(c.closest('.list-row').getBoundingClientRect().height))`,
  )) as number[];
  check(
    rowHeights.length === 3 && rowHeights.every((h) => h >= 64 && h <= 80),
    `A: three 64px-class rows (${rowHeights.join(',')})`,
  );
  const chevrons: number = (await settledStudent.page.evaluate(
    `Array.from(document.querySelectorAll('.home-action-chip')).filter((c) => c.parentElement.querySelector('svg')).length`,
  )) as number;
  check(chevrons === 0, 'A: chip rows carry no chevron');
  save('start-actions.png', await settled(settledStudent.page));

  // (E) "사진 찍기" with a subject: the camera-first upload sheet opens, and Back returns home instead
  // of bouncing to the sheet again (the intent replaces its history entry).
  const camera = await student('camera');
  await db.subject.create({ data: { userId: camera.user.id, name: '카메라 검증 과목' } });
  await camera.page.send('Page.navigate', { url: `${server.url}/` });
  await camera.page.waitFor('.home-start-ink', 20000);
  await camera.page.click('.home-start-ink');
  await camera.page.waitFor('.upload-capture-main', 20000);
  check(
    /^\/subjects\/[^/]+$/.test(String(await camera.page.evaluate('location.pathname'))),
    'E: 사진 찍기 lands on the subject upload sheet',
  );
  await camera.page.evaluate('history.back()');
  await camera.page.waitUntil(
    `location.pathname === '/' && !!document.querySelector('.home-start-card')`,
    'home after Back',
    20000,
  );
  await new Promise((r) => setTimeout(r, 800));
  check(
    (await camera.page.evaluate('location.pathname')) === '/' &&
      !(await camera.page.evaluate(`!!document.querySelector('.upload-capture-main')`)),
    'E: Back from the camera sheet stays home (no trap)',
  );

  // (F) "복습 카드 만들기" on the cold student's start card: the flashcard screen opens its generation
  // sheet on that material and keeps it open after the intent leaves the address (a replace that
  // remounted the screen used to close it within a frame).
  await settledStudent.page.evaluate(
    `Array.from(document.querySelectorAll('.home-action-chip')).find((c) => c.textContent === '만들기').closest('.list-row').click()`,
  );
  await settledStudent.page.waitUntil(
    `location.pathname === '/flashcards' && !location.search.includes('generate') && !!document.querySelector('[role=dialog]')`,
    'generation sheet on /flashcards',
    20000,
  );
  await new Promise((r) => setTimeout(r, 800));
  const sheet = String(
    await settledStudent.page.evaluate(`document.querySelector('[role=dialog]')?.innerText ?? ''`),
  );
  check(
    /만들기/.test(sheet) && /항상성과 몸의 조절/.test(sheet),
    `F: the generation sheet stays open on the named material (${sheet.slice(0, 60).replace(/\s+/g, ' ')})`,
  );

  // (G) "사진 찍기" with no subject yet: the subject editor opens and stays open.
  const firstTimer = await student('nosubject');
  await firstTimer.page.send('Page.navigate', { url: `${server.url}/` });
  await firstTimer.page.waitFor('.home-start-ink', 20000);
  await firstTimer.page.click('.home-start-ink');
  await firstTimer.page.waitUntil(
    `location.pathname === '/study' && !!document.querySelector('[role=dialog]')`,
    'subject editor on /study',
    20000,
  );
  await new Promise((r) => setTimeout(r, 800));
  const editor = String(await firstTimer.page.evaluate(`document.querySelector('[role=dialog]')?.innerText ?? ''`));
  check(
    /어떤 과목을 공부하나요\?/.test(editor) && !(await firstTimer.page.evaluate(`location.search.includes('upload')`)),
    `G: with no subject the editor opens and the intent leaves the address (${editor.slice(0, 40).replace(/\s+/g, ' ')})`,
  );

  // (D) the demo student's review card: the CTA no longer repeats the count.
  const demoToken = (await createSession('demo-student', new Request(server.url)))
    .split(';')[0]
    .split('=')[1];
  cleanup.push(async () => {
    await db.session.deleteMany({ where: { id: tokenHash(demoToken) } });
  });
  const demo = await openPage(chrome.cdp, {
    width: 390,
    height: 844,
    cookie: { name: 'memoryz_session', value: demoToken },
  });
  await demo.send('Page.navigate', { url: `${server.url}/` });
  await demo.waitFor('.review-start', 20000);
  const cta: string = (await demo.evaluate(
    `document.querySelector('.review-start').textContent`,
  )) as string;
  const count: string = (await demo.evaluate(
    `document.querySelector('.home-review-count strong').textContent`,
  )) as string;
  check(
    !/\d+장 복습 시작/.test(cta) && (cta.trim() === '복습 시작' || !/^\d/.test(count)),
    `D: CTA "${cta.trim()}" next to the count ${count}`,
  );
  save('review-cta.png', await settled(demo));

  const errors = consoleErrors(chrome.cdp, [/favicon/]);
  check(errors.length === 0, `console errors: ${JSON.stringify(errors)}`);
  console.log(`HOME_CAPTURE_OK captures=${captures} checks=${checks}`);
} finally {
  for (const step of cleanup.reverse()) await step().catch(() => {});
  await chrome.close();
  await server.stop();
  await db.$disconnect();
}
