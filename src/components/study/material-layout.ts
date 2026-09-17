// Pure layout for the material viewer: the extracted text split by page and paragraph, images put
// back where they were, a citation located despite whitespace differences, and error states turned
// into words. No DOM, no fetch — tests/material-viewer.test.ts covers every rule.
import type { MaterialImage } from '@/lib/contracts';

export type Paragraph = { start: number; end: number; text: string };
export type PageBlock = { kind: 'paragraph'; paragraph: Paragraph; index: number } | { kind: 'image'; image: MaterialImage };
export type PageLayout = { page: number; start: number; end: number; blocks: PageBlock[] };

/** Splits the body at pageBreaks (offsets where each page starts); without breaks the body is one page. */
export function splitPages(content: string, pageBreaks: number[] | undefined): { page: number; start: number; end: number; text: string }[] {
  const breaks = (pageBreaks ?? []).filter((n, i, all) => Number.isInteger(n) && n >= 0 && n <= content.length && (i === 0 || n >= all[i - 1]));
  const starts = breaks.length ? [...(breaks[0] === 0 ? [] : [0]), ...breaks] : [0];
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : content.length;
    return { page: i + 1, start, end, text: content.slice(start, end) };
  });
}

/** Paragraphs are blank-line separated; offsets are absolute in the body so anchors can be matched. */
export function splitParagraphs(text: string, base = 0): Paragraph[] {
  const out: Paragraph[] = [];
  const pattern = /\n[ \t]*\n+/g;
  let cursor = 0;
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    if (raw.trim()) out.push({ start: base + from + leading, end: base + to - trailing, text: raw.trim() });
  };
  for (const match of text.matchAll(pattern)) {
    push(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  push(cursor, text.length);
  return out;
}

/**
 * Builds each page's blocks. An image goes after the paragraph that contains its anchor; when the
 * text was edited (no page breaks left) or the anchor is stale, the paragraph starting with the
 * image's context sentence is used; failing both, the image closes its page.
 */
export function placeImages(content: string, pageBreaks: number[] | undefined, images: MaterialImage[]): PageLayout[] {
  const pages = splitPages(content, pageBreaks);
  const anchored = (pageBreaks ?? []).length > 0;
  const layouts: PageLayout[] = pages.map((p) => ({ page: p.page, start: p.start, end: p.end, blocks: [] }));
  const paragraphs = pages.map((p) => splitParagraphs(p.text, p.start));
  let index = 0;
  const slots: { paragraph: Paragraph; index: number; images: MaterialImage[] }[][] = paragraphs.map((list) => list.map((paragraph) => ({ paragraph, index: index++, images: [] })));
  const tails: MaterialImage[][] = pages.map(() => []);
  const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (const image of [...images].sort((a, b) => a.page - b.page || a.order - b.order)) {
    const pageIndex = Math.min(Math.max(image.page, 1), pages.length) - 1;
    let target = anchored && image.anchor >= 0 ? slots.flat().find((s) => image.anchor >= s.paragraph.start && image.anchor <= s.paragraph.end) : undefined;
    if (!target && image.context) {
      const context = normalise(image.context).slice(0, 40);
      const candidates = context ? [...slots[pageIndex], ...slots.flat()] : [];
      target = candidates.find((s) => normalise(s.paragraph.text).startsWith(context));
    }
    if (target) target.images.push(image);
    else tails[pageIndex].push(image);
  }
  slots.forEach((list, pageIndex) => {
    for (const slot of list) {
      layouts[pageIndex].blocks.push({ kind: 'paragraph', paragraph: slot.paragraph, index: slot.index });
      for (const image of slot.images) layouts[pageIndex].blocks.push({ kind: 'image', image });
    }
    for (const image of tails[pageIndex]) layouts[pageIndex].blocks.push({ kind: 'image', image });
  });
  return layouts;
}

/** Where a citation sits in the body, ignoring whitespace differences; page from the page breaks. */
export function findCitation(content: string, citation: string, pageBreaks?: number[]): { start: number; end: number; page: number } | null {
  const quote = citation.trim();
  if (!quote) return null;
  const exact = content.indexOf(quote);
  if (exact >= 0) {
    const page = splitPages(content, pageBreaks).find((p) => exact >= p.start && exact < Math.max(p.end, p.start + 1))?.page ?? 1;
    return { start: exact, end: exact + quote.length, page };
  }
  const needle = citation.replace(/\s+/g, '');
  if (!needle) return null;
  // Map each non-whitespace character of the body back to its offset.
  const offsets: number[] = [];
  let compact = '';
  for (let i = 0; i < content.length; i++) {
    if (!/\s/.test(content[i])) {
      compact += content[i];
      offsets.push(i);
    }
  }
  const at = compact.indexOf(needle);
  if (at < 0) return null;
  const start = offsets[at];
  const end = offsets[at + needle.length - 1] + 1;
  const page = splitPages(content, pageBreaks).find((p) => start >= p.start && start < Math.max(p.end, p.start + 1))?.page ?? 1;
  return { start, end, page };
}

/** The title without a trailing file extension (`제안서.pdf` → `제안서`). */
export function displayTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.replace(/\.(pdf|txt|md|png|jpe?g|webp|gif|heic)$/i, '') || trimmed;
}

/** "PDF · 3쪽 · 그림 2" style meta line. */
export function metaLabel(material: { type: string; extraction?: string; pages?: number; imageCount?: number; contentLength?: number }): string {
  const parts = [material.extraction === 'combined' ? '모은 자료' : material.type.toUpperCase()];
  if (material.pages) parts.push(`${material.pages}쪽`);
  if (material.imageCount) parts.push(`그림 ${material.imageCount}`);
  if (!material.pages && material.contentLength !== undefined) parts.push(`${material.contentLength.toLocaleString('ko-KR')}자`);
  return parts.join(' · ');
}

export type ViewerFailure = { status?: number; network?: boolean; pdf?: 'invalid' | 'password' | 'timeout' };

/** What went wrong and whether trying again can help. */
export function describeFailure(failure: ViewerFailure): { message: string; retry: boolean } {
  if (failure.status === 410) return { message: '원본 파일이 더 이상 없어요. 추출한 본문은 그대로 볼 수 있어요.', retry: false };
  if (failure.status === 401) return { message: '로그인이 풀렸어요. 다시 로그인한 뒤 열어 주세요.', retry: false };
  if (failure.status === 404) return { message: '자료를 찾을 수 없어요. 삭제됐거나 다른 계정의 자료예요.', retry: false };
  if (failure.pdf === 'password') return { message: '암호가 있는 PDF예요. 파일을 저장한 뒤 열어 주세요.', retry: false };
  if (failure.pdf === 'invalid') return { message: 'PDF 파일이 손상되어 그릴 수 없어요. 본문은 그대로 볼 수 있어요.', retry: false };
  if (failure.pdf === 'timeout') return { message: '불러오는 데 시간이 오래 걸려요. 연결을 확인하고 다시 시도해 주세요.', retry: true };
  if (failure.network || (failure.status !== undefined && failure.status >= 500)) return { message: '연결이 끊겼어요. 연결을 확인하고 다시 시도해 주세요.', retry: true };
  return { message: '자료를 불러오지 못했어요. 다시 시도해 주세요.', retry: true };
}

/** Zoom steps for the preview (100% first, then wider). */
export const ZOOM_STEPS = [1, 1.5, 2, 3] as const;
export function nextZoom(current: number, direction: 1 | -1): number {
  const i = ZOOM_STEPS.findIndex((z) => z === current);
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? 0 : i) + direction))];
  return next;
}
