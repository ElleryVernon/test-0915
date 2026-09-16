/** Sanitize older drafts as well as user actions: uniqueness, available choices, maximum count. */
export function essaySelection(values: string[], choices: string[], limit: number): string[] {
  return [...new Set(values)].filter((word) => choices.includes(word)).slice(0, Math.max(0, limit));
}
export function toggleEssayKeyword(
  current: string[],
  word: string,
  choices: string[],
  limit: number,
) {
  const selected = essaySelection(current, choices, limit);
  if (selected.includes(word)) return selected.filter((value) => value !== word);
  if (!choices.includes(word) || selected.length >= limit) return selected;
  return [...selected, word];
}
export function appendEssayOrder(current: string[], word: string, keywords: string[]) {
  const order = essaySelection(current, keywords, keywords.length);
  return !keywords.includes(word) || order.includes(word) ? order : [...order, word];
}
/** Selecting a filled slot explicitly restarts from there, preserving the earlier sequence. */
export function restartEssayOrder(current: string[], index: number) {
  return current.slice(0, Math.max(0, index));
}
/** This is a writing outline, not a single-answer ordering test. */
export function completeEssayOutline(order: string[], keywords: string[]): boolean {
  return (
    order.length === keywords.length &&
    new Set(order).size === keywords.length &&
    keywords.every((word) => order.includes(word))
  );
}
export function essayPracticeStart(
  draft?: { stage: number; guided?: boolean; answer: string },
  revisionAnswer?: string,
) {
  return {
    stage: draft?.stage ?? 4,
    guided: draft?.guided ?? (!!draft && draft.stage < 4),
    answer: draft?.answer ?? revisionAnswer ?? '',
  };
}
