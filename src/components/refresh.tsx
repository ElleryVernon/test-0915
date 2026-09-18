'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowDown, Check, LoaderCircle } from './icons';
import { PULL_THRESHOLD, pullDistance, RefreshLoop } from '@/lib/live-refresh';
import { isTextField } from '@/lib/keyboard-inset';
import styles from './refresh.module.css';

type Read = (signal?: AbortSignal) => Promise<unknown>;
const RefreshContext = createContext<{ register: (read: Read) => () => void } | null>(null);

export function useScreenRefresh(read: Read, enabled = true) {
  const context = useContext(RefreshContext);
  const latest = useRef(read);
  latest.current = read;
  useEffect(
    () => (enabled ? context?.register((signal) => latest.current(signal)) : undefined),
    [context, enabled],
  );
}

export function useLiveRefresh(
  read: Read,
  {
    interval,
    enabled = true,
    immediate = false,
    pauseOnInput = false,
    resource = '',
  }: {
    interval: number;
    enabled?: boolean;
    immediate?: boolean;
    pauseOnInput?: boolean;
    resource?: string;
  },
) {
  const latest = useRef(read);
  latest.current = read;
  const loop = useRef<RefreshLoop | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const current = new RefreshLoop((signal) => latest.current(signal), {
      interval,
      online: () => navigator.onLine,
      available: () =>
        document.visibilityState === 'visible' &&
        !document.querySelector('[role="dialog"]') &&
        (!pauseOnInput ||
          !document.activeElement?.matches('input,textarea,[contenteditable="true"]')),
    });
    loop.current = current;
    const wake = () => current.wake();
    current.start(immediate);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      current.stop();
      if (loop.current === current) loop.current = null;
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [enabled, interval, immediate, pauseOnInput, resource]);
  return useCallback(async () => {
    if (loop.current) await loop.current.run(true);
    else await latest.current();
  }, []);
}

