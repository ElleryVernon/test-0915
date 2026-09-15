import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assemble,
  dropFurniture,
  extractPdf,
  keepImages,
  lexiconOf,
  placeImages,
  tidyLine,
  toLines,
  toParagraphs,
  wrapJoin,
  type Line,
  type Piece,
  type Placement,
} from '../src/lib/server/pdf-extract';

const piece = (str: string, x: number, y: number, width = str.length * 10, size = 10): Piece => ({ str, x, y, width, size });
const line = (text: string, y: number, x = 50, right = 500, size = 10): Line => ({ text, x, right, y, size });

test('pieces on one baseline become one line: word gaps are single spaces, glyph runs stay together, never tabs', () => {
  const lines = toLines([
    piece('학습', 50, 100, 20),
    piece('자료', 72, 100, 20), // 2pt gap: the same word
    piece('정리', 97, 100, 20), // 5pt gap at size 10: a word gap
    piece('\t끝', 300, 100, 20),
    piece('다음 줄', 50, 114, 40),
  ]);
  assert.deepEqual(lines.map((l) => l.text), ['학습자료 정리 끝', '다음 줄']);
  assert.ok(lines.every((l) => !l.text.includes('\t')));
  // Decomposed jamo (NFD) are stored composed (NFC), so search and citations match.
  assert.equal(toLines([piece('한글'.normalize('NFD'), 0, 10)])[0].text, '한글');
});

test('soft-wrapped lines rejoin; spacing, a short line, a list marker or a size change start a new paragraph', () => {
  const blocks = toParagraphs([
    line('광합성은 빛에너지를 이용해 이산화 탄소와 물로 포도당을 만드는', 100),
    line('과정이다. 이 과정은 엽록체에서 일어난다.', 114, 50, 300),
    line('명반응은 틸라코이드 막에서 일어난다.', 128, 50, 500),
    line('캘빈 회로는 스트로마에서 일어난다.', 150),
    line('○ 명반응: 빛이 필요하다', 164),
    line('○ 캘빈 회로: 빛이 직접 필요하지 않다', 178),
    line('II. 호흡', 198, 50, 120, 14),
  ]);
  assert.deepEqual(
    blocks.map((b) => b.text),
    [
      '광합성은 빛에너지를 이용해 이산화 탄소와 물로 포도당을 만드는 과정이다. 이 과정은 엽록체에서 일어난다.',
      '명반응은 틸라코이드 막에서 일어난다.',
      '캘빈 회로는 스트로마에서 일어난다.',
      '○ 명반응: 빛이 필요하다',
      '○ 캘빈 회로: 빛이 직접 필요하지 않다',
      'II. 호흡',
    ],
  );
  // Latin hyphenation rejoins.
  assert.equal(toParagraphs([line('the photosyn-', 10), line('thesis step', 24, 50, 200)])[0].text, 'the photosynthesis step');
});

test('a wrap that split a Korean word rejoins; a real word boundary keeps its space', () => {
  assert.equal(wrapJoin('함께 제공하는 프', '로그램이다.'), '', 'a lone syllable that is not a word');
  assert.equal(wrapJoin('시제품을 시험', '하며, 마지막'), '', 'an ending never starts a word');
  assert.equal(wrapJoin('기업의 서비스', '를 제공한다'), '', 'a particle never starts a word');
  assert.equal(wrapJoin('현장 전문', '가들과 협업', new Set(['전문가', '전문가의'])), '', 'the document spells the word elsewhere');
  assert.equal(wrapJoin('선도하는 기업이', '배출되기 위해'), ' ', 'a word ending with a particle');
  assert.equal(wrapJoin('자료를 볼 수', '있다'), ' ', 'a one-syllable word of its own');
  assert.equal(wrapJoin('photosynthesis', 'happens'), ' ', 'Latin words keep their space');
  assert.deepEqual([...lexiconOf([line('전문가의 의견과 전문가', 10)])].sort(), ['의견과', '전문가', '전문가의']);
});

