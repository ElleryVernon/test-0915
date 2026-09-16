import { sessionFetch } from '@/lib/session-boundary';
import { fullJitter, retryDelay, sleep, type Rand } from './jitter';

/**
 * An API refusal with what the client needs to decide what to do next: the status, the server's
 * machine code, and when the server said to come back (null when it did not say). The message is
 * the server's, unchanged, so callers that match on it keep working.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const DAY_MS = 86_400_000;

/**
 * The server's wait, in ms: the body's millisecond value wins over the whole-second header (delta
 * seconds or an HTTP date); clamped to [0, 24 h]; null when neither says.
 */
export function parseRetryAfter(header: string | null, bodyMs: unknown, now = Date.now()): number | null {
  let ms: number | null = null;
  if (typeof bodyMs === 'number' && Number.isFinite(bodyMs) && bodyMs >= 0) ms = bodyMs;
  else if (header && /^\d+$/.test(header.trim())) ms = Number(header.trim()) * 1000;
  else if (header) {
    const at = Date.parse(header);
    if (Number.isFinite(at) && at - now >= 0) ms = at - now;
  }
  return ms == null ? null : Math.min(Math.max(ms, 0), DAY_MS);
}

/** Builds the ApiError for a failed response whose JSON body (if any) is result. */
export function apiErrorOf(response: Response, result: { error?: unknown; code?: unknown; retryAfterMs?: unknown }, fallback: string) {
  return new ApiError(
    typeof result.error === 'string' && result.error ? result.error : fallback,
    response.status,
    typeof result.code === 'string' ? result.code : null,
    parseRetryAfter(response.headers.get('Retry-After'), result.retryAfterMs),
  );
}

/** A failure that may pass by itself: no connection, a timeout, 408, 429 or any 5xx. */
export function transient(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  return error instanceof ApiError && (error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599));
}

/** The server's wait carried by error, if it is an ApiError that has one. */
export function retryAfterMsOf(error: unknown): number | null {
  return error instanceof ApiError ? error.retryAfterMs : null;
}

/**
 * Runs an idempotent request again after transient failures: retry k waits
 * retryDelay(fullJitter(k, baseMs, capMs), Retry-After). A client timeout is not retried (no server
 * answered within it, and each retry would add another full timeout), and nothing is retried offline.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  o: { retries: number; baseMs: number; capMs: number; rand?: Rand; signal?: AbortSignal },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      if (attempt > o.retries || !transient(error) || (error as Error).name === 'TimeoutError' || !online) throw error;
      // jitter: backoff full jitter U[0, min(capMs, baseMs·2^k)), never before Retry-After + U[0,1 s); no retry after a client timeout or offline
      await sleep(retryDelay(fullJitter(attempt, o.baseMs, o.capMs, o.rand), retryAfterMsOf(error), o.rand), o.signal);
    }
  }
}

export async function api<T = unknown>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await sessionFetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    // jitter: none — each 20 s / 150 s timeout starts with its own request, which people already spread; api() never re-sends on a timeout [site src/lib/api.ts:4]
    signal: AbortSignal.timeout(path === '/bootstrap' || path.startsWith('/quiz/') ? 20000 : 150000),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response
    .json()
    .catch(() => ({ error: '응답을 읽을 수 없어요. 다시 시도해 주세요.' }));
  // api() itself never retries: the caller knows whether the request is idempotent.
  // jitter: retry-after carrier: ApiError keeps status, code and retryAfterMs (body ms over the Retry-After header, clamped to [0, 24 h]) [site src/lib/api.ts:1]
  if (!response.ok) throw apiErrorOf(response, result, '요청을 처리하지 못했어요.');
  return result.data as T;
}
