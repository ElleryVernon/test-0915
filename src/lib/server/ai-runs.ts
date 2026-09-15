import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from './db';
import { ApiError } from './errors';
import { SKILLS, type AiSkillKind } from './skills';
import { SkillRuntime, withSkillRuntime } from './skill-runtime';
import { Prisma } from './generated/client';
import { aiAvailable } from './provider';

export const RUN_LEASE_MS = 5 * 60_000;
export function inputHash(kind: AiSkillKind, input: unknown) {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, entry]) => entry !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify({ kind, input: canonical(input) }))
    .digest('hex');
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export async function expireStaleRuns(userId: string) {
  await db.aiRun.updateMany({
    where: { userId, status: 'RUNNING', updatedAt: { lt: new Date(Date.now() - RUN_LEASE_MS) } },
    data: {
      status: 'INTERRUPTED',
      error:
        '실행이 중단됐어요. 자동으로 다시 요청하지 않았어요. 내용을 확인하고 새로 시작해 주세요.',
      errorStatus: 409,
      finishedAt: new Date(),
    },
  });
}
export async function readAiRun(userId: string, requestId: string) {
  if (!z.string().uuid().safeParse(requestId).success)
    throw new ApiError(404, 'AI 작업을 찾을 수 없어요.');
  await expireStaleRuns(userId);
  const run = await db.aiRun.findUnique({ where: { userId_requestId: { userId, requestId } } });
  if (!run) throw new ApiError(404, 'AI 작업을 찾을 수 없어요.');
  return {
    requestId: run.requestId,
    kind: run.kind,
    model: run.model,
    skillVersion: run.skillVersion,
    status: run.status,
    result: run.result,
    error: run.error,
    errorStatus: run.errorStatus,
    steps: run.steps,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    updatedAt: run.updatedAt.toISOString(),
  };
}

export interface AiExecution {
  runtime: SkillRuntime;
  commit<T>(persist: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}
export async function executeAiRun<T>(
  options: { userId: string; requestId?: string; kind: AiSkillKind; input: unknown },
  work: (execution: AiExecution) => Promise<T>,
) {
  const requestId = options.requestId ?? randomUUID();
  const hash = inputHash(options.kind, options.input);
  await expireStaleRuns(options.userId);
  let claimed = false;
  try {
    await db.aiRun.create({
      data: {
        userId: options.userId,
        requestId,
        kind: options.kind,
        inputHash: hash,
        skillVersion: SKILLS[options.kind].version,
        model: aiAvailable()
          ? process.env.OPENROUTER_MODEL!
          : ['grade', 'planner'].includes(options.kind)
            ? 'local-rules'
            : 'unconfigured',
      },
    });
    claimed = true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
      throw error;
  }
  const where = { userId_requestId: { userId: options.userId, requestId } };
  const run = await db.aiRun.findUniqueOrThrow({ where });
  if (!claimed) {
    if (run.kind !== options.kind || run.inputHash !== hash)
      throw new ApiError(409, '같은 요청 번호에 다른 내용이 담겼어요. 새 작업으로 시작해 주세요.');
    if (run.status === 'COMPLETED') return { result: run.result as T, requestId, replayed: true };
    if (run.status === 'RUNNING')
      throw new ApiError(409, '이미 처리 중인 AI 작업이에요. 작업 상태를 확인해 주세요.');
    throw new ApiError(
      run.errorStatus ?? 409,
      run.error ?? '이 작업은 종료됐어요. 새 작업으로 다시 시작해 주세요.',
    );
  }
  const runtime = new SkillRuntime(options.kind, async (steps) => {
    const last = steps.at(-1);
    if (last?.stage === 'COMMIT' && last.status === 'COMPLETED') return;
    const changed = await db.aiRun.updateMany({
      where: { id: run.id, status: 'RUNNING' },
      data: { steps: json(steps) },
    });
    if (!changed.count)
      throw new ApiError(409, '이미 종료된 AI 작업이에요. 작업 상태를 확인해 주세요.');
  });
  let committed = false;
  const execution: AiExecution = {
    runtime,
    commit: async (persist) =>
      runtime.tool('COMMIT', {}, z.object({}), async () => {
        const result = await db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "AiRun" WHERE id=${run.id} FOR UPDATE`;
            const current = await tx.aiRun.findUniqueOrThrow({ where: { id: run.id } });
            if (current.status !== 'RUNNING')
              throw new ApiError(409, '이미 종료된 AI 작업은 저장할 수 없어요.');
            const value = await persist(tx);
            const finishedAt = new Date();
            const steps = runtime.steps.map((step) =>
              step.stage === 'COMMIT'
                ? {
                    ...step,
                    status: 'COMPLETED',
                    finishedAt: finishedAt.toISOString(),
                    durationMs: finishedAt.getTime() - Date.parse(step.startedAt),
                  }
                : step,
            );
            await tx.aiRun.update({
              where: { id: run.id },
              data: { status: 'COMPLETED', result: json(value), steps: json(steps), finishedAt },
            });
            return value;
          },
          { timeout: 20_000 },
        );
        committed = true;
        return result;
      }),
  };
  try {
    await withSkillRuntime(runtime, () => work(execution));
    if (!committed) throw new ApiError(500, 'AI 작업 결과가 저장되지 않았어요.');
    const saved = await db.aiRun.findUniqueOrThrow({ where });
    return { result: saved.result as T, requestId, replayed: false };
  } catch (error) {
    const safe =
      error instanceof ApiError
        ? error
        : new ApiError(500, 'AI 작업을 완료하지 못했어요. 새 작업으로 다시 시도해 주세요.');
    await db.aiRun
      .updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          error: safe.message,
          errorStatus: safe.status,
          finishedAt: new Date(),
        },
      })
      .catch(() => {});
    throw safe;
  }
}
