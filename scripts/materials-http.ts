// Real HTTP checks for material storage: uploads land in the database with their text, pages and images;
// files are served with exact headers to their owner only; legacy disk files move in on first read; a
// missing file says so (410); deleting a material takes its file along; stale unlinked uploads are
// collected but a card's image is kept. Needs TEST_APP_URL (serve.mjs) and a server without an AI key.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/lib/server/db';
import { createSession } from '../src/lib/server/auth';
import { assertLoopbackDatabase } from './lib/browser';

assertLoopbackDatabase();
const base = process.env.TEST_APP_URL;
assert.ok(base && ['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'TEST_APP_URL on loopback');
const prefix = `qa-materials-${randomUUID().slice(0, 8)}`;
const legacyDir = join(process.cwd(), '.data', 'uploads');
const legacyFiles: string[] = [];
let checks = 0;
const check = (ok: unknown, message: string) => {
  assert.ok(ok, message);
  checks++;
};

async function account(name: string) {
  const user = await db.user.create({ data: { id: `${prefix}-${name}`, name, nickname: `${prefix}-${name}`.slice(0, 30), role: 'STUDENT', school: '검증고', grade: '고2' } });
  const cookie = (await createSession(user.id, new Request(base!))).split(';')[0];
  return { user, cookie };
}
async function call(cookie: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}/api${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie } });
  return response;
}
async function json(cookie: string, path: string, body?: unknown, method?: string) {
  const response = await call(cookie, path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, data: payload.data, error: payload.error, code: payload.code };
}
async function upload(cookie: string, name: string, bytes: Uint8Array, type: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
  const response = await call(cookie, '/upload', { method: 'POST', body: form });
  const payload = await response.json();
  return { status: response.status, data: payload.data, error: payload.error };
}

