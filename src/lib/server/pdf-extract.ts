// PDF -> learning text. pdf.js gives positioned text pieces and image paint operations; the pure layout
// below turns them into paragraphs without page markers, tabs, TOC leaders, running headers/footers or
// page-number lines, records where every page starts in the text, and anchors each embedded image to
// the paragraph it follows. Pages without a text layer can be read by an OCR callback.
import { createHash } from 'node:crypto';

/** A text run in page coordinates: x/y from the top-left, y at the baseline, all in PDF points. */
export interface Piece {
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
}
export interface Line {
  text: string;
  x: number;
  right: number;
  y: number;
  size: number;
}
export interface Block {
  text: string;
  top: number;
  bottom: number;
}
export interface PageLayout {
  width: number;
  height: number;
  lines: Line[];
}
/** Where an image was painted: box normalised to the page (0..1, top-left origin). */
export interface Placement {
  page: number;
  order: number;
  box: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  hash: string;
}
export interface PlacedImage extends Placement {
  /** Global index of the paragraph the image follows; -1 when it comes before any text. */
  paragraph: number;
  /** Offset in the extracted text where the image belongs (end of that paragraph, or its page start). */
  anchor: number;
  /** Start of the paragraph it follows, to re-anchor after the text is edited. */
  context: string;
}

const clean = (value: string) =>
  value
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ');

/** Pieces sharing a baseline form a line; a visible gap becomes one space, never a tab. */
export function toLines(pieces: Piece[]): Line[] {
  const sorted = pieces
    .map((piece) => ({ ...piece, str: clean(piece.str) }))
    .filter((piece) => piece.str.length > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Piece[][] = [];
  for (const piece of sorted) {
    const row = rows.at(-1);
    const size = Math.max(piece.size, row?.[0]?.size ?? 0, 1);
    if (row && Math.abs(row[0].y - piece.y) <= size * 0.4) row.push(piece);
    else rows.push([piece]);
  }
  return rows
    .map((row) => {
      row.sort((a, b) => a.x - b.x);
      let text = '';
      let right = row[0].x;
      for (const piece of row) {
        const gap = piece.x - right;
        if (text && !/\s$/.test(text) && !/^\s/.test(piece.str) && gap > Math.max(piece.size, 1) * 0.2)
          text += ' ';
        text += piece.str;
        right = Math.max(right, piece.x + piece.width);
      }
      const words = row.filter((piece) => piece.str.trim());
      return {
        text: text.replace(/\s+/g, ' ').trim(),
        x: (words[0] ?? row[0]).x,
        right,
        y: row[0].y,
        size: Math.max(...row.map((piece) => piece.size)),
      };
    })
    .filter((line) => line.text);
}

const LIST_MARKER =
  /^(?:[○◦●•·▪■□◆◇◈※▶▷►➢✓✔☞\-–—*]\s*|ㅇ\s|\d{1,2}[.)]\s|\(\d{1,2}\)|[①-⑳]|[가-하][.)]\s|\([가-하]\)|[IVX]{1,4}\.\s|[a-z][.)]\s)/;
