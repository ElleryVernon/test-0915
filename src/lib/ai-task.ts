import { openDB, type DBSchema } from 'idb';

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
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
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
    stored?.seenAt && stored.requestId === task.requestId ? { ...task, seenAt: stored.seenAt } : task;
  await db.put('tasks', next);
  return next;
}
async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(body === undefined ? 20000 : 150000);
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response
    .json()
    .catch(() => ({ error: '작업 응답을 읽지 못했어요. 저장된 결과를 다시 확인해 주세요.' }));
  if (!response.ok)
    throw new HttpError(response.status, result.error || '작업 상태를 확인하지 못했어요.');
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
    return saveTask({
      ...task,
      status: remote.status,
      result: remote.result as T | null,
      error: remote.error,
      steps: remote.steps,
      updatedAt: Date.parse(remote.updatedAt) || Date.now(),
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
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
async function pause(ms: number, signal?: AbortSignal) {
  aborted(signal);
  await new Promise<void>((resolve, reject) => {
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
      known = await inspectAiTask(task, signal);
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
      if (!options.retryFailed) {
        onStatus?.(task);
        throw new AiTaskFailureError(task);
      }
      task = undefined;
      existsRemotely = false;
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
  const deadline = Date.now() + 150000;
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
    try {
      const known = await inspectAiTask(active, signal);
      if (known) {
        active = known;
        onStatus?.(active);
      }
      if (active.status === 'COMPLETED') return active.result as T;
      if (active.status === 'FAILED' || active.status === 'INTERRUPTED')
        throw new AiTaskFailureError(active);
      if (
        !known &&
        postResult &&
        'error' in postResult &&
        postResult.error instanceof HttpError &&
        postResult.error.status >= 400 &&
        postResult.error.status < 500 &&
        postResult.error.status !== 409
      ) {
        active = await saveTask({
          ...active,
          status: 'FAILED',
          error: postResult.error.message,
          updatedAt: Date.now(),
        });
        onStatus?.(active);
        throw new AiTaskFailureError(active);
      }
    } catch (error) {
      if (error instanceof AiTaskFailureError || signal?.aborted) throw error;
    }
    if (Date.now() >= deadline || (typeof navigator !== 'undefined' && navigator.onLine === false))
      throw new AiTaskPendingError(active);
    // The POST completion wakes status polling promptly. Once settled, resume bounded polling.
    if (posting && !postResult) await Promise.race([posting, pause(2500, signal)]);
    else await pause(2500, signal);
  }
}
