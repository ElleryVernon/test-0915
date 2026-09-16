/** One session boundary for JSON, uploads, documents and background study requests. */
export const SESSION_ENDED_KEY = 'memoryz.session-ended';
export class SessionEndedError extends Error {
  readonly status = 401;
  constructor() {
    super('세션이 만료됐어요. 다시 로그인해 주세요.');
  }
}
export function createSessionBoundary() {
  let revision = 0;
  let ended = false;
  const listeners = new Set<() => void>();
  return {
    revision: () => revision,
    current: (value: number) => !ended && value === revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    end() {
      if (ended || !listeners.size) return;
      ended = true;
      revision++;
      for (const listener of listeners) listener();
    },
    begin() {
      ended = false;
      revision++;
    },
  };
}
export const sessionBoundary = createSessionBoundary();
export function hasEndedSession() {
  try {
    return !!localStorage.getItem(SESSION_ENDED_KEY);
  } catch {
    return false;
  }
}
export function markSessionEnded() {
  try {
    localStorage.setItem(SESSION_ENDED_KEY, `${Date.now()}:${Math.random()}`);
  } catch {
    /* memory boundary still works */
  }
}
export function beginSession() {
  sessionBoundary.begin();
  try {
    localStorage.removeItem(SESSION_ENDED_KEY);
  } catch {
    /* storage can be unavailable */
  }
}
export function isSessionRequest(input: RequestInfo | URL) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin;
  const url = new URL(raw, origin);
  return (
    url.origin === origin &&
    url.pathname.startsWith('/api/') &&
    !/^\/api\/(session|logout|schools|auth)(\/|$)/.test(url.pathname)
  );
}
export async function sessionFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const protectedRequest = isSessionRequest(input);
  const revision = sessionBoundary.revision();
  if (protectedRequest && !sessionBoundary.current(revision)) throw new SessionEndedError();
  const response = await fetch(input, init);
  if (protectedRequest && !sessionBoundary.current(revision)) throw new SessionEndedError();
  if (protectedRequest && response.status === 401) sessionBoundary.end();
  return response;
}
