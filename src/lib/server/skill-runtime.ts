import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { ApiError } from './errors';
import { AI_STAGES, SKILLS, type AiSkillKind, type AiStage } from './skills';

export interface AiStep {
  stage: AiStage;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}
export class SkillRuntime {
  readonly steps: AiStep[] = [];
  constructor(
    readonly kind: AiSkillKind,
    private readonly persist?: (steps: AiStep[]) => Promise<void>,
  ) {}
  async tool<I, O>(
    stage: AiStage,
    input: unknown,
    schema: z.ZodType<I>,
    execute: (input: I) => Promise<O> | O,
  ): Promise<O> {
    if (stage !== AI_STAGES[this.steps.length] || !SKILLS[this.kind].allowedStages.includes(stage))
      throw new ApiError(500, '허용되지 않은 AI 실행 단계예요.');
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, 'AI 실행 단계의 입력 형식이 올바르지 않아요.');
    const step: AiStep = { stage, status: 'RUNNING', startedAt: new Date().toISOString() };
    this.steps.push(step);
    await this.persist?.(this.steps);
    try {
      const output = await execute(parsed.data);
      this.finish(step, 'COMPLETED');
      await this.persist?.(this.steps);
      return output;
    } catch (error) {
      this.finish(step, 'FAILED');
      await this.persist?.(this.steps).catch(() => {});
      throw error;
    }
  }
  private finish(step: AiStep, status: 'COMPLETED' | 'FAILED') {
    step.status = status;
    step.finishedAt = new Date().toISOString();
    step.durationMs = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
  }
}
const activeRuntime = new AsyncLocalStorage<SkillRuntime>();
export function withSkillRuntime<T>(runtime: SkillRuntime, work: () => Promise<T>) {
  return activeRuntime.run(runtime, work);
}

/** Typed input parsing precedes execution, while task validators remain authoritative. */
export async function runTypedSkill<I, O>(
  kind: AiSkillKind,
  input: unknown,
  inputSchema: z.ZodType<I>,
  generate: (input: I) => Promise<unknown> | unknown,
  validate: (value: unknown) => O,
): Promise<O> {
  const active = activeRuntime.getStore();
  if (active && active.kind !== kind) throw new ApiError(500, 'AI 작업 유형과 실행 스킬이 달라요.');
  const runtime = active ?? new SkillRuntime(kind);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, 'AI 학습 입력을 확인해 주세요.');
  if (!runtime.steps.length)
    await runtime.tool('LOAD_CONTEXT', parsed.data, inputSchema, (value) => value);
  const raw = await runtime.tool('GENERATE', parsed.data, inputSchema, generate);
  return runtime.tool('VALIDATE', raw, z.unknown(), validate);
}
