import { findAiTask, inspectAiTask } from '@/lib/ai-task';
import type { GenerationMode } from './logic';

/** Reopening a sheet restores its saved request, regardless of the UI's default count. */
export async function recoverGenerationTask({
  userId,
  materialId,
  mode,
  signal,
}: {
  userId: string;
  materialId: string;
  mode: GenerationMode;
  signal?: AbortSignal;
}) {
  const stored = await findAiTask({
    userId,
    endpoint: '/generate',
    match: { materialId, mode },
  });
  if (!stored || signal?.aborted) return null;
  const count = stored.payload.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10)
    throw new Error('이전 요청의 문항 수를 확인하지 못했어요. 자료함을 확인해 주세요.');
  // jitter: none — one status read when the sheet opens; an error falls back to the stored copy [site src/components/study/generation-task.ts:25]
  const recovered = await inspectAiTask(stored, signal).catch(() => stored);
  if (signal?.aborted) return null;
  return { task: recovered || stored, count };
}
