import type { CommunityDraft } from './community-types';
const ttl = 7 * 24 * 60 * 60 * 1000;
const key = (userId: string) => `memoryz.community.draft.v3.${userId}`;
export function readCommunityDraft(userId: string, now = Date.now()): CommunityDraft | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const value = JSON.parse(localStorage.getItem(key(userId)) || 'null');
    if (
      !value ||
      !Array.isArray(value.blocks) ||
      value.blocks.length > 5 ||
      typeof value.requestId !== 'string' ||
      !value.requestId ||
      typeof value.title !== 'string' ||
      typeof value.body !== 'string' ||
      typeof value.category !== 'string' ||
      typeof value.anonymous !== 'boolean' ||
      !value.tags ||
      typeof value.tags !== 'object' ||
      value.blocks.some(
        (b: any) =>
          !b ||
          typeof b.id !== 'string' ||
          !['QUESTION', 'CARD', 'MATERIAL', 'PHOTO', 'ESSAY', 'POLL', 'SCHEDULE', 'MATH'].includes(
            b.type,
          ) ||
          !b.payload ||
          typeof b.payload !== 'object',
      ) ||
      !['all', 'school'].includes(value.scope)
    )
      return null;
    const updated = Date.parse(value.updatedAt);
    if (!Number.isFinite(updated) || now - updated > ttl) {
      localStorage.removeItem(key(userId));
      return null;
    }
    return value;
  } catch {
    return null;
  }
}
export function saveCommunityDraft(userId: string, draft: CommunityDraft): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key(userId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}
export function clearCommunityDraft(userId: string) {
  try {
    localStorage.removeItem(key(userId));
  } catch {
    /* The current form still knows its receipt. */
  }
}
export function communityGroup(category: string) {
  return category === '질문'
    ? '질문'
    : ['수시', '정시', '입시'].includes(category)
      ? '입시'
      : '공부 이야기';
}
