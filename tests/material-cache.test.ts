import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Material, MaterialDetail, MaterialImage } from '../src/lib/contracts';
import {
  fetchMaterialDetail,
  forgetMaterialDetails,
  mergeSavedMaterial,
  rememberSavedMaterial,
} from '../src/lib/materials';
import { metaLabel } from '../src/components/study/material-layout';

const material = (over: Partial<Material> = {}): Material => ({
  id: 'm1',
  subjectId: 'bio',
  title: '세포 호흡',
  contentLength: 6,
  excerpt: '본문입니다',
  contentHash: 'hash1',
  type: 'TXT',
  createdAt: '2026-09-16T01:00:00Z',
  ...over,
});

const image: MaterialImage = {
  id: 'img',
  url: '/api/uploads/u1/images/img',
  page: 1,
  order: 0,
  paragraph: -1,
  anchor: -1,
  box: { x: 0, y: 0, w: 1, h: 1 },
  width: 10,
  height: 10,
  context: '',
};

const served = (over: Partial<MaterialDetail> = {}): MaterialDetail => ({
  ...material(),
  content: '서버가 준 본문',
  images: [],
  ...over,
});

/** Answers every GET /api/materials/:id with detail and counts the requests. */
function serve(detail: () => MaterialDetail) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return Response.json({ data: detail() });
  };
  return { calls, restore: () => void (globalThis.fetch = original) };
}

test('a body is fetched once per id and content hash', async () => {
  forgetMaterialDetails();
  const server = serve(() => served());
  try {
    const first = await fetchMaterialDetail(material());
    const again = await fetchMaterialDetail(material());
    assert.equal(first.content, '서버가 준 본문');
    assert.equal(again, first);
    assert.deepEqual(server.calls, ['/api/materials/m1']);
    // An edit changes the hash, so the edited body is read again under its own key.
    await fetchMaterialDetail(material({ contentHash: 'hash2' }));
    assert.equal(server.calls.length, 2);
  } finally {
    server.restore();
  }
});

test('signing out empties the cache: the next account reads its own body', async () => {
  forgetMaterialDetails();
  let body = '이전 계정의 본문';
  const server = serve(() => served({ content: body }));
  try {
    assert.equal((await fetchMaterialDetail(material())).content, '이전 계정의 본문');
    // What logout(), a role switch in login(), and a bootstrap 401 all do.
    forgetMaterialDetails();
    body = '다음 계정의 본문';
    const next = await fetchMaterialDetail(material());
    assert.equal(next.content, '다음 계정의 본문', 'a body from the previous session was served again');
    assert.equal(server.calls.length, 2, 'the cleared cache still answered without asking the server');
  } finally {
    server.restore();
  }
  console.log('MATERIAL_CACHE_SIGNOUT_OK');
});

test('a save without a file is remembered whole; one with a file is left to be fetched', async () => {
  forgetMaterialDetails();
  const server = serve(() => served({ id: 'm2', uploadId: 'u1', contentHash: 'hash1', images: [image], pages: 3 }));
  try {
    // Create or sample: the answer carries the body, and a material with no file has no images.
    const saved = material({ content: '저장한 본문' });
    rememberSavedMaterial(saved);
    const seeded = await fetchMaterialDetail(saved);
    assert.equal(seeded.content, '저장한 본문');
    assert.deepEqual(seeded.images, []);
    assert.equal(seeded.pages, undefined);
    assert.deepEqual(server.calls, [], 'a remembered body was fetched again');

    // Negative control: the same answer for an uploaded file carries no images, so it is not
    // remembered — the fetch below must bring the detail that has them.
    const withFile = material({ id: 'm2', uploadId: 'u1', content: '파일에서 읽은 본문' });
    rememberSavedMaterial(withFile);
    const fetched = await fetchMaterialDetail(withFile);
    assert.deepEqual(server.calls, ['/api/materials/m2'], 'an answer without images was remembered');
    assert.deepEqual(fetched.images, [image]);
    assert.equal(fetched.pages, 3);
  } finally {
    server.restore();
  }
});

