/** A presentation of an immutable quote, never a repaired/translated quotation.
 * Offsets remain UTF-16 positions in citation. A layout run can always be
 * inspected verbatim; its removal is represented by an explicit gap in the UI.
 */
export type EvidencePart = {
  kind: 'text' | 'layout';
  start: number;
  end: number;
  text: string;
};

function layoutFragment(text: string): boolean {
  // Keep short Korean explanations and intact equations/chemical reactions.
  if (/[가-힣]/u.test(text) || /[=<>≤≥↔⇌→←]/u.test(text)) return false;
  // A fragment has no sentence and is dominated by short symbols. Length
  // alone is insufficient: "Do not mix." and "NaCl" have distinct roles.
  if (/[.!?。！？]$/.test(text) || text.length > 48) return false;
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return (
    tokens.length > 0 &&
    tokens.filter((word) => word.length <= 3).length >= Math.ceil(tokens.length * 0.65)
  );
}

function diagramLabel(text: string): boolean {
  return /^\([a-z]\)\s+.{1,60}$/i.test(text);
}

export function sourceEvidence(citation: string, extractedPdf = false): EvidencePart[] {
  const paragraphs: EvidencePart[] = [];
  const pattern = /\S[\s\S]*?(?=\n[\t ]*\n|$)/g;
  for (const match of citation.matchAll(pattern)) {
    const raw = match[0].trimEnd();
    if (raw)
      paragraphs.push({
        kind: 'text',
        start: match.index,
        end: match.index + raw.length,
        text: raw,
      });
  }
  if (!extractedPdf) return paragraphs;

  const fragments = paragraphs.map((part) => layoutFragment(part.text.replace(/\s+/g, ' ')));
  const eligible = paragraphs.map(
    (part, i) => fragments[i] || diagramLabel(part.text) || part.text === 'where',
  );
  const result: EvidencePart[] = [];
  for (let i = 0; i < paragraphs.length;) {
    let end = i;
    let count = 0;
    while (end < paragraphs.length && eligible[end]) {
      if (fragments[end]) count++;
      end++;
    }
    // Require a run, not one short scientific term or a numbered list item.
    if (count >= 3) {
      const start = paragraphs[i].start;
      const stop = paragraphs[end - 1].end;
      result.push({ kind: 'layout', start, end: stop, text: citation.slice(start, stop) });
      i = end;
    } else {
      result.push(paragraphs[i]);
      i++;
    }
  }
  return result;
}

/** Whitespace is the only normalization allowed in a displayed source quote. */
export function evidenceText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function evidencePageLabel(
  start: number,
  end: number,
  pageBreaks?: number[],
): string | null {
  if (
    !pageBreaks?.length ||
    !pageBreaks.every((n, i) => Number.isInteger(n) && n >= 0 && (!i || n >= pageBreaks[i - 1]))
  )
    return null;
  const starts = pageBreaks[0] === 0 ? pageBreaks : [0, ...pageBreaks];
  const pageAt = (offset: number) => starts.filter((n) => n <= offset).length;
  const first = pageAt(start);
  const last = pageAt(Math.max(start, end - 1));
  return first === last ? `PDF ${first}쪽` : `PDF ${first}–${last}쪽`;
}
