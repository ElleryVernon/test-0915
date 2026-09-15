import { openDB, type DBSchema } from 'idb';
import { ApiError, apiErrorOf, retryAfterMsOf, transient } from './api';
import { between, cooldown, fullJitter, retryDelay, sleep, type Rand } from './jitter';

/** How long one AI request is awaited on the client before it is left to be checked later. */
// jitter: none — reaching it only shows 'pending' (status GETs time out at 20 s); a later tap reads the status first [site src/lib/ai-task.ts:4]
export const AI_CLIENT_DEADLINE_MS = 190_000;

export type AiEndpoint = '/generate' | '/essay/submit' | '/planner/suggest';
export type AiTaskStatus = 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
export interface AiTaskStep {
  stage: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}
export interface AiTaskRecord<T = unknown> {
  key: string;
  userId: string;
  endpoint: AiEndpoint;
  payload: Record<string, unknown>;
  requestId: string;
  status: AiTaskStatus;
  result: T | null;
  error: string | null;
  acknowledged: boolean;
  /** First time the result was shown to the learner; a seen result never reopens by itself. */
  seenAt?: number;
  createdAt: number;
  updatedAt: number;
  steps?: AiTaskStep[];
  /** The failure's HTTP status and machine code, when the server gave them. */
  errorStatus?: number | null;
  errorCode?: string | null;
  /** Before this time a manual retry does not send (drawn once per failure, never redrawn). */
  retryAt?: number;
  /** The server never recorded this request id, so a retry may send the same id again. */
  unclaimed?: boolean;
}
export interface AiTaskLookup {
  userId: string;
  endpoint: AiEndpoint;
  payload?: Record<string, unknown>;
  match?: Record<string, unknown>;
}
export interface AiTaskOptions extends AiTaskLookup {
  payload: Record<string, unknown>;
  retryFailed?: boolean;
  onStatus?: (task: AiTaskRecord) => void;
  signal?: AbortSignal;
  /** The jitter source (tests pin it). */
  rand?: Rand;
}
interface TaskDB extends DBSchema {
  tasks: { key: string; value: AiTaskRecord };
}
interface RemoteTask {
  requestId: string;
  status: Exclude<AiTaskStatus, 'READY'>;
  result: unknown;
  error: string | null;
  steps?: AiTaskStep[];
  updatedAt: string;
  errorStatus?: number | null;
  retryAfterMs?: number;
}
export class AiTaskPendingError extends Error {
  constructor(
    public task: AiTaskRecord,
    message = '작업 완료 여부를 확인하지 못했어요. 같은 요청을 이어서 확인할 수 있어요.',
  ) {
    super(message);
    this.name = 'AiTaskPendingError';
  }
}
export class AiTaskFailureError extends Error {
  constructor(public task: AiTaskRecord) {
    super(task.error || '작업을 완료하지 못했어요. 다시 시도하면 새로 요청해요.');
    this.name = 'AiTaskFailureError';
  }
}
const inflight = new Map<string, Promise<unknown>>();
async function database() {
  return openDB<TaskDB>('memoryz-ai-tasks-v1', 1, {
    upgrade(db) {
      db.createObjectStore('tasks', { keyPath: 'key' });
    },
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
async function taskKey(userId: string, endpoint: AiEndpoint, payload: Record<string, unknown>) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(payload)));
  return `${userId}:${endpoint}:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
async function saveTask<T>(task: AiTaskRecord<T>) {
  const db = await database();
  // Status updates often start from an older in-memory copy; the same request keeps its seen time.
  const stored = task.seenAt ? undefined : await db.get('tasks', task.key);
  const next =
    stored?.seenAt && stored.requestId === task.requestId
      ? { ...task, seenAt: stored.seenAt }
      : task;
  await db.put('tasks', next);
  return next;
}
async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(body === undefined ? 20000 : AI_CLIENT_DEADLINE_MS);
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response
    .json()
    .catch(() => ({ error: '작업 응답을 읽지 못했어요. 저장된 결과를 다시 확인해 주세요.' }));
  if (!response.ok) throw apiErrorOf(response, result, '작업 상태를 확인하지 못했어요.');
  if (!Object.hasOwn(result, 'data'))
    throw new Error('작업 응답을 읽지 못했어요. 저장된 결과를 다시 확인해 주세요.');
  return result.data;
}
export async function findAiTask<T = unknown>(
  lookup: AiTaskLookup,
): Promise<AiTaskRecord<T> | null> {
  const db = await database();
  if (lookup.payload) {
    const task = await db.get(
      'tasks',
      await taskKey(lookup.userId, lookup.endpoint, lookup.payload),
    );
    return task && !task.acknowledged ? (task as AiTaskRecord<T>) : null;
  }
  return (await listAiTasks<T>(lookup))[0] ?? null;
}
/** Unacknowledged tasks for one user and endpoint, newest first. */
export async function listAiTasks<T = unknown>(lookup: AiTaskLookup): Promise<AiTaskRecord<T>[]> {
  const db = await database();
  return (await db.getAll('tasks'))
    .filter(
      (task) =>
        task.userId === lookup.userId &&
        task.endpoint === lookup.endpoint &&
        !task.acknowledged &&
        (!lookup.match ||
          Object.entries(lookup.match).every(
            ([key, value]) => canonical(task.payload[key]) === canonical(value),
          )),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt) as AiTaskRecord<T>[];
}
/** Records the first time a result was shown; later calls keep the original time. */
export async function markAiTaskSeen(lookup: AiTaskLookup & { payload: Record<string, unknown> }) {
  const task = await findAiTask(lookup);
  if (!task || task.seenAt) return task;
  return saveTask({ ...task, seenAt: Date.now() });
}
/** Reads status only. This function never starts or retries a paid request. */
export async function inspectAiTask<T = unknown>(
  task: AiTaskRecord<T>,
  signal?: AbortSignal,
  rand?: Rand,
): Promise<AiTaskRecord<T> | null> {
  try {
    const remote = (await request(
      `/ai-runs/${encodeURIComponent(task.requestId)}`,
      undefined,
      signal,
    )) as RemoteTask;
    if (
      remote.requestId !== task.requestId ||
      !['RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED'].includes(remote.status)
    )
      throw new Error('작업 상태 응답을 확인하지 못했어요.');
    // A recorded failure that says when to retry (interrupted at a deploy, refused by the provider)
    // sets the manual retry's time once for this request id; later reads never redraw it.
    const retryAt =
      task.retryAt ?? (remote.retryAfterMs != null ? Date.now() + cooldown({ retryAfterMs: remote.retryAfterMs }, rand) : undefined);
    return saveTask({
      ...task,
      status: remote.status,
      result: remote.result as T | null,
      error: remote.error,
      errorStatus: remote.errorStatus ?? null,
      steps: remote.steps,
      retryAt,
      updatedAt: Date.parse(remote.updatedAt) || Date.now(),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
export async function acknowledgeAiTask(
  lookup: AiTaskLookup & { payload: Record<string, unknown> },
) {
  const task = await findAiTask(lookup);
  if (task?.status === 'COMPLETED')
    await saveTask({ ...task, acknowledged: true, updatedAt: Date.now() });
}
export async function clearAiTasks(userId: string) {
  const db = await database();
  const tx = db.transaction('tasks', 'readwrite');
  for (const task of await tx.store.getAll())
    if (task.userId === userId) await tx.store.delete(task.key);
  await tx.done;
}
function aborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason || new DOMException('작업 확인을 중단했어요.', 'AbortError');
}
// Status polling. The steady wait is 2.5 s ± 25 %, so 25 loops woken together (a restart, a
// classroom's Wi-Fi coming back) drift apart within a few polls instead of reading in lockstep.
// After k reads in a row fail, the wait is 2.5 s plus full jitter up to 7.5 s (never faster than
// the steady rate, and a completion is still seen at most 10 s late), and never before the server's
// Retry-After. The paid POST itself is never sent again by this loop.
const POLL_MS = 2500;
const pollWait = (rand?: Rand) => between(POLL_MS * 0.75, POLL_MS * 1.25, rand);
const failedReadWait = (k: number, retryAfterMs: number | null, rand?: Rand) =>
  retryDelay(POLL_MS + fullJitter(k - 1, POLL_MS, 7500, rand), retryAfterMs, rand);
/** No server answered (a network error or a client timeout), or one answered 5xx. */
const serverDown = (error: unknown) =>
  transient(error) && !(error instanceof ApiError && error.status < 500);
/** Called from an explicit user action. Retrying a running task only polls its GET status. */
export async function runAiTask<T = unknown>(options: AiTaskOptions): Promise<T> {
  const key = await taskKey(options.userId, options.endpoint, options.payload);
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const taskPromise = execute<T>(key, options);
  inflight.set(key, taskPromise);
  try {
    return await taskPromise;
  } finally {
    if (inflight.get(key) === taskPromise) inflight.delete(key);
  }
}
async function execute<T>(key: string, options: AiTaskOptions): Promise<T> {
  const { userId, endpoint, payload, signal, onStatus } = options;
  const db = await database();
  let task = (await db.get('tasks', key)) as AiTaskRecord<T> | undefined;
  if (task?.acknowledged) task = undefined;
  let existsRemotely = false;
  if (task) {
    if (task.status === 'COMPLETED') {
      onStatus?.(task);
      return task.result as T;
    }
    let known: AiTaskRecord<T> | null;
    try {
      known = await inspectAiTask(task, signal, options.rand);
    } catch (error) {
      aborted(signal);
      onStatus?.(task);
      throw new AiTaskPendingError(
        task,
        '이전 작업의 상태를 확인하지 못했어요. 연결을 확인하고 다시 조회해 주세요.',
      );
    }
    if (known) {
      task = known;
      existsRemotely = true;
    }
    if (task.status === 'COMPLETED') {
      onStatus?.(task);
      return task.result as T;
    }
    if (task.status === 'FAILED' || task.status === 'INTERRUPTED') {
      // A manual retry waits out the failure's cooldown (the button counts it down), so learners
      // told "try again" together do not all send in the same second.
      if (!options.retryFailed || (task.retryAt ?? 0) > Date.now()) {
        onStatus?.(task);
        throw new AiTaskFailureError(task);
      }
      if (task.unclaimed && !existsRemotely) {
        // Never recorded by the server: the same request id is sent again and still runs at most once.
        task = await saveTask<T>({ ...task, status: 'READY', error: null, errorStatus: null, errorCode: null, retryAt: undefined, unclaimed: false, updatedAt: Date.now() });
      } else {
        task = undefined;
        existsRemotely = false;
      }
    }
  }
  if (!task)
    task = await saveTask<T>({
      key,
      userId,
      endpoint,
      payload,
      requestId: crypto.randomUUID(),
      status: 'READY',
      result: null,
      error: null,
      acknowledged: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  aborted(signal);
  let active: AiTaskRecord<T> = task;
  let postResult: { data: T } | { error: unknown } | { accepted: true } | undefined;
  let posting: Promise<void> | undefined;
  if (!existsRemotely) {
    active = await saveTask({ ...active, status: 'RUNNING', error: null, updatedAt: Date.now() });
    onStatus?.(active);
    posting = request(endpoint, { ...payload, requestId: active.requestId }, signal).then(
      (data) => {
        postResult =
          data &&
          typeof data === 'object' &&
          data.requestId === active.requestId &&
          data.status === 'RUNNING'
            ? { accepted: true }
            : { data: data as T };
      },
      (error) => {
        postResult = { error };
      },
    );
  } else onStatus?.(active);
  // Outlasts the server's 180-second AI deadline, so the final status is seen rather than guessed.
  const deadline = Date.now() + AI_CLIENT_DEADLINE_MS;
  // The run's record is created inside the POST; a status read fired in the same instant finds
  // nothing (404). The first read waits for the POST to settle or for one polling interval.
  let settle = Boolean(posting);
  let failedReads = 0;
  let readRetryAfter: number | null = null;
  const rand = options.rand;
  // The POST settling wakes polling at once, so a result is read promptly. A restart or a load
  // balancer 503 fails every learner's POST at the same instant, though: then the wake is spread
  // over one polling period instead of all 25 loops reading together. A 4xx answer is the server's
  // own decision and is read at once.
  // jitter: period poll wait cut short when the POST settles; a POST no server answered (or answered 5xx) spreads that wake over U[0, 2.5 s)
  const waitOrWake = async (ms: number) => {
    await Promise.race([posting, sleep(ms, signal)]);
    if (postResult && 'error' in postResult && serverDown(postResult.error)) await sleep(between(0, POLL_MS, rand), signal);
  };
  while (true) {
    aborted(signal);
    if (postResult && 'data' in postResult) {
      active = await saveTask({
        ...active,
        status: 'COMPLETED',
        result: postResult.data,
        error: null,
        updatedAt: Date.now(),
      });
      onStatus?.(active);
      return postResult.data;
    }
    if (settle) {
      settle = false;
      // jitter: period U[1875, 3125) ms polling; U[0, 2.5 s) wake after a POST no server answered or answered 5xx; failed reads 2.5 s + full jitter ≤ 7.5 s, floored by Retry-After [site src/lib/ai-task.ts:368]
      await waitOrWake(pollWait(rand));
      continue;
    }
    try {
      const known = await inspectAiTask(active, signal, rand);
      failedReads = 0;
      readRetryAfter = null;
      if (known) {
        active = known;
        onStatus?.(active);
      }
      if (active.status === 'COMPLETED') return active.result as T;
      if (active.status === 'FAILED' || active.status === 'INTERRUPTED')
        throw new AiTaskFailureError(active);
      // jitter: cooldown on the manual retry (no automatic paid re-POST): retryAt = now + hint + U[0,1 s), 0 if the provider is off, U[10,20 s) for a hintless 429, else 0; drawn once [site src/lib/ai-task.ts:344]
      if (
        !known &&
        postResult &&
        'error' in postResult &&
        postResult.error instanceof ApiError &&
        postResult.error.status >= 400 &&
        postResult.error.status < 500 &&
        postResult.error.status !== 409
      ) {
        // Refused before the server recorded the run (the status read says 404): the retry may
        // send the same request id once the refusal's wait is over.
        const refusal = postResult.error;
        active = await saveTask({
          ...active,
          status: 'FAILED',
          error: refusal.message,
          errorStatus: refusal.status,
          errorCode: refusal.code,
          retryAt: Date.now() + cooldown(refusal, rand),
          unclaimed: true,
          updatedAt: Date.now(),
        });
        onStatus?.(active);
        throw new AiTaskFailureError(active);
      }
    } catch (error) {
      if (error instanceof AiTaskFailureError || signal?.aborted) throw error;
      failedReads++;
      readRetryAfter = retryAfterMsOf(error);
      // Signed out, forbidden or refused: waiting cannot change the answer, so end now with the
      // server's message instead of polling until the deadline (404 = not recorded yet, 408/409/
      // 425/429 = try again later).
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![404, 408, 409, 425, 429].includes(error.status)
      ) {
        active = await saveTask({
          ...active,
          status: 'FAILED',
          error: error.message,
          errorStatus: error.status,
          errorCode: error.code,
          updatedAt: Date.now(),
        });
        onStatus?.(active);
        throw new AiTaskFailureError(active);
      }
    }
    // jitter: none — the 190 s deadline or going offline only ends this loop as 'pending'; resuming takes a tap and reads the status first, never on 'online' [site src/lib/ai-task.ts:365]
    if (Date.now() >= deadline || (typeof navigator !== 'undefined' && navigator.onLine === false))
      throw new AiTaskPendingError(active);
    // The POST completion wakes status polling promptly. Once settled, resume bounded polling.
    // jitter: period U[1875, 3125) ms between reads; after k failed reads 2.5 s + U[0, min(7.5 s, 2.5 s·2^(k-1))), floored by Retry-After + U[0,1 s)
    const wait = failedReads > 0 ? failedReadWait(failedReads, readRetryAfter, rand) : pollWait(rand);
    if (posting && !postResult) await waitOrWake(wait);
    else await sleep(wait, signal);
  }
}
