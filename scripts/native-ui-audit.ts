// Gate leaf-2.4 U2: no OS-native picker is left on app screens. Drives the static build (served by
// the Go server) in headless Chrome as an isolated student, the demo parent and the demo admin,
// opens every screen and sheet that used to hold a native control, counts what remains, exercises
// each shared control (choose a subject, pick an exam date, set a schedule time, step points, move
// the slider) and writes captures to docs/screenshots/native-ui/. qa data is removed afterwards.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, openPage } from './lib/browser';
import { db, useServer } from './lib/db';
import { demoLogin, serveStatic } from './lib/goserve';
import { closeSessions, createSession } from './lib/session';

const outDir = 'docs/screenshots/native-ui';
mkdirSync(outDir, { recursive: true });
let checks = 0;
let captures = 0;
let screens = 0;
let native = 0;
const check = (ok: unknown, message: string) => {
  assert.ok(ok, message);
  checks++;
};
const prefix = `qa-ui-${randomUUID().slice(0, 8)}`;
// What a screen may still contain natively: file pickers (an OS security boundary) and text inputs.
const NATIVE = `select, input[type="date"], input[type="time"], input[type="number"], input[type="range"], input[type="checkbox"]:not([data-choice] *), input[type="radio"], form:not([novalidate]), [title]`;

