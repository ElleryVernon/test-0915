// Timing shapes that keep class-shaped events (the bell, a classroom's Wi-Fi coming back, a deploy,
// a refusal heard by 25 learners at once) from lining devices up (docs/JITTER.md). A person's first
// try is never delayed; only code that sends again without a person, or many people told "try again"
// together, gets a spread. The server says when to come back (Retry-After / retryAfterMs); these
// helpers never retry earlier than that.

/** A number in [0, 1). Injected in tests, Math.random otherwise. */
export type Rand = () => number;

/** Uniform in [lo, hi); hi <= lo gives lo. */
export function between(lo: number, hi: number, rand: Rand = Math.random): number {
  if (!(hi > lo)) return lo;
  const v = lo + rand() * (hi - lo);
  // lo + r·(hi − lo) can round up to hi itself (10000 + 0.99…·10000 is 20000 in doubles).
  return v < hi ? v : Math.max(lo, hi - Math.max(Math.abs(hi), 1) * Number.EPSILON);
}

/** AWS full jitter: uniform in [0, min(capMs, baseMs · 2^attempt)). */
export function fullJitter(attempt: number, baseMs: number, capMs: number, rand: Rand = Math.random): number {
  return between(0, Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt, 0), 30)), rand);
}

/**
 * The wait before an automatic retry: the backoff, but never earlier than the server's hint plus up
 * to one second (which undoes the header's whole-second rounding and keeps hinted devices apart).
 */
export function retryDelay(backoffMs: number, retryAfterMs: number | null | undefined, rand: Rand = Math.random): number {
  return retryAfterMs == null ? backoffMs : Math.max(backoffMs, retryAfterMs + between(0, 1000, rand));
}

/**
 * How long a manual retry control stays disabled after a failure. Drawn once per failure and stored,
 * so a re-render never redraws it: the hint plus up to one second when the server gave one; nothing
 * for a service that is off (a timed retry would only fail again); 10–20 s for a 429 from an older
 * server without a hint; otherwise nothing.
 */
export function cooldown(
  hint: { status?: number | null; retryAfterMs?: number | null; code?: string | null },
  rand: Rand = Math.random,
): number {
  if (hint.retryAfterMs != null) return hint.retryAfterMs + between(0, 1000, rand);
  if (hint.code === 'AI_UNAVAILABLE' || hint.code === 'PROVIDER_OFF') return 0;
  return hint.status === 429 ? between(10_000, 20_000, rand) : 0;
}

/** Waits ms; an abort clears the timer and rejects with the signal's reason. */
// jitter: none — a helper that waits exactly the delay its caller drew; each caller carries its own marker
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason || new DOMException('작업 확인을 중단했어요.', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    // jitter: none — the timer behind sleep(): the caller's delay, unchanged
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    function cancel() {
      clearTimeout(timer);
      reject(signal?.reason || new DOMException('작업 확인을 중단했어요.', 'AbortError'));
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
