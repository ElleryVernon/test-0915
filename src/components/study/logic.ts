import type { AppData, Bucket, Card, Mask, StudyAttempt } from '@/lib/contracts';
import { isDue, scheduleCard, type SrsMode } from '@/lib/srs';

export const BUCKETS: { id: Bucket; label: string; delay: string }[] = [
  { id: 'AGAIN', label: '다시', delay: '10분' },
  { id: 'HARD', label: '어려움', delay: '1일' },
  { id: 'GOOD', label: '보통', delay: '3일' },
  { id: 'EASY', label: '쉬움', delay: '7일' },
  { id: 'MASTERED', label: '암기완료', delay: '' },
];
export const TYPES = {
  CONCEPT: ['개념', '용어와 정의', '용어 · 질문', '정의 · 정답'],
  RELATION: ['관계', '원인과 결과', '원인 · 자극', '결과 · 기전'],
  COMPARISON: ['비교', '공통점과 차이', '비교할 두 개념', '공통점 · 차이점'],
  BLIND: ['가림', '이미지에서 떠올리기', '질문', '가린 부분의 정답'],
} as const;
export function latestAttempts(attempts: StudyAttempt[], kind: 'questionId' | 'essayId') {
  const latest = new Map<string, StudyAttempt>();
  for (const attempt of attempts) {
    const id = attempt[kind];
    if (!id) continue;
    if (
      !latest.has(id) ||
      new Date(attempt.createdAt).getTime() >= new Date(latest.get(id)!.createdAt).getTime()
    )
      latest.set(id, attempt);
  }
  return latest;
}
export function wrongQuestions(data: Pick<AppData, 'attempts' | 'questions'>) {
  const latest = latestAttempts(data.attempts, 'questionId');
  return data.questions.filter((q) =>
    latest.has(q.id) ? !latest.get(q.id)!.correct : !!q.savedToNotes,
  );
}
export function wrongEssays(data: Pick<AppData, 'attempts' | 'essays'>) {
  const latest = latestAttempts(data.attempts, 'essayId');
  return data.essays.filter((q) => latest.has(q.id) && latest.get(q.id)!.score < 100);
}
export function exactKeywords(selected: string[], keywords: string[]) {
  return (
    selected.length === keywords.length &&
    new Set(selected).size === keywords.length &&
    keywords.every((k) => selected.includes(k))
  );
}
export function exactOrder(order: string[], keywords: string[]) {
  return order.length === keywords.length && order.every((k, i) => k === keywords[i]);
}
export function normalizeMask(
  start: { x: number; y: number },
  end: { x: number; y: number },
): Mask | null {
  const clamp = (n: number) => Math.min(100, Math.max(0, n));
  const x = Math.min(clamp(start.x), clamp(end.x));
  const y = Math.min(clamp(start.y), clamp(end.y));
  const width = Math.abs(clamp(start.x) - clamp(end.x));
  const height = Math.abs(clamp(start.y) - clamp(end.y));
  return width < 1 || height < 1 ? null : { x, y, width, height };
}
export function localReview(
  card: Card,
  rating: Exclude<Bucket, 'MASTERED'>,
  now = Date.now(),
  mode: SrsMode = 'FIXED',
  retention = 0.9,
): Card {
  return scheduleCard(card, rating, mode, retention, now);
}
export function dueCards(cards: Card[], now = Date.now()) {
  return cards.filter((card) => isDue(card, now));
}
export function intervalLabel(due: string, now = Date.now()) {
  const delta = new Date(due).getTime() - now;
  if (delta <= 0) return '지금';
  if (delta < 3600000) return `${Math.ceil(delta / 60000)}분`;
  if (delta < 86400000) return `${Math.ceil(delta / 3600000)}시간`;
  return `${Math.ceil(delta / 86400000).toLocaleString('ko-KR')}일`;
}
export function reviewLabel(card: Card) {
  if (card.bucket === 'MASTERED' && !card.fsrs) return '암기완료';
  const interval = intervalLabel(card.nextReviewAt);
  return interval === '지금' ? '지금 복습' : `${interval} 뒤`;
}
export function mix<T>(items: T[]): T[] {
  // Stable interleaving makes the exercise order independent from source answer order.
  return items
    .filter((_, i) => i % 2 === 1)
    .reverse()
    .concat(items.filter((_, i) => i % 2 === 0));
}
export function detectHighlights(pixels: Uint8ClampedArray, width: number, height: number): Mask[] {
  if (width < 1 || height < 1 || pixels.length !== width * height * 4)
    throw new Error('Invalid image dimensions');
  const seen = new Uint8Array(width * height);
  const matches = (index: number) => {
    const r = pixels[index * 4],
      g = pixels[index * 4 + 1],
      b = pixels[index * 4 + 2];
    return (
      pixels[index * 4 + 3] > 100 &&
      r > 150 &&
      g > 120 &&
      b < 190 &&
      r + g > b * 2 + 100 &&
      Math.abs(r - g) < 95 &&
      g >= r * 0.72
    );
  };
  const masks: Mask[] = [];
  for (let i = 0; i < width * height; i++) {
    if (seen[i] || !matches(i)) continue;
    const queue = [i];
    seen[i] = 1;
    let cursor = 0,
      left = i % width,
      right = left,
      top = Math.floor(i / width),
      bottom = top;
    while (cursor < queue.length) {
      const p = queue[cursor++],
        x = p % width,
        y = Math.floor(p / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (const next of [
        x > 0 ? p - 1 : -1,
        x + 1 < width ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y + 1 < height ? p + width : -1,
      ])
        if (next >= 0 && !seen[next] && matches(next)) {
          seen[next] = 1;
          queue.push(next);
        }
    }
    if (queue.length < 8 || queue.length / (width * height) > 0.65) continue;
    const mask = normalizeMask(
      { x: (Math.max(0, left - 1) / width) * 100, y: (Math.max(0, top - 1) / height) * 100 },
      {
        x: (Math.min(width, right + 2) / width) * 100,
        y: (Math.min(height, bottom + 2) / height) * 100,
      },
    );
    if (mask) masks.push(mask);
  }
  return masks.slice(0, 100);
}

export type GenerationMode = 'quiz' | 'essay' | 'cards';
export function generatedItemCount(value: unknown, mode: GenerationMode, expected: number) {
  const fail = () => {
    throw new Error('생성 결과를 확인하지 못했어요. 자료함에서 만들어진 항목을 확인해 주세요.');
  };
  if (!Array.isArray(value) || value.length !== expected || !value.length) return fail();
  const ids = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      !item.id ||
      ids.has(item.id)
    )
      return fail();
    ids.add(item.id);
    if (mode === 'cards') {
      if (
        typeof item.front !== 'string' ||
        !item.front.trim() ||
        typeof item.back !== 'string' ||
        !item.back.trim()
      )
        return fail();
    } else {
      if (
        typeof item.prompt !== 'string' ||
        !item.prompt.trim() ||
        typeof item.citation !== 'string' ||
        !item.citation.trim()
      )
        return fail();
      if (
        mode === 'quiz' &&
        (!Array.isArray(item.options) ||
          item.options.length !== 5 ||
          !Number.isInteger(item.answer) ||
          item.answer < 0 ||
          item.answer > 4)
      )
        return fail();
      if (
        mode === 'essay' &&
        (!Array.isArray(item.keywords) ||
          item.keywords.length !== 4 ||
          !Array.isArray(item.distractors) ||
          item.distractors.length !== 4)
      )
        return fail();
    }
  }
  return ids.size;
}
export async function exclusively(lock: { current: boolean }, action: () => Promise<void>) {
  if (lock.current) return false;
  lock.current = true;
  try {
    await action();
    return true;
  } finally {
    lock.current = false;
  }
}
