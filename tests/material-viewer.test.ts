import test from 'node:test';
import assert from 'node:assert/strict';
import type { MaterialImage } from '../src/lib/contracts';
import {
  describeFailure,
  displayTitle,
  findCitation,
  metaLabel,
  nextZoom,
  placeImages,
  splitPages,
  splitParagraphs,
} from '../src/components/study/material-layout';

const image = (over: Partial<MaterialImage>): MaterialImage => ({
  id: 'img',
  url: '/api/uploads/u/images/img',
  page: 1,
  order: 0,
  paragraph: -1,
  anchor: -1,
  box: { x: 0, y: 0, w: 1, h: 1 },
  width: 10,
  height: 10,
  context: '',
  ...over,
});

const body = '1쪽 첫 문단입니다.\n\n1쪽 둘째 문단은 그림 앞에 있어요.\n\n2쪽 첫 문단.\n\n2쪽 둘째 문단.\n\n3쪽 마지막 문단.';
const page2 = body.indexOf('2쪽 첫');
const page3 = body.indexOf('3쪽 마지막');

test('pages split at the recorded offsets; no offsets means one page', () => {
  const pages = splitPages(body, [0, page2, page3]);
  assert.deepEqual(pages.map((p) => [p.page, p.start, p.end]), [[1, 0, page2], [2, page2, page3], [3, page3, body.length]]);
  assert.equal(pages[1].text, body.slice(page2, page3));
  assert.deepEqual(splitPages(body, []).map((p) => p.page), [1]);
  assert.deepEqual(splitPages(body, undefined).map((p) => p.page), [1]);
  // Offsets that do not start at 0 still begin page 1 at 0; junk offsets are ignored.
  assert.deepEqual(splitPages(body, [page2, page3]).map((p) => p.start), [0, page2, page3]);
  assert.deepEqual(splitPages(body, [page2, 5, 99999]).map((p) => p.start), [0, page2]);
});

test('paragraphs are blank-line separated with absolute offsets', () => {
  const paragraphs = splitParagraphs(body.slice(page2, page3), page2);
  assert.deepEqual(paragraphs.map((p) => p.text), ['2쪽 첫 문단.', '2쪽 둘째 문단.']);
  assert.equal(body.slice(paragraphs[1].start, paragraphs[1].end), '2쪽 둘째 문단.');
  assert.deepEqual(splitParagraphs('  \n\n  ').length, 0);
  assert.deepEqual(splitParagraphs('a\n \n\nb\n').map((p) => p.text), ['a', 'b']);
  // Leading whitespace is not part of the paragraph: offsets point at the first visible character.
  assert.deepEqual(splitParagraphs('  x\n\n\ty', 10).map((p) => [p.start, p.end]), [[12, 13], [16, 17]]);
});

test('images follow the paragraph holding their anchor when the text still has page offsets', () => {
  const anchor = body.indexOf('그림 앞');
  const layouts = placeImages(body, [0, page2, page3], [image({ id: 'chart', page: 1, anchor, paragraph: 1 })]);
  assert.deepEqual(layouts[0].blocks.map((b) => (b.kind === 'image' ? `image:${b.image.id}` : b.paragraph.text)), ['1쪽 첫 문단입니다.', '1쪽 둘째 문단은 그림 앞에 있어요.', 'image:chart']);
  assert.equal(layouts[1].blocks.filter((b) => b.kind === 'image').length, 0);
});

test('an edited text (no page offsets) places images by their context sentence, else at the page end', () => {
  const edited = '새로 쓴 서문.\n\n1쪽 둘째 문단은 그림 앞에 있어요. 조금 고쳤어요.\n\n끝.';
  const byContext = placeImages(edited, [], [image({ id: 'chart', page: 1, anchor: 25, context: '1쪽 둘째 문단은   그림 앞에' })]);
  assert.deepEqual(byContext[0].blocks.map((b) => (b.kind === 'image' ? `image:${b.image.id}` : b.paragraph.text.slice(0, 6))), ['새로 쓴 서', '1쪽 둘째 ', 'image:chart', '끝.']);
  const orphan = placeImages(edited, [], [image({ id: 'lost', page: 1, anchor: 3, context: '없는 문장' })]);
  assert.equal(orphan[0].blocks.at(-1)?.kind, 'image');
  // A stale anchor on a page beyond the text still lands on the last page.
  const far = placeImages(edited, [], [image({ id: 'far', page: 9 })]);
  assert.equal(far.length, 1);
  assert.equal(far[0].blocks.at(-1)?.kind, 'image');
});

