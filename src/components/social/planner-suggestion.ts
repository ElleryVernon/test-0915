import type { Schedule } from '@/lib/contracts';
import type { AiTaskRecord } from '@/lib/ai-task';
import { overlapMinutes } from '@/lib/schedule';
import { dayLabel } from './helpers';

export type Plan = { name: string; reason?: string; blocks: Omit<Schedule, 'id'>[] };
export type PlannerResult = { plans: Plan[]; method?: string; dropped?: number };
export type PlannerTask = AiTaskRecord<PlannerResult>;

/** Drops blocks that were already saved from this result, so a retried apply never saves twice. */
export function recoverPlannerResult(
  result: PlannerResult,
  taskDate: string,
  schedules: Schedule[],
) {
  const matches = (block: Omit<Schedule, 'id'>) =>
    schedules.some(
      (schedule) =>
        schedule.date.slice(0, 10) === block.date &&
        schedule.title.trim() === block.title.trim() &&
        schedule.start === block.start &&
        schedule.end === block.end &&
        schedule.kind === block.kind &&
        (schedule.subjectId || '') === (block.subjectId || ''),
    );
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(taskDate) ||
    !Array.isArray(result.plans) ||
    result.plans.some(
      (plan) => !Array.isArray(plan.blocks) || plan.blocks.some((block) => block.date !== taskDate),
    )
  ) {
    throw new Error('추천 날짜를 확인할 수 없어요. 이전 요청 상태를 다시 확인해 주세요.');
  }
  const savedCounts = result.plans.map((plan) => plan.blocks.filter(matches).length);
  const selectedIndex = Math.max(0, savedCounts.indexOf(Math.max(0, ...savedCounts)));
  return {
    date: taskDate,
    plans: result.plans.map((plan) => ({
      ...plan,
      blocks: plan.blocks.filter((block) => !matches(block)),
    })),
    selectedIndex,
    savedCount: savedCounts[selectedIndex] ?? 0,
  };
}

/**
 * How a stored suggestion may show itself. Only a request made in the current visit opens a sheet;
 * everything else is decided here:
 * - running: a request left in flight — poll it, announce the result, never open it
 * - ready: a result never shown — "추천 보기" on its day, a notice on other days
 * - seen: a result already shown — only "추천 다시 보기" brings it back
 * - stale: past day, nothing left to add, today's suggested time has begun, or it now overlaps a
 *   schedule — end it and offer a fresh fill
 * - quiet: failed or unconfirmed — not raised on entry; tapping fill continues that request
 */
export type SuggestionState =
  | { kind: 'running' | 'ready' | 'seen' | 'quiet'; date: string }
  | { kind: 'stale'; date: string; reason: 'past' | 'empty' | 'started' | 'conflict' };

export function suggestionState(
  task: Pick<PlannerTask, 'status' | 'payload' | 'result' | 'seenAt'>,
  context: { today: string; now: string; schedules: Schedule[] },
): SuggestionState {
  const date = String(task.payload.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { kind: 'stale', date, reason: 'empty' };
  if (date < context.today) return { kind: 'stale', date, reason: 'past' };
  if (task.status === 'RUNNING') return { kind: 'running', date };
  if (task.status !== 'COMPLETED') return { kind: 'quiet', date };
  let blocks: Omit<Schedule, 'id'>[];
  try {
    blocks = recoverPlannerResult(task.result ?? { plans: [] }, date, context.schedules).plans.flatMap(
      (plan) => plan.blocks,
    );
  } catch {
    return { kind: 'stale', date, reason: 'empty' };
  }
  if (!blocks.length) return { kind: 'stale', date, reason: 'empty' };
  if (date === context.today && blocks.some((block) => block.start < context.now))
    return { kind: 'stale', date, reason: 'started' };
  const scheduled = context.schedules.filter((schedule) => schedule.date.slice(0, 10) === date);
  if (blocks.some((block) => scheduled.some((schedule) => overlapMinutes(block, schedule) > 0)))
    return { kind: 'stale', date, reason: 'conflict' };
  return { kind: task.seenAt ? 'seen' : 'ready', date };
}

/**
 * A request that lands while its day is on screen is announced by a toast, because only the button
 * label changes there. Any other day already gets a notice row, so a toast would say it twice.
 */
export function readyToast(date: string, viewedDay: string, today: string): string | null {
  if (date !== viewedDay) return null;
  return date === today ? '빈 시간 추천이 준비됐어요' : `${dayLabel(date)} 추천이 준비됐어요`;
}
