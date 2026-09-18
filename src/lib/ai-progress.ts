import { AI_CLIENT_DEADLINE_MS, type AiTaskStep } from '@/lib/ai-task';

/** The four stages every AI run records, in order (server: ai.Stages). */
export const AI_STAGES = ['LOAD_CONTEXT', 'GENERATE', 'VALIDATE', 'COMMIT'] as const;
export type AiStage = (typeof AI_STAGES)[number];
export type StageCopy = Record<AiStage, string>;

export function generationCopy(label: string): StageCopy {
  return {
    LOAD_CONTEXT: '자료 본문을 읽는 중',
    GENERATE: `${label}를 만드는 중`,
    VALIDATE: '원문 근거와 형식을 확인하는 중',
    COMMIT: '저장하는 중',
  };
}

export const PLANNER_COPY: StageCopy = {
  LOAD_CONTEXT: '빈 시간과 복습 카드를 보는 중',
  GENERATE: '두 가지 안을 만드는 중',
  VALIDATE: '겹치는 시간이 없는지 확인하는 중',
  COMMIT: '추천을 정리하는 중',
};

export interface ProgressCopy {
  /** What the run is doing now, from its last recorded stage. */
  stage: string;
  /** Elapsed time as the learner reads it ("12초", "1분 05초"). */
  elapsed: string;
  /** Honest expectation for this point in time. */
  hint: string;
  /** Index of the current stage, for a four-step indicator. */
  step: number;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}초`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}분 ${String(seconds).padStart(2, '0')}초`;
}

/**
 * Stage copy for a running AI task. Without recorded steps the run is still being accepted, so
 * the first stage is shown. The hint changes with elapsed time so a 50-second generation reads
 * as expected rather than as a hang.
 */
export function progressCopy(
  copy: StageCopy,
  steps: AiTaskStep[] | undefined,
  elapsedMs: number,
): ProgressCopy {
  const last = steps?.at(-1)?.stage;
  const stage = AI_STAGES.includes(last as AiStage) ? (last as AiStage) : 'LOAD_CONTEXT';
  const step = AI_STAGES.indexOf(stage);
  let hint: string;
  if (elapsedMs < 20_000) hint = '자료 분량과 검토 과정에 따라 시간이 달라요.';
  else if (elapsedMs < 60_000)
    hint = '원문을 꼼꼼히 확인하고 있어요. 자료가 길면 1분을 넘길 수 있어요.';
  else if (elapsedMs < 120_000)
    hint = '아직 만들고 있어요. 결과는 요청 번호로 보관되니 잃어버리지 않아요.';
  else
    hint = `응답이 늦어요. ${Math.round(AI_CLIENT_DEADLINE_MS / 1000)}초가 지나면 기다림을 멈추고 나중에 이어서 확인해요.`;
  return { stage: copy[stage], elapsed: formatElapsed(elapsedMs), hint, step };
}