test('images keep page and order, and an image before any text opens its page', () => {
  const layouts = placeImages(body, [0, page2, page3], [
    image({ id: 'b', page: 2, order: 1, anchor: body.indexOf('2쪽 둘째'), paragraph: 3 }),
    image({ id: 'a', page: 2, order: 0, anchor: body.indexOf('2쪽 첫'), paragraph: 2 }),
    image({ id: 'cover', page: 1, order: 0, anchor: -1, paragraph: -1, context: '' }),
  ]);
  assert.deepEqual(layouts[1].blocks.map((b) => (b.kind === 'image' ? b.image.id : 'p')), ['p', 'a', 'p', 'b']);
  assert.equal(layouts[0].blocks.at(-1)?.kind, 'image');
});

test('a citation is found regardless of whitespace and reports its page', () => {
  const hit = findCitation(body, '2쪽   첫\n문단.', [0, page2, page3]);
  assert.deepEqual(hit, { start: page2, end: page2 + '2쪽 첫 문단.'.length, page: 2 });
  assert.equal(body.slice(hit!.start, hit!.end), '2쪽 첫 문단.');
  assert.equal(findCitation(body, '없는 문장', [0, page2, page3]), null);
  assert.equal(findCitation(body, '   ', []), null);
  assert.equal(findCitation(body, '3쪽 마지막', [0, page2, page3])?.page, 3);
  assert.equal(findCitation(body, '3쪽 마지막', [])?.page, 1);
});

test('display title drops the file extension and the meta line reads naturally', () => {
  assert.equal(displayTitle('첨부2-제안요청서.pdf'), '첨부2-제안요청서');
  assert.equal(displayTitle('notes.TXT '), 'notes');
  assert.equal(displayTitle('v1.2 정리'), 'v1.2 정리');
  assert.equal(displayTitle('.pdf'), '.pdf');
  assert.equal(metaLabel({ type: 'pdf', pages: 3, imageCount: 2 }), 'PDF · 3쪽 · 그림 2');
  assert.equal(metaLabel({ type: 'TXT', contentLength: 1234 }), 'TXT · 1,234자');
  assert.equal(metaLabel({ type: 'IMAGE', pages: 1 }), 'IMAGE · 1쪽');
});

test('failures say what happened and only recoverable ones offer a retry', () => {
  assert.deepEqual(describeFailure({ status: 410 }), { message: '원본 파일이 더 이상 없어요. 추출한 본문은 그대로 볼 수 있어요.', retry: false });
  assert.equal(describeFailure({ status: 401 }).retry, false);
  assert.equal(describeFailure({ status: 404 }).retry, false);
  assert.equal(describeFailure({ pdf: 'password' }).retry, false);
  assert.equal(describeFailure({ pdf: 'invalid' }).retry, false);
  assert.equal(describeFailure({ pdf: 'timeout' }).retry, true);
  assert.equal(describeFailure({ network: true }).retry, true);
  assert.equal(describeFailure({ status: 503 }).retry, true);
  assert.match(describeFailure({ network: true }).message, /연결/);
  assert.match(describeFailure({ status: 401 }).message, /로그인/);
});

test('zoom steps are bounded', () => {
  assert.equal(nextZoom(1, 1), 1.5);
  assert.equal(nextZoom(3, 1), 3);
  assert.equal(nextZoom(1, -1), 1);
  assert.equal(nextZoom(2, -1), 1.5);
  assert.equal(nextZoom(1.25, 1), 1.5);
});

console.log('MATERIAL_VIEWER_VERIFIED');