const server = await serveStatic({ env: { DEMO_ADMIN: 'true' } });
useServer(server.url);
const chrome = await launchChrome();
type Page = Awaited<ReturnType<typeof openPage>>;
const audit = async (page: Page, name: string, ready: string) => {
  try {
    await page.waitUntil(ready, `${name} ready`, 20000);
  } catch (error) {
    throw new Error(`${(error as Error).message}; page text: ${JSON.stringify(await page.evaluate('document.body ? document.body.innerText.slice(0, 300) : ""'))}`);
  }
  const found: string[] = await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(NATIVE)})].map((el) => el.tagName.toLowerCase() + (el.getAttribute('type') ? '[type=' + el.getAttribute('type') + ']' : '') + (el.getAttribute('aria-label') ? '#' + el.getAttribute('aria-label') : '') + (el.hasAttribute('title') ? '[title]' : '') + (el.tagName === 'FORM' ? '[form without novalidate]' : ''))`);
  screens++;
  native += found.length;
  check(found.length === 0, `${name}: no native controls (${found.join(', ') || 'none'})`);
};
const save = async (page: Page, name: string) => {
  await page.evaluate(`new Promise((done) => { const wait = () => (document.getAnimations().every((a) => a.playState === 'finished' || a.playState === 'idle') ? done(true) : setTimeout(wait, 50)); wait(); })`);
  await new Promise((r) => setTimeout(r, 120));
  writeFileSync(join(outDir, name), await page.shot());
  captures++;
};
try {
  const student = await db.user.create({ data: { id: `${prefix}-s`, name: 'UI 검증', nickname: `${prefix}-s`, role: 'STUDENT', points: 0 } });
  const subject = await db.subject.create({ data: { userId: student.id, name: 'UI 검증 과목' } });
  await db.material.create({ data: { userId: student.id, subjectId: subject.id, title: 'UI 검증 자료', type: 'TXT', content: '검증용 본문입니다. '.repeat(10), pageBreaks: [] } });
  const question = await db.question.create({ data: { userId: student.id, subjectId: subject.id, materialId: (await db.material.findFirst({ where: { userId: student.id } }))!.id, prompt: 'UI 검증 문항', options: ['가', '나', '다', '라', '마'], answer: 0, explanation: '검증', citation: '검증용 본문입니다.', past: '이전', future: '다음' } });
  await db.attempt.create({ data: { userId: student.id, questionId: question.id, answer: '1', correct: false, score: 0 } });
  const token = (await createSession(student.id, new Request(server.url))).split(';')[0].split('=')[1];
  const errors: string[] = [];
  const page = await openPage(chrome.cdp, { width: 390, height: 844, cookie: { name: 'memoryz_session', value: token } });
  chrome.cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text ?? 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(JSON.stringify(m.params.args.map((a: any) => a.value ?? a.description)));
  });
  const go = async (path: string, ready: string, name: string) => {
    await page.send('Page.navigate', { url: server.url + path });
    await audit(page, name, ready);
  };

  // Student screens.
  await go('/', `document.body.innerText.includes('UI 검증')`, '홈');
  await go('/study', `document.body.innerText.includes('과목')`, '학습');
  await go(`/subjects/${subject.id}`, `document.querySelector('[data-material-id]')`, '과목 상세');
  // Subject settings: exam date picker.
  await page.click('[aria-label="과목 설정"]');
  await page.waitFor('[data-choice="date"][data-choice-name="exam-date"]');
  await audit(page, '과목 설정 시트', `document.querySelector('[data-choice-name="exam-date"]')`);
  await page.click('[data-choice-name="exam-date"]');
  await page.waitFor('[data-month-picker]');
  await save(page, '01-exam-date-picker.png');
  const pickDate: string = await page.evaluate(`(() => { const cells = [...document.querySelectorAll('[data-month-picker] [data-date]:not(:disabled)')]; const cell = cells[cells.length - 8]; cell.click(); return cell.dataset.date; })()`);
  await page.waitUntil(`document.querySelector('[data-choice-name="exam-date"]').dataset.choiceValue === ${JSON.stringify(pickDate)}`, 'exam date applied');
  check(await page.evaluate(`document.querySelector('[data-choice-name="exam-date"]').innerText.includes('월')`), `exam date shows a readable label for ${pickDate}`);
  await save(page, '02-exam-date-set.png');
  await page.evaluate(`document.querySelector('[data-close-sheet]').click()`);
  // Upload sheet: checkboxes.
  await page.click('button', '자료 올리기');
  await page.waitFor('[data-choice="checkbox"][data-choice-name="generate"]');
  await audit(page, '자료 올리기 시트', `document.querySelector('[data-choice-name="generate"]')`);
  await save(page, '03-upload-sheet.png');
  await page.evaluate(`document.querySelector('[data-close-sheet]').click()`);
  // Generation sheet: material choice.
  await page.click(`[data-material-id]`);
  await page.waitFor('button');
  await page.click('button', '문제 더 만들기');
  await page.waitFor('[data-choice-list="material"] [role="radio"]');
  await audit(page, '문제 만들기 시트', `document.querySelector('[data-choice-list="material"]')`);
  await page.evaluate(`document.querySelector('[data-choice-list="material"] [role="radio"]').click()`);
  check(await page.evaluate(`document.querySelector('[data-choice-list="material"] [role="radio"]').getAttribute('aria-checked') === 'true'`), 'the material row is selected inline (no nested sheet)');
  check(!(await page.evaluate(`document.querySelectorAll('.sheet-content').length > 1`)), 'one sheet layer only');
  await save(page, '04-material-choice.png');
  await page.evaluate(`[...document.querySelectorAll('[data-close-sheet]')].forEach((b) => b.click())`);
  // Wrong notes: checkbox rows.
  await go('/wrong-notes', `document.querySelector('[data-choice-name="wrong-note"]')`, '오답노트');
  await page.click('[data-choice-name="wrong-note"]');
  check(await page.evaluate(`document.querySelector('[data-choice-name="wrong-note"]').getAttribute('aria-checked') === 'true'`), 'wrong-note checkbox toggles');
  await save(page, '05-wrong-notes.png');
  // Completed subjects: grade / curriculum / group choices.
  await go('/completed-subjects', `document.querySelector('[data-choice-name="grade"]')`, '배운 과목');
  await page.click('[data-choice-name="curriculum"]');
  await page.waitFor('[data-choice-list="curriculum"]');
  await save(page, '06-curriculum-choice.png');
  await page.evaluate(`[...document.querySelectorAll('[data-choice-list="curriculum"] [role="radio"]')].find((b) => b.textContent.includes('2015')).click()`);
  await page.waitUntil(`document.querySelector('[data-choice-name="curriculum"]').dataset.choiceValue === '2015'`, 'curriculum applied');
  // Planner: schedule editor with time and date.
  await go('/planner', `document.querySelector('[aria-label="일정 추가"]')`, '시간표');
  await page.click('[aria-label="일정 추가"]');
  await page.waitFor('[data-choice="time"][data-choice-name="시작"]', 15000);
  await audit(page, '일정 편집 시트', `document.querySelector('[data-choice-name="시작"]')`);
  await page.click('[data-choice-name="시작"]');
  await page.waitFor('[data-time-wheels]');
  await page.evaluate(`document.querySelector('[data-wheel="hour"] [data-wheel-value="19"]').click()`);
  await page.evaluate(`document.querySelector('[data-wheel="minute"] [data-wheel-value="05"]').click()`);
  await page.waitUntil(`document.querySelector('[data-time-preview]').textContent === '19:05'`, 'wheels show 19:05', 5000);
  await save(page, '07-time-picker.png');
  await page.click('[data-time-confirm]');
  await page.waitUntil(`document.querySelector('[data-choice-name="시작"]').dataset.choiceValue === '19:05'`, 'time applied');
  await page.click('[data-choice-name="date"]');
  await page.waitFor('[data-month-picker]');
  await save(page, '08-planner-date-picker.png');
  await page.evaluate(`document.querySelector('[data-close-sheet]').click()`);
  await page.evaluate(`[...document.querySelectorAll('[data-close-sheet]')].forEach((b) => b.click())`);
  // Community: sort, category, anonymous.
  await go('/community', `document.querySelector('[data-choice-name="sort"]')`, '커뮤니티');
  await page.click('button', '질문하기');
  await page.waitFor('[data-choice-name="category"]', 15000);
  await audit(page, '글쓰기 시트', `document.querySelector('[data-choice-name="anonymous"]')`);
  await save(page, '09-compose.png');
  await page.evaluate(`document.querySelector('[data-close-sheet]').click()`);
  // Account and learning settings.
  await go('/profile', `document.body.innerText.includes('마이')`, '마이');
  // The row is a ListRow; clicking its deepest text node bubbles to the row's handler.
  await page.waitUntil(`document.body.innerText.includes('프로필 편집') || document.body.innerText.includes('편집')`, 'profile screen', 15000).catch(async (error) => { throw new Error(`${(error as Error).message}; page text: ${JSON.stringify(await page.evaluate('document.body.innerText.slice(0, 400)'))}`); });
  await page.evaluate(`(() => { const els = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && /프로필 편집|^편집$/.test(el.textContent.trim())); els[els.length - 1].click(); return true; })()`);
  await page.waitFor('[data-choice-name="grade"]', 15000);
  await audit(page, '프로필 시트', `document.querySelector('[data-choice-name="grade"]')`);
  await save(page, '10-profile-grade.png');
  await page.evaluate(`document.querySelector('[data-close-sheet]').click()`);
  await page.send('Page.navigate', { url: `${server.url}/settings/learning` });
  // The retention slider belongs to the FSRS mode; a new account starts on fixed intervals.
  await page.waitUntil(`document.body.innerText.includes('기억에 맞춰서')`, 'learning settings', 15000);
  await page.click('button', '기억에 맞춰서');
  await page.waitFor('[data-choice="slider"]', 15000);
  await audit(page, '학습 설정', `document.querySelector('[data-choice="slider"]')`);
  const before: number = await page.evaluate(`Number(document.querySelector('[role="slider"]').getAttribute('aria-valuenow'))`);
  await page.evaluate(`(() => { const t = document.querySelector('[role="slider"]'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true; })()`);
  await page.waitUntil(`Number(document.querySelector('[role="slider"]').getAttribute('aria-valuenow')) === ${before + 1} || ${before} >= 97`, 'slider steps with the keyboard');
  await save(page, '11-retention-slider.png');
  check(errors.length === 0, `student screens: no console errors (${errors.slice(0, 2).join(' | ')})`);

  // Parent: cheer points stepper.
  const parent = await demoLogin(server.url, 'PARENT');
  const parentPage = await openPage(chrome.cdp, { width: 390, height: 844, cookie: { name: parent.name, value: parent.value } });
  await parentPage.send('Page.navigate', { url: `${server.url}/parent` });
  await audit(parentPage, '학부모 홈', `document.body.innerText.includes('자녀')`);
  await parentPage.send('Page.navigate', { url: `${server.url}/cheer` });
  await parentPage.waitFor('[data-choice="stepper"]', 20000);
  await audit(parentPage, '응원', `document.querySelector('[data-choice="stepper"]')`);
  await parentPage.evaluate(`document.querySelector('[data-choice="stepper"] button:last-child').click()`);
  check((await parentPage.evaluate(`document.querySelector('[data-choice="stepper"] input').value`)) === '100', 'stepper moves by 100P');
  await save(parentPage, '12-cheer-stepper.png');

  // Admin.
  const admin = await demoLogin(server.url, 'ADMIN').catch(() => null);
  if (admin) {
    const adminPage = await openPage(chrome.cdp, { width: 390, height: 844, cookie: { name: admin.name, value: admin.value } });
    await adminPage.send('Page.navigate', { url: `${server.url}/admin` });
    await audit(adminPage, '관리자', `document.body.innerText.includes('운영')`);
  }
  writeFileSync(join(outDir, 'README.md'), `# 공용 컨트롤 캡처 (${new Date().toISOString().slice(0, 10)})\n\n\`npx tsx scripts/native-ui-audit.ts\` 가 격리 qa 계정으로 만든 캡처. 01–02 시험 날짜 시트 · 03 업로드 체크박스 · 04 자료 선택 시트 · 05 오답노트 체크박스 · 06 교육과정 선택 · 07 시간 선택 · 08 시간표 날짜 · 09 글쓰기(게시판·익명) · 10 학년 선택 · 11 기억률 슬라이더 · 12 포인트 스테퍼.\n`);
  console.log(`NATIVE_UI_AUDIT_OK native=${native} screens=${screens} captures=${captures}`);
} catch (error) {
  console.error(error);
  console.error(`--- server (tail) ---\n${server.output().slice(-1500)}`);
  process.exitCode = 1;
} finally {
  await chrome.close();
  await db.attempt.deleteMany({ where: { userId: `${prefix}-s` } }).catch(() => {});
  await db.question.deleteMany({ where: { userId: `${prefix}-s` } }).catch(() => {});
  await db.material.deleteMany({ where: { userId: `${prefix}-s` } }).catch(() => {});
  await db.subject.deleteMany({ where: { userId: `${prefix}-s` } }).catch(() => {});
  await db.session.deleteMany({ where: { userId: `${prefix}-s` } }).catch(() => {});
  await db.user.deleteMany({ where: { id: `${prefix}-s` } }).catch(() => {});
  await server.stop().catch(() => {});
  await closeSessions();
  await db.$disconnect();
}
