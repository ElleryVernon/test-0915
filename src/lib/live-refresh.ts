export function refreshPolicy(path: string) {
  const [base, search] = path.split('?');
  const params = new URLSearchParams(search);
  const conversation =
    ['/messages', '/community', '/parent-boards'].includes(base) && !!params.get('peer');
  const pull =
    !conversation &&
    ([
      '/',
      '/study',
      '/wrong-notes',
      '/planner',
      '/community',
      '/boards',
      '/parent-boards',
      '/parent',
      '/notifications',
      '/profile',
      '/community/me',
      '/parent-boards/me',
      '/community/profile',
      '/messages',
      '/followers',
      '/following',
      '/search',
    ].includes(base) ||
      base.startsWith('/subjects/'));
  // Bootstrap owns these screens. Locally fetched community resources register their own reads.
  const bootstrap = ['/', '/parent', '/notifications', '/planner', '/study'].includes(base);
  return { pull, bootstrapInterval: bootstrap ? (base === '/notifications' ? 15_000 : 30_000) : 0 };
}

export const PULL_THRESHOLD = 64;
export function pullDistance(dx: number, dy: number) {
  if (dy < 0 || Math.abs(dx) > Math.max(12, dy * 0.8)) return -1;
  return Math.min(88, dy * 0.5);
}

type Clock = {
  now: () => number;
  set: (fn: () => void, delay: number) => unknown;
  clear: (id: unknown) => void;
};
const clock: Clock = {
  now: Date.now,
  set: (fn, delay) => setTimeout(fn, delay),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Read-only refreshes: one request at a time, no hidden/offline requests, bounded failure backoff. */
export class RefreshLoop {
  private timer: unknown;
  private pending: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private stopped = false;
  private failures = 0;
  private notBefore = 0;
  private automaticNotBefore = 0;
  private lastStart = -Infinity;
  private refused = false;
  private clock: Clock;
  constructor(
    private task: (signal: AbortSignal) => Promise<unknown>,
    private options: {
      interval: number;
      available: () => boolean;
      online: () => boolean;
      clock?: Clock;
      random?: () => number;
    },
  ) {
    this.clock = options.clock || clock;
  }
  start(immediate = true) {
    if (immediate) void this.run().catch(() => {});
    else this.schedule(this.options.interval);
  }
  private schedule(delay: number) {
    this.clock.clear(this.timer);
    if (!this.stopped && !this.refused)
      this.timer = this.clock.set(() => {
        void this.run().catch(() => {});
      }, delay);
  }
  wake() {
    if (this.clock.now() - this.lastStart >= 1500) void this.run().catch(() => {});
  }
  run(manual = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    const now = this.clock.now();
    if (!this.options.online()) {
      this.schedule(this.options.interval);
      return manual ? Promise.reject(new Error('인터넷 연결을 확인해 주세요.')) : Promise.resolve();
    }
    const deadline = manual ? this.notBefore : Math.max(this.notBefore, this.automaticNotBefore);
    if (now < deadline) {
      this.schedule(deadline - now);
      return manual
        ? Promise.reject(new Error('잠시 후 다시 확인해 주세요. 자동으로 다시 연결할게요.'))
        : Promise.resolve();
    }
    if (!manual && (!this.options.available() || this.refused)) {
      this.schedule(this.options.interval);
      return Promise.resolve();
    }
    this.clock.clear(this.timer);
    this.lastStart = now;
    this.abort = new AbortController();
    let delay = this.options.interval;
    this.pending = Promise.resolve()
      .then(() => this.task(this.abort!.signal))
      .then(() => {
        this.failures = 0;
        this.notBefore = 0;
        this.automaticNotBefore = 0;
        this.refused = false;
      })
      .catch((error) => {
        if (this.stopped) return;
        const status = (error as { status?: number }).status;
        this.refused = !!status && status >= 400 && status < 500 && ![408, 429].includes(status);
        const retryAfter = Number((error as { retryAfterMs?: number }).retryAfterMs) || 0;
        delay = Math.max(
          retryAfter,
          Math.min(60_000, this.options.interval * 2 ** Math.min(++this.failures, 4)),
        );
        this.notBefore = this.clock.now() + retryAfter;
        this.automaticNotBefore = this.clock.now() + delay;
        throw error;
      })
      .finally(() => {
        this.pending = null;
        // Jitter spreads background reads; explicit user refresh remains immediate.
        this.schedule(delay * (1 + (this.options.random || Math.random)() * 0.15));
      });
    return this.pending;
  }
  stop() {
    this.stopped = true;
    this.clock.clear(this.timer);
    this.abort?.abort();
  }
}
