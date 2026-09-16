import { sessionFetch } from '@/lib/session-boundary';
import { openDB, type DBSchema } from 'idb';
import type { Bucket, Card } from './contracts';
import { scheduleCard, type SrsMode } from './srs';
import { clearAiTasks } from './ai-task';
import { retryAfterMsOf, transient } from './api';
import { between, fullJitter, retryDelay, type Rand } from './jitter';

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
            // jitter: none — one fetch per uncached image per device when cards load (screen open, or the refresh after a sync started over U[0,10 s)); no retry timer [site src/lib/offline.ts:70]
            const response = await sessionFetch(card.image!, { signal: AbortSignal.timeout(8000) });
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

// The per-device review sync scheduler. syncReviews above is serial, one drain in flight per user,
// and idempotent by reviewId; this decides when to call it without a person asking. A classroom's
// Wi-Fi coming back fires 'online' on up to 50 devices within about 3 s, so that drain starts at a
// point drawn over a 10 s window (5 starts a second, the rate of the bell, which the server's pool
// already absorbs). A transient failure retries with full jitter from 2 s up to 60 s, never earlier
// than the server's Retry-After, for as long as reviews are pending and the device is online; a
// refusal that cannot pass by itself (400/404/409) stops the loop and is shown instead.
interface SyncState {
  timer: ReturnType<typeof setTimeout> | null;
  dueAt: number;
  attempt: number;
  /** The attempt in flight: callers that join it share its one outcome (one failure counts once). */
  inflight: Promise<void> | null;
}
interface SyncOptions {
  onError?: (error: unknown) => void;
  rand?: Rand;
}
const syncBackoff = { baseMs: 2_000, capMs: 60_000 };
const scheduled = new Map<string, SyncState>();
function syncState(userId: string) {
  let state = scheduled.get(userId);
  if (!state) scheduled.set(userId, (state = { timer: null, dueAt: 0, attempt: 0, inflight: null }));
  return state;
}
/** Whether state is still the scheduler for userId (cancelSync drops it; a new mount makes another). */
const current = (userId: string, state: SyncState) => scheduled.get(userId) === state;
function armSync(state: SyncState, userId: string, run: () => Promise<unknown>, o: SyncOptions, delay: number) {
  if (!current(userId, state)) return;
  if (state.timer) clearTimeout(state.timer);
  state.dueAt = Date.now() + delay;
  // jitter: window U[0, windowMs) from syncSoon, or full-jitter backoff from attemptSync: this timer runs the delay its caller drew
  state.timer = setTimeout(() => {
    state.timer = null;
    void (async () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const pending = (await pendingReviews(userId)).length;
      if (!current(userId, state)) return; // cancelled while the queue was read
      if (!pending) {
        state.attempt = 0;
        return;
      }
      await attemptSync(state, userId, run, o);
    })();
  }, delay);
}
async function attemptSync(state: SyncState, userId: string, run: () => Promise<unknown>, o: SyncOptions): Promise<void> {
  if (state.inflight) return state.inflight;
  let settle!: () => void;
  state.inflight = new Promise<void>((resolve) => (settle = resolve));
  try {
    await run();
    state.attempt = 0;
  } catch (error) {
    // cancelSync ran while this attempt was in flight: the screen is gone, so is the retry.
    if (!current(userId, state)) return;
    o.onError?.(error);
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    if (!transient(error) || !online) {
      state.attempt = 0;
      return;
    }
    state.attempt += 1;
    // jitter: backoff full jitter U[0, min(60 s, 2 s·2^k)), never before Retry-After + U[0,1 s), while pending and online [site src/lib/offline.ts:154]
    armSync(state, userId, run, o, retryDelay(fullJitter(state.attempt, syncBackoff.baseMs, syncBackoff.capMs, o.rand), retryAfterMsOf(error), o.rand));
  } finally {
    state.inflight = null;
    settle();
  }
}
/** Starts a drain at a point drawn over windowMs, unless one is already due sooner. */
export function syncSoon(userId: string, run: () => Promise<unknown>, o: SyncOptions & { windowMs: number }) {
  const delay = between(0, o.windowMs, o.rand);
  const state = syncState(userId);
  if (state.timer && state.dueAt <= Date.now() + delay) return;
  armSync(state, userId, run, o, delay);
}
/** Drains now (a person rated a card or asked): any pending timer is cleared first; a drain already
 * in flight is joined (syncReviews re-reads the queue, so a review queued meanwhile is sent too). */
export async function syncNow(userId: string, run: () => Promise<unknown>, o: SyncOptions = {}) {
  const state = syncState(userId);
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  await attemptSync(state, userId, run, o);
}
/** Stops the scheduler for userId (offline, sign-out, unmount); an attempt in flight then ends quietly. */
export function cancelSync(userId: string) {
  const state = scheduled.get(userId);
  if (state?.timer) clearTimeout(state.timer);
  scheduled.delete(userId);
}

export async function clearStudyCache(userId: string, preservePending = false) {
  if (!preservePending) await clearAiTasks(userId);
  const db = await database();
  const tx = db.transaction(['cards', 'reviews', 'images'], 'readwrite');
  for (const row of await tx.objectStore('images').getAll())
    if (row.userId === userId) await tx.objectStore('images').delete(row.key);
  for (const row of await tx.objectStore('cards').getAll())
    if (row.userId === userId) await tx.objectStore('cards').delete(row.key);
  for (const row of await tx.objectStore('reviews').getAll())
    if (!preservePending && row.userId === userId) await tx.objectStore('reviews').delete(row.reviewId);
  await tx.done;
}
