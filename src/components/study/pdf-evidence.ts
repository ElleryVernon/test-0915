import { findCitation, splitPages } from './material-layout';

export type PdfEvidencePage = { page: number; quote: string };
export type TextSpan = { item: number; start: number; end: number };

/** Pages are derived from immutable text offsets, never guessed from a topic/keyword. */
export function pdfEvidencePages(
  content: string,
  citation: string,
  pageBreaks?: number[],
): PdfEvidencePage[] {
  if (!pageBreaks?.length) return [];
  const found = findCitation(content, citation, pageBreaks);
  if (!found) return [];
  return splitPages(content, pageBreaks)
    .filter((page) => page.start < found.end && page.end > found.start)
    .map((page) => ({
      page: page.page,
      quote: content.slice(Math.max(page.start, found.start), Math.min(page.end, found.end)),
    }))
    .filter((page) => page.quote.trim());
}

/** An owned-upload route returns just these original PDF pages; no third-party URL rewriting. */
export function evidencePdfUrl(url: string, pages: PdfEvidencePage[]): string | null {
  if (!/^\/api\/uploads\/[a-zA-Z0-9-]+(?:\?|$)/.test(url) || !pages.length || pages.length > 12)
    return null;
  const parsed = new URL(url, 'https://memoryz.local');
  parsed.searchParams.set('pages', pages.map((page) => page.page).join(','));
  return parsed.pathname + parsed.search;
}

function normalized(text: string): { text: string; offsets: number[] } {
  let result = '';
  const offsets: number[] = [];
  for (let i = 0; i < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(i)!);
    for (const normalizedChar of char.normalize('NFKC')) {
      if (!/\s/u.test(normalizedChar) && normalizedChar !== '\u00ad') {
        result += normalizedChar;
        for (let n = 0; n < normalizedChar.length; n++) offsets.push(i);
      }
    }
    i += char.length;
  }
  return { text: result, offsets };
}

/**
 * Matches long, unique literal runs between the cited page text and PDF text
 * items. No fuzzy keyword highlighting: damaged notation and ambiguous repeated
 * phrases remain unmarked. NFKC handles ligatures, but signs/digits are kept.
 * Works even when two extractors disagree about column/paragraph ordering.
 */
export function matchPdfEvidence(items: readonly { str: string }[], quote: string): TextSpan[] {
  const needle = normalized(quote).text;
  if (needle.length < 8) return [];
  const maps = items.map((item) => normalized(item.str));
  const starts: number[] = [];
  let source = '';
  for (const map of maps) {
    starts.push(source.length);
    source += map.text;
  }
  if (!source) return [];
  const size = Math.min(24, needle.length);
  const windows = new Set<string>();
  for (let i = 0; i <= needle.length - size; i++) windows.add(needle.slice(i, i + size));
  // A window must uniquely identify a position on the actual PDF page.
  const positions = new Map<string, number>();
  for (let i = 0; i <= source.length - size; i++) {
    const key = source.slice(i, i + size);
    if (windows.has(key)) positions.set(key, positions.has(key) ? -1 : i);
  }
  const matched = new Uint8Array(source.length);
  for (const position of positions.values()) {
    if (position >= 0) matched.fill(1, position, position + size);
  }
  const spans: TextSpan[] = [];
  maps.forEach((map, item) => {
    for (let i = 0; i < map.text.length;) {
      if (!matched[starts[item] + i]) {
        i++;
        continue;
      }
      const from = i;
      while (i < map.text.length && matched[starts[item] + i]) i++;
      const last = map.offsets[i - 1];
      const literal = map.text.slice(from, i);
      if (!/[\p{L}\p{N}]/u.test(literal)) continue;
      // A matching sentence must not color a stray punctuation/short suffix
      // on an adjacent, otherwise unrelated text run.
      if (literal.length < 8 && literal.length < map.text.length * 0.9) continue;
      spans.push({
        item,
        start: map.offsets[from],
        end: last + String.fromCodePoint(items[item].str.codePointAt(last)!).length,
      });
    }
  });
  return spans;
}