/** A gesture refreshes screen data, never the document or its saved editing state. */
export function RefreshBoundary({
  children,
  fallback,
  enabled,
  scope,
}: {
  children: ReactNode;
  fallback: Read;
  enabled: boolean;
  scope: string;
}) {
  const reads = useRef(new Set<Read>());
  const root = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const pending = useRef<Promise<void> | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [distance, setDistance] = useState(0);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const context = useMemo(
    () => ({
      register: (read: Read) => {
        reads.current.add(read);
        return () => {
          reads.current.delete(read);
        };
      },
    }),
    [],
  );
  useEffect(() => {
    generation.current++;
    pending.current = null;
    setDistance(0);
    setStatus('idle');
    return () => {
      generation.current++;
      controller.current?.abort();
      clearTimeout(reset.current);
    };
  }, [scope]);
  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const version = generation.current;
    clearTimeout(reset.current);
    setDistance(0);
    setStatus('loading');
    const abort = new AbortController();
    controller.current = abort;
    const jobs = [...reads.current];
    pending.current = Promise.resolve()
      .then(async () => {
        if (!navigator.onLine) throw new Error('인터넷 연결을 확인해 주세요.');
        const results = await Promise.allSettled(
          (jobs.length ? jobs : [fallbackRef.current]).map((read) => read(abort.signal)),
        );
        const failed = results.find((r) => r.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        if (version !== generation.current) return;
        setStatus('done');
        reset.current = setTimeout(() => setStatus('idle'), 1400);
      })
      .catch((e) => {
        if (version !== generation.current) return;
        setError((e as Error).message || '연결을 확인하고 다시 시도해 주세요.');
        setStatus('error');
      })
      .finally(() => {
        if (version === generation.current) pending.current = null;
      });
    return pending.current;
  }, []);
  useEffect(() => {
    // Keep the browser's document reload gesture off in protected study/editing flows too.
    const html = document.documentElement;
    html.classList.add('app-pull-refresh');
    return () => html.classList.remove('app-pull-refresh');
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    let pulled = 0;
    const typing = () =>
      document.documentElement.dataset.keyboard === 'open' ||
      isTextField(document.activeElement) ||
      (window.visualViewport?.offsetTop ?? 0) > 1 ||
      Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.01;
    const begin = (x: number, y: number, target: EventTarget | null) => {
      start = null;
      if (
        pending.current ||
        typing() ||
        window.scrollY > 1 ||
        !(target instanceof Element) ||
        !root.current?.contains(target) ||
        document.querySelector('[role="dialog"]') ||
        target.closest(
          'button,a,input,textarea,select,[contenteditable="true"],[role="slider"],[data-no-refresh]',
        )
      )
        return;
      for (let n = target; n && n !== root.current; n = n.parentElement!) {
        if (
          /(auto|scroll)/.test(getComputedStyle(n).overflowY) &&
          n.scrollHeight > n.clientHeight + 1
        )
          return;
      }
      start = { x, y };
      pulled = 0;
      clearTimeout(reset.current);
      setStatus('idle');
    };
    const move = (x: number, y: number, event: Event) => {
      if (!start) return;
      if (typing()) {
        start = null;
        pulled = 0;
        setDistance(0);
        return;
      }
      const value = pullDistance(x - start.x, y - start.y);
      if (value < 0 || window.scrollY > 1) {
        start = null;
        setDistance(0);
        return;
      }
      if (value < 5) return;
      if (event.cancelable) event.preventDefault();
      pulled = value;
      setDistance(value);
    };
    const end = (cancel = false) => {
      if (!start) return;
      start = null;
      setDistance(0);
      if (!cancel && pulled >= PULL_THRESHOLD) void refresh();
      pulled = 0;
    };
    const touchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) begin(e.touches[0].clientX, e.touches[0].clientY, e.target);
      else end(true);
    };
    const touchMove = (e: TouchEvent) => {
      if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY, e);
      else end(true);
    };
    const finish = () => end();
    const cancel = () => end(true);
    // Mouse/pen may pull the top header; normal body text selection stays native.
    const pointerStart = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' && e.button === 0 && e.clientY <= 120)
        begin(e.clientX, e.clientY, e.target);
    };
    const pointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') move(e.clientX, e.clientY, e);
    };
    const pointerEnd = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') end();
    };
    document.addEventListener('touchstart', touchStart, { passive: true });
    document.addEventListener('touchmove', touchMove, { passive: false });
    document.addEventListener('touchend', finish);
    document.addEventListener('touchcancel', cancel);
    document.addEventListener('pointerdown', pointerStart);
    document.addEventListener('pointermove', pointerMove);
    document.addEventListener('pointerup', pointerEnd);
    document.addEventListener('pointercancel', cancel);
    return () => {
      document.removeEventListener('touchstart', touchStart);
      document.removeEventListener('touchmove', touchMove);
      document.removeEventListener('touchend', finish);
      document.removeEventListener('touchcancel', cancel);
      document.removeEventListener('pointerdown', pointerStart);
      document.removeEventListener('pointermove', pointerMove);
      document.removeEventListener('pointerup', pointerEnd);
      document.removeEventListener('pointercancel', cancel);
    };
  }, [enabled, scope, refresh]);
  const label =
    status === 'loading'
      ? '새 소식 확인 중'
      : status === 'done'
        ? '최신 상태예요'
        : distance >= PULL_THRESHOLD
          ? '놓으면 새로고침'
          : '아래로 당겨 새로고침';
  return (
    <RefreshContext.Provider value={context}>
      <div ref={root} className={styles.root} data-refresh-enabled={enabled}>
        {enabled && (
          <button
            className={styles.keyboard}
            onClick={() => void refresh()}
            aria-disabled={status === 'loading'}
            aria-busy={status === 'loading'}
          >
            이 화면 새로고침
          </button>
        )}
        {enabled && (distance > 0 || status !== 'idle') && (
          <div
            className={styles.indicator}
            style={{ translate: `-50% ${Math.max(8, distance / 2)}px` }}
          >
            {status === 'error' ? (
              <>
                <span role="alert">{error}</span>
                <button onClick={() => void refresh()}>다시 시도</button>
                <button onClick={() => setStatus('idle')}>닫기</button>
              </>
            ) : (
              <span role="status">
                {status === 'loading' ? (
                  <LoaderCircle size={17} className={styles.spinner} />
                ) : status === 'done' ? (
                  <Check size={17} />
                ) : (
                  <ArrowDown
                    size={17}
                    style={{ rotate: distance >= PULL_THRESHOLD ? '180deg' : undefined }}
                  />
                )}
                {label}
              </span>
            )}
          </div>
        )}
        {children}
      </div>
    </RefreshContext.Provider>
  );
}
