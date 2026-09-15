// Gate leaf-2.3 V2/V3: the material viewer in a real headless Chrome against the static build served
// by the Go server. Default: an isolated qa student uploads the fixture PDF through the upload sheet
// and the script drives the viewer (preview pages, zoom, text pages with figures in place, file save
// link, missing original, lost connection + retry, citation from a quiz result, edit sheet), writing
// captures to docs/screenshots/materials/. `--demo-18`: opens the demo student's 18-page PDF read
// only (a temporary session, deleted afterwards). AI key empty; qa data removed at the end.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchChrome, openPage } from './lib/browser';
import { db, useServer } from './lib/db';
import { serveStatic } from './lib/goserve';
import { createSession, closeSessions, tokenHash } from './lib/session';

const demo18 = process.argv.includes('--demo-18');
const outDir = 'docs/screenshots/materials';
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
/** Sheets slide and fade in; a capture must wait for the animations so it shows the settled screen. */
const settled = async (page: { evaluate: (expression: string) => Promise<unknown>; shot: () => Promise<Buffer> }) => {
  await page.evaluate(`new Promise((done) => { const wait = () => (document.getAnimations().every((a) => a.playState === 'finished' || a.playState === 'idle') ? done(true) : setTimeout(wait, 50)); wait(); })`);
  await new Promise((r) => setTimeout(r, 120));
  return page.shot();
};
const prefix = `qa-viewer-${randomUUID().slice(0, 8)}`;