test('table-of-contents leaders become "title (N쪽)"', () => {
  assert.equal(tidyLine('I. 공모 개요 ........................ 1'), 'I. 공모 개요 (1쪽)');
  assert.equal(tidyLine('Ⅲ. 제안 요청내용 · · · · · · 4'), 'Ⅲ. 제안 요청내용 (4쪽)');
  assert.equal(tidyLine('비용은 3.5 정도'), '비용은 3.5 정도');
});

test('running headers, footers and bare page numbers are dropped; body text near the edge stays', () => {
  const page = (n: number, extra: Line[] = []) => ({
    width: 600,
    height: 800,
    lines: [line('기후테크 창업가 육성사업', 40), line(`본문 ${n}쪽 내용입니다`, 300), line(`- ${n} -`, 780), ...extra],
  });
  const pages = dropFurniture([page(1, [line('첫 쪽에만 있는 위쪽 줄', 60)]), page(2), page(3), page(4)]);
  assert.deepEqual(pages[0].lines.map((l) => l.text), ['본문 1쪽 내용입니다', '첫 쪽에만 있는 위쪽 줄']);
  assert.ok(pages.slice(1).every((p) => p.lines.length === 1));
  // Two pages are too few to call a line a running header, but a bare page number is always furniture.
  const short = dropFurniture([page(1), page(2)]);
  assert.equal(short[0].lines.filter((l) => l.text.includes('육성사업')).length, 1);
  assert.ok(short.every((p) => !p.lines.some((l) => /^- \d -$/.test(l.text))), 'page numbers go even when not repeated enough');
});

test('assembled text records where every page and paragraph starts', () => {
  const assembled = assemble([
    [{ text: '첫 쪽 문단', top: 10, bottom: 20 }],
    [],
    [{ text: '셋째 쪽 첫 문단', top: 10, bottom: 20 }, { text: '둘째 문단', top: 40, bottom: 50 }],
  ]);
  assert.equal(assembled.text, '첫 쪽 문단\n\n셋째 쪽 첫 문단\n\n둘째 문단');
  assert.deepEqual(assembled.pageBreaks, [0, 6, 8]);
  assert.equal(assembled.text.slice(assembled.pageBreaks[2]).startsWith('셋째 쪽'), true);
  assert.deepEqual(assembled.paragraphs.map((p) => [p.page, assembled.text.slice(p.start, p.end)]), [
    [1, '첫 쪽 문단'],
    [3, '셋째 쪽 첫 문단'],
    [3, '둘째 문단'],
  ]);
});

const placement = (page: number, y: number, over: Partial<Placement> = {}): Placement => ({
  page,
  order: 0,
  box: { x: 0.1, y, w: 0.5, h: 0.2 },
  width: 400,
  height: 200,
  hash: `h-${page}-${y}`,
  ...over,
});
test('content images are kept; tiny icons, full-page backgrounds and logos on most pages are not', () => {
  const kept = keepImages(
    [
      placement(1, 0.3),
      placement(1, 0.5, { width: 16, height: 16, hash: 'icon' }),
      placement(2, 0.1, { box: { x: 0, y: 0, w: 1, h: 1 }, hash: 'background' }),
      placement(1, 0.02, { hash: 'logo' }),
      placement(2, 0.02, { hash: 'logo' }),
      placement(3, 0.02, { hash: 'logo' }),
      placement(3, 0.4, { box: { x: 0.1, y: 0.4, w: 0.05, h: 0.05 } }),
    ],
    4,
  );
  assert.deepEqual(kept.map((p) => p.hash), ['h-1-0.3']);
});

