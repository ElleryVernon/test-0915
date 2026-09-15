import { openDB, type DBSchema } from 'idb';
import type { Bucket, Card } from './contracts';
import { scheduleCard, type SrsMode } from './srs';
import { clearAiTasks } from './ai-task';

export interface PendingReview {
  reviewId: string;
  cardId: string;
  rating: Exclude<Bucket, 'MASTERED'>;
  userId: string;
  createdAt: number;
  reviewedAt: number;
  mode: SrsMode;
  retention: number;
}
interface StudyDB extends DBSchema {
  cards: { key: string; value: { key: string; userId: string; card: Card } };
  reviews: { key: string; value: PendingReview };
  images: { key: string; value: { key: string; userId: string; data: string } };
}
async function database() {
  return openDB<StudyDB>('memoryz-study-v1', 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('reviews'))
        db.createObjectStore('reviews', { keyPath: 'reviewId' });
      if (!db.objectStoreNames.contains('images'))
        db.createObjectStore('images', { keyPath: 'key' });
    },
  });
}
export async function cachedCards(userId: string) {
  const db = await database();
  const images = new Map(
    (await db.getAll('images'))
      .filter((row) => row.userId === userId)
      .map((row) => [row.key, row.data]),
  );
  return (await db.getAll('cards'))
    .filter((row) => row.userId === userId)
    .map((row) => ({
      ...row.card,
      ...(row.card.image && images.has(`${userId}:${row.card.image}`)
        ? { image: images.get(`${userId}:${row.card.image}`) }
        : {}),
    }));
}
export async function pendingReviews(userId: string) {
  const db = await database();
  return (await db.getAll('reviews'))
    .filter((row) => row.userId === userId)
    .map((row) => ({
      ...row,
      reviewedAt: row.reviewedAt ?? row.createdAt,
      mode: row.mode ?? 'FIXED',
      retention: row.retention ?? 0.9,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}
export async function cacheCards(userId: string, cards: Card[]) {
  const db = await database();
  if (typeof navigator !== 'undefined' && navigator.onLine) {
    await Promise.all(
      cards
        .filter((card) => card.image?.startsWith('/api/') && !card.deleted)
        .map(async (card) => {
          const key = `${userId}:${card.image}`;
          if (await db.get('images', key)) return;
          try {
            const response = await fetch(card.image!, { signal: AbortSignal.timeout(8000) });
            if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return;
            const blob = await response.blob();
            const data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            await db.put('images', { key, userId, data });
          } catch {
            /* A missing image does not block text cards or discard saved reviews. */
          }
        }),
    );
  }
  const tx = db.transaction(['cards', 'reviews'], 'readwrite');
  const pending = (await tx.objectStore('reviews').getAll()).filter(
    (item) => item.userId === userId,
  );
  const store = tx.objectStore('cards');
  const incoming = new Set(cards.map((card) => card.id));
  for (const row of await store.getAll())
    if (
      row.userId === userId &&
      !incoming.has(row.card.id) &&
      !pending.some((p) => p.cardId === row.card.id)
    )
      await store.delete(row.key);
  for (const card of cards) {
    const existing = await store.get(`${userId}:${card.id}`);
    const effective = pending.some((p) => p.cardId === card.id) && existing ? existing.card : card;
    await store.put({ key: `${userId}:${card.id}`, userId, card: effective });
  }
  await tx.done;
}
export async function queueReview(
  userId: string,
  card: Card,
  rating: PendingReview['rating'],
  reviewId = crypto.randomUUID(),
  mode: SrsMode = 'FIXED',
  retention = 0.9,
  reviewedAt?: number,
) {
  const db = await database();
  const tx = db.transaction(['cards', 'reviews'], 'readwrite');
  const existingReview = await tx.objectStore('reviews').get(reviewId);
  const existingCard = await tx.objectStore('cards').get(`${userId}:${card.id}`);
  if (existingReview) {
    if (
      existingReview.userId !== userId ||
      existingReview.cardId !== card.id ||
      existingReview.rating !== rating ||
      (existingReview.mode ?? 'FIXED') !== mode ||
      (existingReview.retention ?? 0.9) !== retention ||
      (reviewedAt !== undefined &&
        (existingReview.reviewedAt ?? existingReview.createdAt) !== reviewedAt)
    )
      throw new Error('복습 기록 식별자가 충돌했어요.');
    await tx.done;
    return existingCard?.card || card;
  }
  const queued = (await tx.objectStore('reviews').getAll()).filter(
    (item) => item.userId === userId,
  );
  const createdAt = Math.max(Date.now(), ...queued.map((item) => item.createdAt + 1));
  const actualTime = reviewedAt ?? Date.now();
  const next = scheduleCard(existingCard?.card || card, rating, mode, retention, actualTime);
  await tx.objectStore('reviews').put({
    userId,
    cardId: card.id,
    rating,
    reviewId,
    createdAt,
    reviewedAt: actualTime,
    mode,
    retention,
  });
  await tx.objectStore('cards').put({ userId, key: `${userId}:${card.id}`, card: next });
  await tx.done;
  return next;
}
const flushing = new Map<string, Promise<number>>();
export async function syncReviews(userId: string, send: (item: PendingReview) => Promise<Card>) {
  const running = flushing.get(userId);
  if (running) return running;
  const task = (async () => {
    const db = await database();
    let synced = 0;
    while (true) {
      const batch = await pendingReviews(userId);
      if (!batch.length) break;
      for (const item of batch) {
        const updated = await send(item);
        const tx = db.transaction(['reviews', 'cards'], 'readwrite');
        await tx.objectStore('reviews').delete(item.reviewId);
        const remaining = (await tx.objectStore('reviews').getAll()).some(
          (r) => r.userId === userId && r.cardId === item.cardId,
        );
        if (!remaining)
          await tx
            .objectStore('cards')
            .put({ userId, key: `${userId}:${item.cardId}`, card: updated });
        await tx.done;
        synced++;
      }
    }
    return synced;
  })();
  flushing.set(userId, task);
  try {
    return await task;
  } finally {
    if (flushing.get(userId) === task) flushing.delete(userId);
  }
}

export async function clearStudyCache(userId: string) {
  await clearAiTasks(userId);
  const db = await database();
  const tx = db.transaction(['cards', 'reviews', 'images'], 'readwrite');
  for (const row of await tx.objectStore('images').getAll())
    if (row.userId === userId) await tx.objectStore('images').delete(row.key);
  for (const row of await tx.objectStore('cards').getAll())
    if (row.userId === userId) await tx.objectStore('cards').delete(row.key);
  for (const row of await tx.objectStore('reviews').getAll())
    if (row.userId === userId) await tx.objectStore('reviews').delete(row.reviewId);
  await tx.done;
}