test("an edit of an uploaded file keeps the images and page count the editor had", async () => {
  forgetMaterialDetails();
  const server = serve(() => served({ id: 'm2', uploadId: 'u1', images: [image], pages: 3 }));
  try {
    const loaded = served({ id: 'm2', uploadId: 'u1', contentHash: 'hash1', content: '고치기 전 본문', images: [image], pages: 3 });
    const saved = material({ id: 'm2', uploadId: 'u1', contentHash: 'hash2', content: '고친 본문' });
    rememberSavedMaterial(saved, loaded);
    const seeded = await fetchMaterialDetail(saved);
    assert.equal(seeded.content, '고친 본문');
    assert.deepEqual(seeded.images, [image], 'the file images were dropped by an edit');
    assert.equal(seeded.pages, 3);
    assert.deepEqual(server.calls, []);

    // A detail belonging to another material says nothing about this one, and neither does one
    // from another file: each half of the guard is checked on its own.
    const other = material({ id: 'm3', uploadId: 'u1', contentHash: 'hash9', content: '다른 자료' });
    rememberSavedMaterial(other, loaded);
    await fetchMaterialDetail(other);
    assert.deepEqual(server.calls, ['/api/materials/m3'], "another material's images were reused");
    const refiled = material({ id: 'm2', uploadId: 'u2', contentHash: 'hash3', content: '다른 파일' });
    rememberSavedMaterial(refiled, loaded);
    await fetchMaterialDetail(refiled);
    assert.deepEqual(server.calls, ['/api/materials/m3', '/api/materials/m2'], "another file's images were reused");

    // A material summary carries no body (bootstrap leaves it out), so there is nothing to remember.
    const summary = material({ id: 'm4', contentHash: 'hash4' });
    rememberSavedMaterial(summary);
    const fetched = await fetchMaterialDetail(summary);
    assert.equal(server.calls.length, 3, 'a material without a body was remembered');
    assert.equal(typeof fetched.content, 'string');
  } finally {
    server.restore();
  }
  console.log('MATERIAL_CACHE_SEED_OK');
});

test('a save keeps the page and image counts its answer does not carry', () => {
  // The bootstrap summary of an uploaded PDF, and the row PATCH /api/materials/:id answers with:
  // the same material without pages and imageCount, which only the summary has.
  const previous = material({ uploadId: 'u1', type: 'PDF', content: '고치기 전 본문', pages: 3, imageCount: 2, pageBreaks: [0, 120], extraction: 'pdf-text' });
  const saved = material({ uploadId: 'u1', type: 'PDF', title: '고친 제목', content: '고친 본문', contentHash: 'hash2', contentLength: 12345, pageBreaks: [], extraction: 'manual' });
  const merged = mergeSavedMaterial(previous, saved);
  assert.equal(metaLabel(merged), 'PDF · 3쪽 · 그림 2');
  // The control is the answer as it arrives: the counts are gone and the meta line falls back to characters.
  assert.equal(metaLabel(saved), 'PDF · 12,345자');
  // Everything the save did change comes from the answer.
  assert.equal(merged.title, '고친 제목');
  assert.equal(merged.content, '고친 본문');
  assert.equal(merged.contentHash, 'hash2');
  assert.deepEqual(merged.pageBreaks, []);
  assert.equal(merged.extraction, 'manual');
  // A counted answer wins over the older material, and a material that never had counts stays without
  // (no invented zero, so the meta line falls back to characters).
  assert.equal(mergeSavedMaterial(previous, material({ pages: 5 })).pages, 5);
  assert.equal(mergeSavedMaterial(previous, material({ imageCount: 7 })).imageCount, 7);
  assert.equal(mergeSavedMaterial(material(), saved).pages, undefined);
  assert.equal(mergeSavedMaterial(material(), saved).imageCount, undefined);
  assert.equal(metaLabel(mergeSavedMaterial(material({ type: 'TXT' }), material({ type: 'TXT', contentLength: 40 }))), 'TXT · 40자');
  console.log('MATERIAL_MERGE_OK');
});

test('the app clears the cache where a session ends and seeds it where a save answers with the material', () => {
  // The calls live in click handlers this suite cannot run (no DOM); the wiring is read from source.
  const app = readFileSync(new URL('../src/components/app.tsx', import.meta.url), 'utf8');
  const subjects = readFileSync(new URL('../src/components/study/subjects.tsx', import.meta.url), 'utf8');
  const bodyOf = (source: string, head: string) => {
    const start = source.indexOf(head);
    assert.ok(start >= 0, `${head} is gone`);
    const end = source.indexOf('\n  }', start);
    return source.slice(start, end);
  };
  for (const head of ['async function logout()', 'async function login(']) {
    assert.match(bodyOf(app, head), /forgetMaterialDetails\(\)/, `${head} keeps the previous bodies`);
  }
  assert.match(app, /message\.includes\('로그인'\)\)\s*\{[\s\S]{0,240}?forgetMaterialDetails\(\)/, 'a bootstrap 401 keeps the bodies');
  assert.match(app, /rememberSavedMaterial\(sample\.material\)/, 'the sample chapter is not remembered');
  assert.equal((subjects.match(/rememberSavedMaterial\(/g) ?? []).length, 2, 'create and edit must both seed');
  assert.match(subjects, /rememberSavedMaterial\(material\)/, 'the create seeds something other than its answer');
  assert.match(subjects, /rememberSavedMaterial\(saved, body\.detail\)/, 'the edit drops the loaded images');
  assert.match(subjects, /onSaved\(mergeSavedMaterial\(material, saved\)\)/, 'the edit hands on the answer alone');
});