test('an image follows the paragraph above it on its page, or opens the page when nothing is above', () => {
  const assembled = assemble([
    [{ text: '첫 쪽 위 문단', top: 100, bottom: 120 }, { text: '첫 쪽 아래 문단', top: 500, bottom: 520 }],
    [{ text: '둘째 쪽 문단', top: 400, bottom: 420 }],
  ]);
  const [middle, top] = placeImages([placement(1, 0.3), placement(2, 0.1)], assembled, [1000, 1000]);
  assert.equal(middle.paragraph, 0);
  assert.equal(middle.anchor, assembled.paragraphs[0].end);
  assert.equal(middle.context, '첫 쪽 위 문단');
  assert.equal(top.paragraph, 1, 'the last paragraph before its page');
  assert.equal(top.anchor, assembled.pageBreaks[1], 'but it belongs at the start of page 2');
  assert.equal(top.context, '첫 쪽 아래 문단');
});

const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/pdf/${name}.pdf`));
test('fixture: a printed Korean document comes out as clean paragraphs with pages and located figures', async () => {
  const result = await extractPdf(fixture('document'));
  const { text } = result;
  assert.equal(result.pages, 3);
  assert.equal(result.method, 'pdf-text');
  assert.equal(result.warning, undefined);
  assert.ok(!/-- \d+ of \d+ --/.test(text) && !text.includes('\t'), 'no page markers or tabs');
  assert.ok(!text.includes('검증 자료') && !/^- \d+ -$/m.test(text), 'running header and footer gone');
  assert.ok(text.includes('I. 공모 개요 (2쪽)') && text.includes('II. 선정 절차 (3쪽)'), 'table of contents tidied');
  assert.ok(
    text.includes('함께 제공하는 프로그램이다. 선정된 팀은') && text.includes('시제품을 시험하며, 마지막'),
    'a wrapped paragraph reads as one, split words rejoined',
  );
  assert.ok(text.includes('\n\n○ 모집 대상: 창업 3년 이내의 기후테크 기업\n\n○ 지원 내용'), 'list items stay separate');
  const pageOf = (phrase: string) => result.pageBreaks.filter((start) => start <= text.indexOf(phrase)).length;
  assert.deepEqual([pageOf('2023. 11.'), pageOf('이 사업은'), pageOf('서류와 발표로')], [1, 2, 3]);
  assert.deepEqual(
    result.images.map((i) => [i.page, i.context.slice(0, 9)]),
    [
      [2, '이 사업은 기후 '],
      [3, '서류와 발표로 두'],
    ],
    'the chart and the diagram, after the paragraphs that introduce them; no logo or icon',
  );
  for (const image of result.images) {
    assert.equal(image.mime, 'image/webp');
    assert.equal(image.data.subarray(8, 12).toString(), 'WEBP');
    const start = text.lastIndexOf(image.context, image.anchor);
    assert.ok(start >= 0 && !text.slice(start, image.anchor).includes('\n\n'), 'anchored at the end of the paragraph it follows');
    assert.ok(text.slice(image.anchor).startsWith('\n\n'), 'between two paragraphs');
  }
});

test('fixture: a page without a text layer is OCR-read when a reader is given, and reported otherwise', async () => {
  const bare = await extractPdf(fixture('scanned'));
  assert.equal(bare.pages, 2);
  assert.equal(bare.method, 'pdf-text');
  assert.equal(bare.warning, '1쪽은 이미지로만 되어 있어 본문에 넣지 못했어요.');
  assert.deepEqual(bare.pageBreaks, [0, 0]);
  const calls: number[] = [];
  const read = await extractPdf(fixture('scanned'), {
    ocr: async (png) => {
      calls.push(png.length);
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      return '광합성은 빛에너지를 화학 에너지로 바꾸는 과정이다.\n\n엽록체의 틸라코이드에서 명반응이 일어난다.';
    },
  });
  assert.equal(calls.length, 1, 'only the page without text is sent');
  assert.equal(read.method, 'pdf-mixed');
  assert.equal(read.warning, undefined);
  assert.ok(read.text.startsWith('광합성은 빛에너지를'));
  assert.equal(read.text.slice(read.pageBreaks[1]).startsWith('둘째 쪽'), true);
  console.log('PDF_EXTRACT_FIXTURE_VERIFIED');
});

test('the whole extraction suite ran', () => {
  console.log('PDF_EXTRACT_VERIFIED');
});
