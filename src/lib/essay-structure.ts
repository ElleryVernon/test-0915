export type EssayStructureUnit = { text: string; keywords: string[] };

/** Preserve the answer verbatim apart from whitespace at existing sentence/line boundaries. */
export function essayMeaningUnits(text: string): string[] {
  const segmenter = new Intl.Segmenter('ko', { granularity: 'sentence' });
  return text
    .split(/\r?\n+/)
    .flatMap((paragraph) => [...segmenter.segment(paragraph)].map(({ segment }) => segment.trim()))
    .filter(Boolean);
}

/** A reading outline of actual answer text; it does not infer causal relationships. */
export function essayStructure(modelAnswer: string, citation: string, keywords: string[]) {
  const source = modelAnswer.trim() ? 'modelAnswer' : 'citation';
  const normalize = (value: string) => value.replace(/\s+/g, '').toLocaleLowerCase();
  const uniqueKeywords = [...new Set(keywords)].filter((keyword) => keyword.trim());
  const units: EssayStructureUnit[] = essayMeaningUnits(
    source === 'modelAnswer' ? modelAnswer : citation,
  ).map((text) => ({
    text,
    keywords: uniqueKeywords.filter((keyword) => normalize(text).includes(normalize(keyword))),
  }));
  return { source, units };
}