const SENTENCE_END = /[.!?。…」』"'’”)\]다요죠음함됨임]$/;
const TOC_LEADER = /^(.*?\S)\s*(?:[.·…‥⋯・]\s*){3,}(\d{1,4})$/;
const PAGE_NUMBER = /^(?:[-–—]\s*)?\d{1,4}(?:\s*[-–—])?$|^\d{1,4}\s*\/\s*\d{1,4}$|^(?:page|p\.)\s*\d{1,4}$|^\d{1,4}\s*쪽$/i;

// Korean wraps between any two syllables, so a wrap may split a word ("프 / 로그램"). Particles and endings
// never start a word, a lone syllable that is not a word of its own belongs to the next line, and a joined
// form the document spells elsewhere is trusted; anything else keeps the space a word boundary needs.
const BOUND_START =
  /^(?:을|를|은|는|이|가|의|에|에서|에게|께|로|으로|와|과|도|만|까지|부터|처럼|보다|하며|하고|하여|하는|하게|해|했다|했고|한다|한|할|함|된다|된|될|됨|이다|이며|입니다|적|적인|들|들이|들을|들의)(?=[\s.,·)」』”'"]|$)/;
const LONE_WORD = new Set('및 등 또 더 덜 안 못 잘 꼭 곧 좀 참 각 전 후 제 총 약 매 첫 새 옛 온 그 이 저 수 것 줄 때 곳 점 번 개 명 년 월 일 원 분 초 쪽 장 권 회 차 위 나 너 뭐 왜 늘 다 막 즉 및 겸 대 중 내 외'.split(' '));
/** How two soft-wrapped lines meet: "" to rejoin a split word, " " at a word boundary. */
export function wrapJoin(before: string, after: string, lexicon: Set<string> = new Set()): string {
  const tail = /([가-힣]+)$/.exec(before)?.[1];
  const head = /^([가-힣]+)/.exec(after)?.[1];
  if (!tail || !head || /\s$/.test(before) || /^\s/.test(after)) return ' ';
  if (BOUND_START.test(after)) return '';
  const lastWord = /(\S+)$/.exec(before)?.[1] ?? tail;
  const firstWord = /^(\S+)/.exec(after)?.[1] ?? head;
  const joined = (lastWord + firstWord).replace(/[^가-힣A-Za-z0-9]/g, '');
  const stem = lastWord.replace(/[^가-힣A-Za-z0-9]/g, '') + head[0];
  if (lexicon.has(joined) || (stem.length >= 3 && [...lexicon].some((word) => word.startsWith(stem)))) return '';
  if (lastWord === tail && tail.length === 1 && !LONE_WORD.has(tail)) return '';
  return ' ';
}
/** Whole words of the document, to recognise a word a wrap split. */
export function lexiconOf(lines: Line[]): Set<string> {
  const words = new Set<string>();
  for (const line of lines)
    for (const word of line.text.split(/\s+/)) {
      const bare = word.replace(/[^가-힣A-Za-z0-9]/g, '');
      if (bare.length >= 2) words.add(bare);
    }
  return words;
}

/** A table-of-contents line keeps its title and page, not the leader dots. */
export function tidyLine(text: string) {
  const leader = TOC_LEADER.exec(text);
  return leader ? `${leader[1]} (${leader[2]}쪽)` : text;
}

/** Soft-wrapped lines join with a space; spacing, indents, short lines and list markers end a paragraph. */
export function toParagraphs(lines: Line[], lexicon: Set<string> = lexiconOf(lines)): Block[] {
  if (!lines.length) return [];
  const gaps = lines
    .slice(1)
    .map((line, i) => line.y - lines[i].y)
    .filter((gap, i) => gap > 0 && gap < lines[i].size * 3 && Math.abs(lines[i + 1].size - lines[i].size) <= lines[i].size * 0.15)
    .sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : lines[0].size * 1.5;
  const rights = lines.map((line) => line.right).sort((a, b) => a - b);
  const blockRight = rights[Math.floor(rights.length * 0.9)] ?? rights.at(-1)!;
  const lefts = lines.map((line) => line.x).sort((a, b) => a - b);
  const blockLeft = lefts[Math.floor(lefts.length * 0.1)] ?? lefts[0];
  const blocks: Block[] = [];
  let parts: string[] = [];
  let top = 0;
  let bottom = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = tidyLine(line.text);
    const previous = lines[i - 1];
    const startsNew =
      !previous ||
      line.y - previous.y > typical * 1.45 ||
      Math.abs(line.size - previous.size) > previous.size * 0.15 ||
      LIST_MARKER.test(text) ||
      TOC_LEADER.test(line.text) ||
      TOC_LEADER.test(previous.text) ||
      // A line that stopped short of the column did not wrap: the paragraph ended there.
      previous.right < blockLeft + (blockRight - blockLeft) * 0.8 ||
      (SENTENCE_END.test(previous.text) && line.x > blockLeft + line.size * 0.8);
    if (startsNew) {
      if (parts.length) blocks.push({ text: parts.join(''), top, bottom });
      parts = [text];
      top = line.y - line.size;
    } else {
      const last = parts[parts.length - 1];
      // A Latin word hyphenated at the line end rejoins; everything else wraps with a space.
      if (/[A-Za-z]-$/.test(last) && /^[a-z]/.test(text)) parts[parts.length - 1] = last.slice(0, -1) + text;
      else parts.push(wrapJoin(last, text, lexicon) + text);
    }
    bottom = line.y;
  }
  if (parts.length) blocks.push({ text: parts.join(''), top, bottom });
  return blocks.filter((block) => block.text.trim());
}

const shape = (text: string) => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
/** Lines repeated in the top or bottom band of most pages, and bare page numbers there, are furniture. */
export function dropFurniture(pages: PageLayout[]): PageLayout[] {
  const band = (page: PageLayout, line: Line) => line.y < page.height * 0.1 || line.y - line.size > page.height * 0.9;
  const seen = new Map<string, number>();
  for (const page of pages) {
    const shapes = new Set(page.lines.filter((line) => band(page, line)).map((line) => shape(line.text)));
    for (const s of shapes) seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  const repeated = new Set(
    [...seen].filter(([, count]) => count >= 3 && count >= pages.length * 0.5).map(([s]) => s),
  );
  return pages.map((page) => ({
    ...page,
    lines: page.lines.filter(
      (line) => !(band(page, line) && (repeated.has(shape(line.text)) || PAGE_NUMBER.test(line.text.trim()))),
    ),
  }));
}

export interface Assembled {
  text: string;
  pageBreaks: number[];
  paragraphs: { page: number; start: number; end: number; top: number; bottom: number; text: string }[];
}
/** Joins page paragraphs with blank lines and records where each page and paragraph starts. */
export function assemble(pages: Block[][]): Assembled {
  let text = '';
  const pageBreaks: number[] = [];
  const paragraphs: Assembled['paragraphs'] = [];
  pages.forEach((blocks, index) => {
    if (text && blocks.length) text += '\n\n';
    pageBreaks.push(text.length);
    blocks.forEach((block, i) => {
      if (i) text += '\n\n';
      const start = text.length;
      text += block.text;
      paragraphs.push({ page: index + 1, start, end: text.length, top: block.top, bottom: block.bottom, text: block.text });
    });
  });
  return { text, pageBreaks, paragraphs };
}

/** Keeps images that carry content: not tiny, not a full-page background, not a logo on most pages. */
export function keepImages(placements: Placement[], pageCount: number): Placement[] {
  const pagesByHash = new Map<string, Set<number>>();
  for (const p of placements) pagesByHash.set(p.hash, (pagesByHash.get(p.hash) ?? new Set()).add(p.page));
  return placements.filter((p) => {
    const area = p.box.w * p.box.h;
    const repeatedOn = pagesByHash.get(p.hash)!.size;
    return (
      Math.min(p.width, p.height) >= 48 &&
      area >= 0.01 &&
      area <= 0.85 &&
      !(repeatedOn >= 3 && repeatedOn >= pageCount * 0.5)
    );
  });
}

/** An image follows the last paragraph on its page that starts above it; otherwise it opens the page. */
export function placeImages(placements: Placement[], assembled: Assembled, pageHeights: number[]): PlacedImage[] {
  return placements.map((p) => {
    const top = p.box.y * pageHeights[p.page - 1];
    let index = -1;
    assembled.paragraphs.forEach((paragraph, i) => {
      if (paragraph.page < p.page || (paragraph.page === p.page && paragraph.top < top)) index = i;
    });
    const onPage = index >= 0 && assembled.paragraphs[index].page === p.page;
    const anchor = onPage ? assembled.paragraphs[index].end : (assembled.pageBreaks[p.page - 1] ?? assembled.text.length);
    return {
      ...p,
      paragraph: index,
      anchor,
      context: index >= 0 ? assembled.paragraphs[index].text.slice(0, 60) : '',
    };
  });
}

export interface ExtractedImage extends PlacedImage {
  mime: 'image/webp';
  data: Buffer;
}
export interface PdfExtraction {
  text: string;
  pages: number;
  pageBreaks: number[];
  method: 'pdf-text' | 'pdf-ocr' | 'pdf-mixed';
  images: ExtractedImage[];
  warning?: string;
}
type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = ([x, y]: [number, number], m: Matrix): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const MAX_IMAGES = 40;
const MAX_OCR_PAGES = 12;
const IMAGE_EDGE = 1600;

/**
 * Reads a PDF. `ocr` turns a rendered page (PNG) into text and is only called for pages without a text
 * layer, at most MAX_OCR_PAGES of them.
 */
export async function extractPdf(data: Uint8Array, options: { ocr?: (png: Buffer) => Promise<string> } = {}): Promise<PdfExtraction> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const doc = await pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  try {
    const layouts: PageLayout[] = [];
    const placements: (Placement & { pixels: () => Promise<Buffer | null> })[] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const pieces: Piece[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue;
        const [a, b, c, d, e, f] = multiply(viewport.transform as Matrix, item.transform as Matrix);
        pieces.push({ str: item.str, x: e, y: f, width: item.width, size: Math.hypot(c, d) || Math.hypot(a, b) || item.height || 10 });
      }
      layouts.push({ width: viewport.width, height: viewport.height, lines: toLines(pieces) });
      const ops = await page.getOperatorList();
      let ctm: Matrix = [1, 0, 0, 1, 0, 0];
      const stack: Matrix[] = [];
      let order = 0;
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === pdfjs.OPS.save) stack.push(ctm);
        else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === pdfjs.OPS.transform) ctm = multiply(ctm, args as Matrix);
        else if (fn === pdfjs.OPS.paintFormXObjectBegin) {
          stack.push(ctm);
          if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = multiply(ctm, args[0] as Matrix);
        } else if (fn === pdfjs.OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
        else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
          const toPage = viewport.transform as Matrix;
          const corners = ([[0, 0], [1, 0], [0, 1], [1, 1]] as [number, number][]).map((corner) =>
            apply(apply(corner, ctm), toPage),
          );
          const xs = corners.map((point) => point[0]);
          const ys = corners.map((point) => point[1]);
          const box = {
            x: Math.max(0, Math.min(...xs) / viewport.width),
            y: Math.max(0, Math.min(...ys) / viewport.height),
            w: (Math.max(...xs) - Math.min(...xs)) / viewport.width,
            h: (Math.max(...ys) - Math.min(...ys)) / viewport.height,
          };
          const image = fn === pdfjs.OPS.paintInlineImageXObject ? args[0] : await resolveImage(page, String(args[0]));
          if (!image?.width || !image?.height) continue;
          const raw = rawRgba(image, pdfjs.ImageKind);
          if (!raw) continue;
          placements.push({
            page: number,
            order: order++,
            box,
            width: image.width,
            height: image.height,
            hash: createHash('sha1').update(raw).digest('hex'),
            pixels: async () => encodeImage(createCanvas, raw, image.width, image.height),
          });
        }
      }
      page.cleanup();
    }
    const furnished = dropFurniture(layouts);
    const lexicon = lexiconOf(furnished.flatMap((layout) => layout.lines));
    const blocks = furnished.map((layout) => toParagraphs(layout.lines, lexicon));
    // Pages without a text layer: OCR when possible, otherwise say so.
    const empty = blocks.map((b, i) => (b.reduce((n, block) => n + block.text.replace(/\s/g, '').length, 0) < 16 ? i + 1 : 0)).filter(Boolean);
    let read = 0;
    if (options.ocr && empty.length) {
      const { PDFParse } = await import('pdf-parse');
      const renderer = new PDFParse({ data: data.slice() });
      try {
        const shots = await renderer.getScreenshot({ partial: empty.slice(0, MAX_OCR_PAGES), desiredWidth: 1400, imageBuffer: true, imageDataUrl: false });
        for (const shot of shots.pages) {
          const text = clean(await options.ocr(Buffer.from(shot.data))).trim();
          if (!text) continue;
          blocks[shot.pageNumber - 1] = text.split(/\n\s*\n/).map((part, i) => ({ text: part.replace(/\s*\n\s*/g, ' ').trim(), top: i, bottom: i })).filter((b) => b.text);
          read++;
        }
      } finally {
        await renderer.destroy();
      }
    }
    const assembled = assemble(blocks);
    const kept = keepImages(placements, doc.numPages).slice(0, MAX_IMAGES) as typeof placements;
    const placed = placeImages(kept, assembled, layouts.map((layout) => layout.height));
    const images: ExtractedImage[] = [];
    for (const [i, image] of placed.entries()) {
      const bytes = await kept[i].pixels();
      if (bytes) {
        const { pixels: _pixels, ...rest } = image as typeof image & { pixels?: unknown };
        images.push({ ...rest, mime: 'image/webp', data: bytes });
      }
    }
    const unread = empty.length - read;
    const warning = !assembled.text.trim()
      ? '글자 층이 없는 스캔 PDF예요. 본문을 직접 입력하거나 페이지를 사진으로 올려 주세요.'
      : unread > 0
        ? `${unread}쪽은 이미지로만 되어 있어 본문에 넣지 못했어요.`
        : undefined;
    return {
      text: assembled.text,
      pages: doc.numPages,
      pageBreaks: assembled.pageBreaks,
      method: read === 0 ? 'pdf-text' : read === doc.numPages ? 'pdf-ocr' : 'pdf-mixed',
      images,
      ...(warning ? { warning } : {}),
    };
  } finally {
    await doc.destroy();
  }
}

