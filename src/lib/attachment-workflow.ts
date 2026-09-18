import type { CommunityBlockType } from './community-types';

export type AttachmentRoute = { type: CommunityBlockType | null; preview: boolean };
export function initialAttachmentRoute(
  types: CommunityBlockType[],
  initialType?: CommunityBlockType,
): AttachmentRoute {
  return { type: initialType && types.includes(initialType) ? initialType : null, preview: false };
}
export function permittedAttachmentTypes(
  role: string,
  comment = false,
  requested?: CommunityBlockType[],
): CommunityBlockType[] {
  const types: CommunityBlockType[] =
    role === 'PARENT'
      ? comment
        ? ['PHOTO']
        : ['PHOTO', 'POLL']
      : comment
        ? ['QUESTION', 'CARD', 'PHOTO', 'MATH']
        : ['QUESTION', 'CARD', 'MATERIAL', 'PHOTO', 'ESSAY', 'POLL', 'SCHEDULE', 'MATH'];
  return requested ? types.filter((type) => requested.includes(type)) : types;
}
export function attachmentCapacity(
  type: CommunityBlockType,
  remaining: number,
  photoCount: number,
): boolean {
  return remaining > 0 && (type !== 'PHOTO' || photoCount < 4);
}
/** Never replace a user's selection or silently remove other sentences. */
export function updateExcerptRange(
  previous: number[],
  index: number,
  checked: boolean,
): { indices: number[]; error: string } {
  const indices = [...new Set(previous)].sort((a, b) => a - b);
  if (!Number.isInteger(index) || index < 0)
    return { indices, error: '선택할 문장을 다시 확인해 주세요.' };
  const next = checked
    ? [...new Set([...indices, index])].sort((a, b) => a - b)
    : indices.filter((n) => n !== index);
  if (next.length > 3)
    return {
      indices,
      error: '최대 3문장까지 첨부할 수 있어요. 선택을 초기화하면 다른 부분을 고를 수 있어요.',
    };
  if (next.some((n, i) => i > 0 && n !== next[i - 1] + 1))
    return {
      indices,
      error: checked
        ? '바로 이어지는 문장을 선택해 주세요. 다른 부분은 선택을 초기화한 뒤 고를 수 있어요.'
        : '중간 문장만 뺄 수는 없어요. 앞이나 뒤 문장부터 해제해 주세요.',
    };
  return { indices: next, error: '' };
}
export function pollInputError(question: string, options: string[]): string {
  if (!question.trim()) return '투표 질문을 입력해 주세요.';
  if (options.length < 2 || options.length > 4 || options.some((option) => !option.trim()))
    return '선택지 2~4개를 모두 입력해 주세요.';
  if (new Set(options.map((option) => option.trim())).size !== options.length)
    return '선택지는 서로 다르게 입력해 주세요.';
  return '';
}

/** Shared by material fetches so closing/back never applies a late response. */
export function createAttachmentRequestGuard() {
  let generation = 0;
  return {
    start: () => ++generation,
    cancel: () => {
      generation++;
    },
    isCurrent: (token: number) => generation === token,
  };
}
export function insertMathSymbol(value: string, start: number, end: number, symbol: string) {
  const from = Math.max(0, Math.min(value.length, start));
  const to = Math.max(from, Math.min(value.length, end));
  const next = value.slice(0, from) + symbol + value.slice(to);
  return next.length <= 2000
    ? { value: next, caret: from + symbol.length }
    : { value, caret: from };
}