try {
  const owner = await account('owner');
  const stranger = await account('stranger');
  const boot = await json(owner.cookie, '/bootstrap');
  check(boot.data?.aiAvailable === false, 'the server has no AI key, so nothing here is paid for');
  const subject = await db.subject.create({ data: { userId: owner.user.id, name: '검증 과목' } });
  const pdf = new Uint8Array(readFileSync('tests/fixtures/pdf/document.pdf'));

  // Upload: clean text, pages, located images, title without the extension.
  const up = await upload(owner.cookie, '제안서 요약.pdf', pdf, 'application/pdf');
  check(up.status === 200, `upload ${up.status} ${up.error ?? ''}`);
  const u = up.data;
  check(u.title === '제안서 요약' && u.type === 'PDF' && u.pages === 3 && u.pageBreaks.length === 3 && u.extraction === 'pdf-text', `upload meta ${JSON.stringify({ ...u, content: undefined, images: undefined })}`);
  check(!/-- \d+ of \d+ --/.test(u.content) && !u.content.includes('\t') && u.content.includes('I. 공모 개요 (2쪽)'), 'extracted text is clean');
  check(u.images.length === 2 && u.images.map((i: { page: number }) => i.page).join() === '2,3' && u.images.every((i: { paragraph: number; url: string }) => i.paragraph >= 0 && i.url.startsWith(`/api/uploads/${u.uploadId}/images/`)), `images located ${JSON.stringify(u.images.map((i: { page: number; paragraph: number }) => [i.page, i.paragraph]))}`);
  check(u.warning === undefined, 'no warning for a text PDF');
  const row = await db.upload.findUnique({ where: { id: u.uploadId }, include: { blob: true, _count: { select: { images: true } } } });
  check(row?.blob?.data.length === pdf.length && row._count.images === 2 && row.sha256 && row.textHash, 'bytes, images and hashes stored together');

  // Material: the server decides the type and keeps page offsets for the unedited text.
  const made = await json(owner.cookie, '/materials', { subjectId: subject.id, title: u.title, content: u.content, type: 'TXT', uploadId: u.uploadId });
  check(made.status === 201 && made.data.type === 'PDF' && made.data.uploadId === u.uploadId && made.data.url === `/api/uploads/${u.uploadId}`, `material ${made.status} ${made.data?.type}`);
  check(JSON.stringify(made.data.pageBreaks) === JSON.stringify(u.pageBreaks) && made.data.extraction === 'pdf-text', 'page offsets kept');
  check((await json(owner.cookie, '/materials', { subjectId: subject.id, title: '또', content: u.content, type: 'PDF', uploadId: u.uploadId })).status === 409, 'one file, one material');
  check((await json(stranger.cookie, '/materials', { subjectId: subject.id, title: '남의 것', content: 'x', type: 'PDF', uploadId: u.uploadId })).status === 404, "another account cannot use someone's subject or upload");
  const detail = await json(owner.cookie, `/materials/${made.data.id}`);
  check(detail.status === 200 && detail.data.pages === 3 && detail.data.images.length === 2 && detail.data.images[0].box.w > 0, 'material detail carries pages and images');

  // Serving the file: exact length, strong ETag, 304, download, owner only.
  const file = await call(owner.cookie, `/uploads/${u.uploadId}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const etag = file.headers.get('etag');
  check(file.status === 200 && file.headers.get('content-type') === 'application/pdf' && Number(file.headers.get('content-length')) === pdf.length && bytes.length === pdf.length, 'file served whole');
  check(etag === `"${row?.sha256}"` && /immutable/.test(file.headers.get('cache-control') ?? '') && /^inline;/.test(file.headers.get('content-disposition') ?? ''), `file headers ${etag} ${file.headers.get('cache-control')}`);
  check((await call(owner.cookie, `/uploads/${u.uploadId}`, { headers: { 'if-none-match': etag! } })).status === 304, 'unchanged file answers 304');
  check(/^attachment;/.test((await call(owner.cookie, `/uploads/${u.uploadId}?download=1`)).headers.get('content-disposition') ?? ''), 'download is an attachment');
  check((await call(stranger.cookie, `/uploads/${u.uploadId}`)).status === 404, 'another account cannot read the file');
  const image = await call(owner.cookie, `/uploads/${u.uploadId}/images/${u.images[0].id}`);
  const imageBytes = Buffer.from(await image.arrayBuffer());
  check(image.status === 200 && image.headers.get('content-type') === 'image/webp' && imageBytes.subarray(8, 12).toString() === 'WEBP', 'image served as WebP');
  check((await call(stranger.cookie, `/uploads/${u.uploadId}/images/${u.images[0].id}`)).status === 404, 'another account cannot read the image');

  // Editing the text drops page offsets; restoring it brings them back.
  const edited = await json(owner.cookie, `/materials/${made.data.id}`, { content: `${u.content}\n\n덧붙인 메모` }, 'PATCH');
  check(edited.status === 200 && edited.data.pageBreaks.length === 0 && edited.data.extraction === 'manual', 'edited text has no page offsets');
  const restored = await json(owner.cookie, `/materials/${made.data.id}`, { content: u.content }, 'PATCH');
  check(JSON.stringify(restored.data.pageBreaks) === JSON.stringify(u.pageBreaks) && restored.data.extraction === 'pdf-text', 'restored text regains them');
  const second = await upload(owner.cookie, '다른 요약.pdf', pdf, 'application/pdf');
  const typed = await json(owner.cookie, '/materials', { subjectId: subject.id, title: '직접 쓴 본문', content: '직접 적은 요약입니다.', type: 'PDF', uploadId: second.data.uploadId });
  check(typed.status === 201 && typed.data.pageBreaks.length === 0 && typed.data.extraction === 'manual', 'text typed over the file is manual');

  // A file written by an earlier version moves into the database on first read.
  mkdirSync(legacyDir, { recursive: true });
  const legacyId = randomUUID();
  const legacyBytes = Buffer.from('legacy text file for the migration check');
  writeFileSync(join(legacyDir, legacyId), legacyBytes);
  legacyFiles.push(join(legacyDir, legacyId));
  await db.upload.create({ data: { id: legacyId, userId: owner.user.id, mime: 'text/plain; charset=utf-8', name: 'old.txt', size: legacyBytes.length } });
  const legacy = await call(owner.cookie, `/uploads/${legacyId}`);
  check(legacy.status === 200 && Buffer.from(await legacy.arrayBuffer()).equals(legacyBytes), 'legacy file served');
  check((await db.uploadBlob.findUnique({ where: { uploadId: legacyId } }))?.data.length === legacyBytes.length, 'legacy file copied into the database');
  const missingId = randomUUID();
  await db.upload.create({ data: { id: missingId, userId: owner.user.id, mime: 'application/pdf', name: 'gone.pdf', size: 10 } });
  const missing = await json(owner.cookie, `/uploads/${missingId}`);
  check(missing.status === 410 && missing.code === 'UPLOAD_MISSING', `a missing file says so (${missing.status} ${missing.code})`);

  // Deleting a material deletes its file, bytes and images.
  check((await json(owner.cookie, `/materials/${made.data.id}`, undefined, 'DELETE')).status === 200, 'material deleted');
  check((await db.upload.count({ where: { id: u.uploadId } })) === 0 && (await db.uploadBlob.count({ where: { uploadId: u.uploadId } })) === 0 && (await db.uploadImage.count({ where: { uploadId: u.uploadId } })) === 0, 'file, bytes and images went with it');

  // Stale unlinked uploads are collected on the next upload; a card's image is not.
  const old = new Date(Date.now() - 2 * 86_400_000);
  const [abandoned, cardImage] = [randomUUID(), randomUUID()];
  for (const id of [abandoned, cardImage]) {
    await db.upload.create({ data: { id, userId: owner.user.id, mime: 'image/png', name: `${id}.png`, size: 3, createdAt: old } });
    await db.uploadBlob.create({ data: { uploadId: id, data: new Uint8Array([1, 2, 3]) } });
  }
  await db.card.create({ data: { userId: owner.user.id, subjectId: subject.id, front: '그림 카드', back: '답', type: 'BLIND', image: `/api/uploads/${cardImage}`, nextReviewAt: new Date() } });
  const txt = await upload(owner.cookie, '노트.txt', new TextEncoder().encode('첫 줄\r\n둘째 줄 한글'.normalize('NFD')), 'text/plain');
  check(txt.status === 200 && txt.data.content === '첫 줄\n둘째 줄 한글' && txt.data.extraction === 'text', `text normalised (${JSON.stringify(txt.data?.content)})`);
  check((await db.upload.count({ where: { id: abandoned } })) === 0, 'abandoned upload collected');
  check((await db.upload.count({ where: { id: cardImage } })) === 1, "a card's image kept");

  // A page without a text layer is reported, not filled with nothing.
  const scanned = await upload(owner.cookie, '스캔.pdf', new Uint8Array(readFileSync('tests/fixtures/pdf/scanned.pdf')), 'application/pdf');
  check(scanned.status === 200 && scanned.data.warning === '1쪽은 이미지로만 되어 있어 본문에 넣지 못했어요.' && scanned.data.content.includes('둘째 쪽') && JSON.stringify(scanned.data.pageBreaks) === '[0,0]', `scan warning ${scanned.data?.warning}`);
  console.log(`MATERIALS_HTTP_OK (${checks} checks; storage, serving, legacy migration, 410, delete cascade, collection, extraction)`);
} finally {
  for (const file of legacyFiles) rmSync(file, { force: true });
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  assert.equal(await db.user.count({ where: { id: { startsWith: prefix } } }), 0);
  await db.$disconnect();
}