type PdfImage = { width: number; height: number; kind?: number; data?: Uint8Array | Uint8ClampedArray };
function resolveImage(page: { objs: any; commonObjs: any }, name: string): Promise<PdfImage | null> {
  const store = page.commonObjs.has(name) ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    try {
      store.get(name, (image: PdfImage | null) => resolve(image ?? null));
    } catch {
      resolve(null);
    }
  });
}
/** pdf.js image data as RGBA bytes (1-bit grayscale, RGB and RGBA kinds). */
function rawRgba(image: PdfImage, kinds: { GRAYSCALE_1BPP: number; RGB_24BPP: number; RGBA_32BPP: number }): Uint8ClampedArray | null {
  const { width, height, kind, data } = image;
  if (!data) return null;
  const out = new Uint8ClampedArray(width * height * 4);
  if (kind === kinds.RGBA_32BPP) out.set(data.subarray(0, out.length));
  else if (kind === kinds.RGB_24BPP)
    for (let p = 0, q = 0; q < out.length; p += 3, q += 4) {
      out[q] = data[p];
      out[q + 1] = data[p + 1];
      out[q + 2] = data[p + 2];
      out[q + 3] = 255;
    }
  else if (kind === kinds.GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const q = (y * width + x) * 4;
        out[q] = out[q + 1] = out[q + 2] = bit ? 255 : 0;
        out[q + 3] = 255;
      }
  } else return null;
  return out;
}
async function encodeImage(
  createCanvas: (w: number, h: number) => any,
  raw: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Buffer | null> {
  try {
    const source = createCanvas(width, height);
    const context = source.getContext('2d');
    const pixels = context.createImageData(width, height);
    pixels.data.set(raw);
    context.putImageData(pixels, 0, 0);
    const scale = Math.min(1, IMAGE_EDGE / Math.max(width, height));
    if (scale === 1) return await source.encode('webp', 82);
    const target = createCanvas(Math.round(width * scale), Math.round(height * scale));
    target.getContext('2d').drawImage(source, 0, 0, target.width, target.height);
    return await target.encode('webp', 82);
  } catch {
    return null;
  }
}
