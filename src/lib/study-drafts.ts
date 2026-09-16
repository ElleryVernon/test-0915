import type { Essay } from './contracts';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface EssayDraft {
  essayId: string;
  revision: string;
  stage: number;
  guided?: boolean;
  coaching?: string;
  selected: string[];
  order: string[];
  hint: boolean;
  answer: string;
  updatedAt: string;
}
const key = (userId: string) => `memoryz-essay-drafts-v1:${encodeURIComponent(userId)}`;
function browserStorage(): DraftStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
export function essayRevision(essay: Essay): string {
  return JSON.stringify([essay.prompt, essay.keywords, essay.distractors]);
}
export function readEssayDrafts(userId: string, storage = browserStorage()): EssayDraft[] {
  try {
    const values: unknown = JSON.parse(storage?.getItem(key(userId)) || '[]');
    if (!Array.isArray(values)) return [];
    return values
      .filter(
        (d): d is EssayDraft =>
          d &&
          typeof d.essayId === 'string' &&
          typeof d.revision === 'string' &&
          Number.isInteger(d.stage) &&
          d.stage >= 1 &&
          d.stage <= 4 &&
          Array.isArray(d.selected) &&
          d.selected.every((s: unknown) => typeof s === 'string') &&
          Array.isArray(d.order) &&
          d.order.every((s: unknown) => typeof s === 'string') &&
          (d.coaching === undefined || typeof d.coaching === 'string') &&
          typeof d.hint === 'boolean' &&
          typeof d.answer === 'string' &&
          typeof d.updatedAt === 'string' &&
          Number.isFinite(Date.parse(d.updatedAt)),
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  } catch {
    return [];
  }
}
export function findEssayDraft(userId: string, essay: Essay, storage = browserStorage()) {
  return readEssayDrafts(userId, storage).find(
    (d) => d.essayId === essay.id && d.revision === essayRevision(essay),
  );
}
export function saveEssayDraft(
  userId: string,
  draft: EssayDraft,
  storage = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    const drafts = readEssayDrafts(userId, storage).filter((d) => d.essayId !== draft.essayId);
    storage.setItem(key(userId), JSON.stringify([draft, ...drafts].slice(0, 30)));
    return true;
  } catch {
    return false;
  }
}
export function removeEssayDraft(userId: string, essayId: string, storage = browserStorage()) {
  try {
    const drafts = readEssayDrafts(userId, storage).filter((d) => d.essayId !== essayId);
    if (drafts.length) storage?.setItem(key(userId), JSON.stringify(drafts));
    else storage?.removeItem(key(userId));
  } catch {
    /* A blocked storage must not interrupt learning. */
  }
}
