import { useEffect, useState } from 'react';
import { ApiError } from './api';
import { cooldown, type Rand } from './jitter';

/** Whole seconds until retryAt (0 when it has passed or there is none). */
export function secondsLeft(retryAt: number | null | undefined, now = Date.now()): number {
  return retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
}

/**
 * When a failed action may be tried again by hand: now + cooldown(the refusal), drawn once. Null
 * when the failure carries no wait (most errors) or is not an API refusal.
 */
export function retryAtOf(error: unknown, rand?: Rand, now = Date.now()): number | null {
  const task = (error as { task?: { retryAt?: number } } | null)?.task;
  if (task?.retryAt) return task.retryAt;
  if (!(error instanceof ApiError)) return null;
  const wait = cooldown(error, rand);
  return wait > 0 ? now + wait : null;
}

/**
 * Seconds left until the latest of retryAts, ticking once a second. Retry buttons stay disabled and
 * show the count while it is above zero, so learners told "try again" together come back spread out.
 */
export function useRetryCountdown(...retryAts: (number | null | undefined)[]): number {
  const retryAt = Math.max(0, ...retryAts.map((at) => at ?? 0)) || null;
  const [left, setLeft] = useState(() => secondsLeft(retryAt));
  useEffect(() => {
    setLeft(secondsLeft(retryAt));
    if (!retryAt || retryAt <= Date.now()) return;
    // jitter: none — a display tick for one learner's own countdown; it sends nothing
    const timer = setInterval(() => {
      const next = secondsLeft(retryAt);
      setLeft(next);
      if (!next) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  return left;
}

/**
 * The longest wait an OAuth start refusal can carry: the 60 s sign-in window plus its 15 s spread,
 * with margin. The wait arrives in the URL (loginError=busy&retryAfter=<s>), which anyone can craft.
 */
export const LOGIN_BUSY_MAX_SECONDS = 90;

/** When the sign-in buttons may be used again after a refused OAuth start (digits only, clamped). */
export function loginBusyRetryAt(raw: string | null, rand?: Rand, now = Date.now()): number {
  const seconds = raw && /^\d+$/.test(raw) ? Math.min(Number(raw), LOGIN_BUSY_MAX_SECONDS) : 0;
  return now + cooldown({ retryAfterMs: seconds > 0 ? seconds * 1000 : null, status: 429 }, rand);
}

/** A retry button's label while it waits: "12초 후 다시 만들기". */
export const waitingLabel = (label: string, left: number) => (left > 0 ? `${left}초 후 ${label}` : label);