const server = await serveStatic();
useServer(server.url);
const chrome = await launchChrome();
const cleanup: (() => Promise<void>)[] = [];
try {
  if (demo18) {
    // Read-only look at the very material the user reported: a temporary session on the demo student.
    const token = (await createSession('demo-student', new Request(server.url))).split(';')[0].split('=')[1];
    cleanup.push(async () => {
      await db.session.deleteMany({ where: { id: tokenHash(token) } });
    });
    const page = await openPage(chrome.cdp, { width: 390, height: 844, cookie: { name: 'memoryz_session', value: token } });
    const target = await db.material.findFirst({ where: { userId: 'demo-student', type: 'PDF', upload: { pages: 18 } }, include: { upload: { select: { pages: true, id: true } } } });
    check(target, 'the demo student has the 18-page PDF material');
    const imageCount = await db.uploadImage.count({ where: { uploadId: target!.upload!.id } });
    await page.send('Page.navigate', { url: `${server.url}/subjects/${target!.subjectId}` });
    await page.waitFor(`[data-material-id="${target!.id}"]`, 20000);
    await page.click(`[data-material-id="${target!.id}"]`);
    await page.waitFor('[data-material-open]');
    await page.click('[data-material-open]');
    await page.waitFor('[data-material-viewer]');
    await page.waitUntil(`document.querySelector('[data-page-indicator]') && /\\/ 18 쪽/.test(document.querySelector('[data-page-indicator]').textContent)`, '18 pages laid out', 45000);
    await page.waitUntil(`document.querySelectorAll('[data-page-drawn="true"]').length >= 1`, 'first page drawn', 30000);
    save('demo-18-preview.png', await settled(page));
    await page.click('[data-viewer-tab="text"]');
    await page.waitFor('[data-material-content]', 20000);
    const pages: number = await page.evaluate(`document.querySelectorAll('[data-text-page]').length`);
    const figures: number = await page.evaluate(`document.querySelectorAll('[data-figure]').length`);
    check(pages === 18, `text view has 18 page sections (${pages})`);
    check(figures === imageCount && figures > 0, `figures in the text view match the stored images (${figures} of ${imageCount})`);
    save('demo-18-text.png', await settled(page));
    console.log(`DEMO_PDF_OK pages=${pages} images=${figures} captures=${captures}`);
  } else {
    const student = await db.user.create({ data: { id: `${prefix}-s`, name: '뷰어 검증', nickname: `${prefix}-s`, role: 'STUDENT', points: 0 } });
    cleanup.push(async () => {
      await db.session.deleteMany({ where: { userId: student.id } });
      await db.user.delete({ where: { id: student.id } });
    });
    const subject = await db.subject.create({ data: { userId: student.id, name: '뷰어 검증 과목' } });
    const token = (await createSession(student.id, new Request(server.url))).split(';')[0].split('=')[1];
    const errors: string[] = [];
    const page = await openPage(chrome.cdp, { width: 390, height: 844, cookie: { name: 'memoryz_session', value: token } });
    chrome.cdp.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text ?? 'exception');
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(JSON.stringify(m.params.args.map((a: any) => a.value ?? a.description)));
    });

    // 1. Upload the fixture PDF through the upload sheet (a real file input).
    await page.send('Page.navigate', { url: `${server.url}/subjects/${subject.id}` });
    await page.waitUntil(`document.body.innerText.includes('자료 올리기')`, 'subject screen', 20000);
    await page.click('button', '자료 올리기');
    await page.waitFor('input[type="file"]');
    const { root } = await page.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"][accept*="pdf"]' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [resolve('tests/fixtures/pdf/document.pdf')] });
    await page.waitUntil(`document.body.innerText.includes('파일 선택 취소') || document.querySelector('[aria-label="파일 선택 취소"]')`, 'file chosen', 10000);
    await page.click('.sheet-content button', '저장');
    await page.waitUntil(`document.body.innerText.includes('원본 자료는 저장되었어요') || !document.querySelector('.sheet-content')`, 'upload saved', 90000);
    const material = await db.material.findFirst({ where: { userId: student.id }, include: { upload: { select: { id: true, pages: true } } } });
    check(material?.upload?.pages === 3, `the fixture PDF has 3 pages (${material?.upload?.pages})`);
    const imageCount = await db.uploadImage.count({ where: { uploadId: material!.upload!.id } });
    check(imageCount === 2, `two figures were extracted (${imageCount})`);
    await page.evaluate(`document.querySelector('[data-close-sheet]') && document.querySelector('[data-close-sheet]').click()`);
    await page.send('Page.navigate', { url: `${server.url}/subjects/${subject.id}` });
    await page.waitFor(`[data-material-id="${material!.id}"]`, 20000);
    save('01-material-list.png', await settled(page));

    // 2. The viewer: title without extension, meta line, continuous preview with page indicator and zoom.
    const openViewer = async () => {
      await page.click(`[data-material-id="${material!.id}"]`);
      await page.waitFor('[data-material-open]');
      await page.click('[data-material-open]');
      await page.waitFor('[data-material-viewer]');
    };
    await openViewer();
    const heading: string = await page.evaluate(`document.querySelector('.sheet-heading').innerText`);
    check(/document(?!\.pdf)/.test(heading) && !/\.pdf/i.test(heading) && /PDF · 3쪽 · 그림 2/.test(heading), `heading shows the extension-free title and meta: ${heading.replace(/\n/g, ' | ')}`);
    await page.waitUntil(`document.querySelectorAll('[data-page-slot]').length === 3`, 'three page slots', 30000);
    await page.waitUntil(`document.querySelector('[data-page-drawn="true"]')`, 'first page drawn', 30000);
    check((await page.evaluate(`document.querySelector('[data-page-indicator]').textContent`)).startsWith('1 / 3'), 'indicator starts at page 1 of 3');
    save('02-preview-page1.png', await settled(page));
    await page.evaluate(`(() => { const v = document.querySelector('.pdf-preview-viewport'); v.scrollTop = v.scrollHeight; return true; })()`);
    await page.waitUntil(`document.querySelector('[data-page-indicator]').textContent.startsWith('3 / 3')`, 'indicator follows the scroll', 10000);
    await page.waitUntil(`document.querySelector('[data-page-slot="3"][data-page-drawn="true"]')`, 'page 3 drawn lazily', 30000);
    save('03-preview-page3.png', await settled(page));
    const widthBefore: number = await page.evaluate(`document.querySelector('[data-page-slot="1"]').getBoundingClientRect().width`);
    await page.click('[data-zoom-in]');
    await page.waitUntil(`document.querySelector('[data-page-slot="1"]').getBoundingClientRect().width > ${widthBefore * 1.3}`, 'zoom widens the page', 10000);
    check(/150%/.test(await page.evaluate(`document.querySelector('[data-page-indicator]').textContent`)), 'indicator shows the zoom level');
    save('04-preview-zoomed.png', await settled(page));
    await page.click('[data-zoom-out]');

    // 3. Text view: three page sections, two figures in place, no new-tab link, a download link.
    await page.click('[data-viewer-tab="text"]');
    await page.waitFor('[data-material-content]', 20000);
    const textPages: number = await page.evaluate(`document.querySelectorAll('[data-text-page]').length`);
    const figures: number = await page.evaluate(`document.querySelectorAll('[data-figure]').length`);
    const captionsOk: boolean = await page.evaluate(`[...document.querySelectorAll('[data-figure] figcaption')].every((c) => /그림 \\d+ · \\d+쪽/.test(c.textContent))`);
    check(textPages === 3 && figures === 2 && captionsOk, `text view: ${textPages} pages, ${figures} figures with captions`);
    const figureOrder: string = await page.evaluate(`[...document.querySelectorAll('[data-text-page]')].map((p) => p.dataset.textPage + ':' + p.querySelectorAll('[data-figure]').length).join(',')`);
    const expectedOrder = (await db.uploadImage.findMany({ where: { uploadId: material!.upload!.id }, orderBy: [{ page: 'asc' }, { order: 'asc' }] })).map((i) => i.page);
    check([1, 2, 3].map((p) => `${p}:${expectedOrder.filter((x) => x === p).length}`).join(',') === figureOrder, `figures sit on their pages (${figureOrder})`);
    check(!(await page.evaluate(`!!document.querySelector('[data-material-viewer] a[target="_blank"]')`)), 'no new-tab link');
    const download: string = await page.evaluate(`document.querySelector('[data-download]').getAttribute('href')`);
    check(/\/api\/uploads\/[^/]+\?download=1$/.test(download) && (await page.evaluate(`document.querySelector('[data-download]').hasAttribute('download')`)), `file save link ${download}`);
    const downloadRes = await fetch(server.url + download, { headers: { cookie: `memoryz_session=${token}` } });
    check(downloadRes.status === 200 && /^attachment/.test(downloadRes.headers.get('content-disposition') ?? ''), `download answers as an attachment (${downloadRes.headers.get('content-disposition')})`);
    save('05-text-view.png', await settled(page));
    await page.click('[data-close-material]');
    await page.waitUntil(`!document.querySelector('[data-material-viewer]')`, 'viewer closed');

    // 4. The edit sheet fills the body from the detail endpoint.
    await page.click('button', '제목 · 본문 수정');
    await page.waitUntil(`document.querySelector('.sheet-content textarea') && !document.querySelector('.sheet-content textarea').disabled && document.querySelector('.sheet-content textarea').value.length > 100`, 'editor filled from the detail', 20000);
    save('06-edit-sheet.png', await settled(page));
    await page.evaluate(`document.querySelector('[data-close-sheet]').click()`);
    await page.waitUntil(`!document.querySelector('.sheet-content textarea')`, 'editor closed');
    await page.evaluate(`document.querySelector('[data-close-sheet]') && document.querySelector('[data-close-sheet]').click()`);

    // 5. A citation opens the text view on its sentence.
    const detail = await fetch(`${server.url}/api/materials/${material!.id}`, { headers: { cookie: `memoryz_session=${token}` } }).then((r) => r.json());
    const paragraphs: string[] = detail.data.content.split(/\n\s*\n/).map((p: string) => p.trim()).filter((p: string) => p.length > 20);
    const cited = paragraphs[Math.min(paragraphs.length - 1, 4)];
    const citedPage = (detail.data.pageBreaks as number[]).filter((b: number) => b <= detail.data.content.indexOf(cited)).length || 1;
    const question = await db.question.create({
      data: { userId: student.id, subjectId: subject.id, materialId: material!.id, prompt: '검증 문항', options: ['가', '나', '다', '라', '마'], answer: 0, explanation: '검증용', citation: cited.split(/\s+/).join('  '), past: '이전', future: '다음' },
    });
    await page.send('Page.navigate', { url: `${server.url}/quiz?question=${question.id}` });
    await page.waitFor('[role="radio"]', 20000);
    await page.click('[role="radio"]');
    await page.click('button', '정답 확인');
    await page.waitUntil(`document.body.innerText.includes('원본 보기')`, 'result with citation', 30000);
    await page.click('button', '원본 보기');
    await page.waitFor('[data-material-viewer]');
    await page.waitFor('[data-citation]', 20000);
    const note: string = await page.evaluate(`document.querySelector('[data-citation-note]').textContent`);
    const markText: string = await page.evaluate(`document.querySelector('[data-citation]').textContent`);
    check(note.startsWith(`${citedPage}쪽에서`) && markText.replace(/\s+/g, '') === cited.replace(/\s+/g, ''), `citation highlighted on page ${citedPage}: ${note}`);
    check(await page.evaluate(`(() => { const m = document.querySelector('[data-citation]'); const r = m.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()`), 'the cited sentence is scrolled into view');
    save('07-citation.png', await settled(page));
    await page.click('[data-close-material]');

    // 6. Errors: the original is gone (410, no retry); the connection is lost (retry works once it is back).
    // The upload row stays; only its bytes disappear (what a lost object looks like) — the server answers 410.
    await db.$executeRawUnsafe('DELETE FROM ops.blob WHERE key = $1', `uploads/${material!.upload!.id}`);
    // The PDF bytes are served immutable, so a client that already has them would keep showing them; a
    // fresh device (empty cache) is the case that must say the original is gone.
    await page.send('Network.clearBrowserCache');
    await page.send('Page.navigate', { url: `${server.url}/subjects/${subject.id}` });
    await page.waitFor(`[data-material-id="${material!.id}"]`, 20000);
    await openViewer();
    try {
      await page.waitFor('[data-preview-error]', 30000);
    } catch (error) {
      throw new Error(`${(error as Error).message}; viewer text: ${JSON.stringify(await page.evaluate(`document.querySelector('[data-material-viewer]') ? document.querySelector('[data-material-viewer]').innerText.slice(0, 300) : ''`))}`);
    }
    const goneText: string = await page.evaluate(`document.querySelector('[data-preview-error]').innerText`);
    check(/원본 파일이 더 이상 없어요/.test(goneText) && !(await page.evaluate(`!!document.querySelector('[data-preview-retry]')`)), `missing original: ${goneText.replace(/\n/g, ' ')}`);
    await page.click('[data-viewer-tab="text"]');
    await page.waitFor('[data-material-content]', 20000);
    check((await page.evaluate(`document.querySelectorAll('[data-text-page]').length`)) === 3, 'the extracted text survives the missing original');
    save('08-original-missing.png', await settled(page));
    await page.click('[data-close-material]');
    // A second material whose body is not cached yet, then the server goes away.
    const offline = await db.material.create({ data: { userId: student.id, subjectId: subject.id, title: '연결 검사 자료', type: 'TXT', content: '연결이 끊긴 동안 열어 보는 자료입니다. '.repeat(6), pageBreaks: [] } });
    await page.send('Page.navigate', { url: `${server.url}/subjects/${subject.id}` });
    await page.waitFor(`[data-material-id="${offline.id}"]`, 20000);
    const port = server.port;
    await server.stop();
    await page.click(`[data-material-id="${offline.id}"]`);
    await page.waitFor('[data-material-open]');
    await page.click('[data-material-open]');
    await page.waitFor('[data-text-error]', 30000);
    check(/연결이 끊겼어요/.test(await page.evaluate(`document.querySelector('[data-text-error]').innerText`)) && (await page.evaluate(`!!document.querySelector('[data-text-retry]')`)), 'lost connection offers a retry');
    save('09-connection-lost.png', await settled(page));
    const again = await serveStatic({ env: { PORT: String(port) } });
    useServer(again.url);
    cleanup.push(again.stop);
    await page.click('[data-text-retry]');
    await page.waitFor('[data-material-content]', 30000);
    check(/연결이 끊긴 동안/.test(await page.evaluate(`document.querySelector('[data-material-content]').innerText`)), 'retry loads the body once the connection is back');
    save('10-connection-restored.png', await settled(page));

    // 7. 360×800 sanity for the viewer.
    const small = await openPage(chrome.cdp, { width: 360, height: 800, cookie: { name: 'memoryz_session', value: token } });
    await small.send('Page.navigate', { url: `${again.url}/subjects/${subject.id}` });
    await small.waitFor(`[data-material-id="${offline.id}"]`, 20000);
    await small.click(`[data-material-id="${offline.id}"]`);
    await small.waitFor('[data-material-open]');
    await small.click('[data-material-open]');
    await small.waitFor('[data-material-content]', 20000);
    check(await small.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), 'no horizontal overflow at 360px');
    save('11-text-360.png', await settled(small));
    check(errors.length === 0, `no console errors: ${errors.slice(0, 3).join(' | ')}`);
    writeFileSync(join(outDir, 'README.md'), `# 자료 뷰어 캡처 (${new Date().toISOString().slice(0, 10)})\n\n\`npx tsx scripts/materials-capture.ts\` 가 격리 qa 계정으로 만든 캡처. 01 목록 · 02–04 미리보기(1쪽·3쪽·확대) · 05 본문(3쪽·그림 2) · 06 수정 시트 · 07 인용 강조 · 08 원본 없음 · 09–10 연결 끊김과 복구 · 11 360px.\n`);
    console.log(`MATERIALS_CAPTURE_OK (${checks} checks, ${captures} captures)`);
  }
} catch (error) {
  console.error(error);
  console.error(`--- server (tail) ---\n${server.output().slice(-1500)}`);
  process.exitCode = 1;
} finally {
  await chrome.close();
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  if (!demo18) {
    await db.attempt.deleteMany({ where: { userId: `${prefix}-s` } }).catch(() => {});
    await db.question.deleteMany({ where: { userId: `${prefix}-s` } }).catch(() => {});
    await db.uploadImage.deleteMany({ where: { upload: { userId: `${prefix}-s` } } }).catch(() => {});
    await db.material.deleteMany({ where: { userId: `${prefix}-s` } }).catch(() => {});
    await db.upload.deleteMany({ where: { userId: `${prefix}-s` } }).catch(() => {});
    await db.subject.deleteMany({ where: { userId: `${prefix}-s` } }).catch(() => {});
    await db.session.deleteMany({ where: { userId: `${prefix}-s` } }).catch(() => {});
    await db.user.deleteMany({ where: { id: `${prefix}-s` } }).catch(() => {});
  }
  await server.stop().catch(() => {});
  await closeSessions();
  await db.$disconnect();
}
