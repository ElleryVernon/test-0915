import type { Schedule } from './contracts';
import { minutes, timeString } from './schedule';

export const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
export type PlanBlock = Pick<Schedule, 'title' | 'date' | 'start' | 'end' | 'kind'> & {
  subjectId?: string | null;
  /** Local planning metadata, never sent to the schedule API. */
  needId?: string;
};
export type Recurrence = { from: string; until: string; weekdays: number[] };
export type WeeklyNeed = {
  id: string;
  title: string;
  minutes: number;
  sessionMinutes: number;
  weekdays: number[];
  subjectId?: string;
  differentDays?: boolean;
  scheduledDates?: string[];
};
export type AcademyOption = {
  id: string;
  title: string;
  weekdays: number[];
  start: string;
  end: string;
};
export type AcademyGroup = { id: string; title: string; options: AcademyOption[] };
export type WeeklyInput = {
  from: string;
  start: string;
  end: string;
  needs: WeeklyNeed[];
  groups: AcademyGroup[];
};
export type WeeklyPlan = {
  id: string;
  title: string;
  blocks: PlanBlock[];
  choices: string[];
  unmet: { title: string; minutes: number; needId?: string }[];
  allocated: number;
};
export type PendingWeeklyPlan = { input: WeeklyInput; plan: WeeklyPlan };
export const weeklyBatchPayload = (plan: WeeklyPlan) => ({
  blocks: plan.blocks.map(({ needId: _needId, subjectId, ...block }) => ({
    ...block,
    ...(subjectId ? { subjectId } : {}),
  })),
});
export function remainingWeeklyNeeds(needs: WeeklyNeed[], plan: WeeklyPlan): WeeklyNeed[] {
  return needs.flatMap((need) => {
    const unmet = plan.unmet.find((item) => item.needId === need.id);
    if (!unmet) return [];
    return [
      {
        ...need,
        minutes: unmet.minutes,
        scheduledDates: [
          ...new Set([
            ...(need.scheduledDates ?? []),
            ...plan.blocks.filter((block) => block.needId === need.id).map((block) => block.date),
          ]),
        ],
      },
    ];
  });
}
export function weeklyDurationOptions(current: number) {
  return [
    ...new Set([15, 30, 60, 90, 120, 180, 240, 300, 360, 480, 600, 900, 1200, 1800, 2400, current]),
  ].sort((a, b) => a - b);
}
export const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(`${date}T12:00:00Z`)) &&
  new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;
export const shiftPlanDate = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const planWeekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
export const validTime = (time: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
const validDays = (days: number[]) =>
  days.length > 0 &&
  days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) &&
  new Set(days).size === days.length;
export const planConflict = (
  a: Pick<PlanBlock, 'date' | 'start' | 'end'>,
  b: Pick<PlanBlock, 'date' | 'start' | 'end'>,
) => a.date.slice(0, 10) === b.date.slice(0, 10) && a.start < b.end && b.start < a.end;
export const samePlanBlock = (a: PlanBlock, b: PlanBlock) =>
  a.title.trim() === b.title.trim() &&
  a.date.slice(0, 10) === b.date.slice(0, 10) &&
  a.start === b.start &&
  a.end === b.end &&
  a.kind === b.kind &&
  (a.subjectId || '') === (b.subjectId || '');
export function recurrenceError(value: Recurrence) {
  if (!validDate(value.from) || !validDate(value.until)) return '시작일과 종료일을 확인해 주세요.';
  if (value.until < value.from) return '종료일은 시작일 이후로 골라 주세요.';
  if (value.until > shiftPlanDate(value.from, 182)) return '반복 기간은 최대 6개월(183일)이에요.';
  if (!validDays(value.weekdays)) return '반복할 요일을 하나 이상 골라 주세요.';
  return '';
}
export function recurringBlocks(block: PlanBlock, recurrence: Recurrence): PlanBlock[] {
  if (recurrenceError(recurrence)) return [];
  const result: PlanBlock[] = [];
  for (let date = recurrence.from; date <= recurrence.until; date = shiftPlanDate(date, 1))
    if (recurrence.weekdays.includes(planWeekday(date))) result.push({ ...block, date });
  return result;
}
export function previewPlan(blocks: PlanBlock[], schedules: PlanBlock[]) {
  return blocks.map((block) => ({
    block,
    status: schedules.some((s) => samePlanBlock(s, block))
      ? ('existing' as const)
      : schedules.some((s) => planConflict(s, block))
        ? ('conflict' as const)
        : ('new' as const),
  }));
}
export function weeklyInputError(input: WeeklyInput) {
  if (!validDate(input.from)) return '시작 날짜를 확인해 주세요.';
  if (!validTime(input.start) || !validTime(input.end) || input.start >= input.end)
    return '배치할 시간 범위를 확인해 주세요.';
  if (!input.needs.length && !input.groups.length)
    return '이번 주에 할 일이나 시간표 후보를 추가해 주세요.';
  if (input.needs.length > 8 || input.groups.length > 3)
    return '할 일은 8개, 비교할 일정은 3개까지 넣을 수 있어요.';
  for (const need of input.needs) {
    if (!need.title.trim() || need.title.trim().length > 100)
      return '할 일 이름을 100자 이내로 적어 주세요.';
    if (
      !Number.isInteger(need.minutes) ||
      need.minutes < 15 ||
      need.minutes > 40 * 60 ||
      need.minutes % 15 ||
      ![15, 30, 60, 90, 120].includes(need.sessionMinutes)
    )
      return '총 시간은 15분~40시간, 15분 단위로 입력해 주세요.';
    if (need.minutes % need.sessionMinutes)
      return `${need.title}: 총 시간을 한 번에 할 시간의 배수로 골라 주세요.`;
    if (!validDays(need.weekdays)) return `${need.title}: 가능한 요일을 골라 주세요.`;
    if (need.scheduledDates?.some((date) => !validDate(date)))
      return `${need.title}: 이미 배치한 날짜를 확인해 주세요.`;
  }
  for (const group of input.groups) {
    if (
      !group.title.trim() ||
      group.title.trim().length > 40 ||
      !group.options.length ||
      group.options.length > 3
    )
      return '비교할 일정의 이름과 후보(최대 3개)를 확인해 주세요.';
    for (const option of group.options)
      if (
        !option.title.trim() ||
        option.title.trim().length > 50 ||
        !validDays(option.weekdays) ||
        !validTime(option.start) ||
        !validTime(option.end) ||
        option.start >= option.end
      )
        return `${group.title}: 후보의 이름, 요일과 시간을 확인해 주세요.`;
  }
  return '';
}
/** Bounded, deterministic proposals; unmet capacity is about these candidates, not a proof of global infeasibility. */
export function weeklyPlans(
  input: WeeklyInput,
  schedules: PlanBlock[],
  now?: { date: string; time: string },
): { plans: WeeklyPlan[]; rejected: number; error: string } {
  const error = weeklyInputError(input);
  if (error) return { plans: [], rejected: 0, error };
  const dates = Array.from({ length: 7 }, (_, i) => shiftPlanDate(input.from, i));
  let combos: AcademyOption[][] = [[]];
  for (const group of input.groups)
    combos = combos.flatMap((combo) => group.options.map((option) => [...combo, option]));
  let rejected = 0;
  const plans: WeeklyPlan[] = [];
  for (const combo of combos) {
    const fixed: PlanBlock[] = combo.flatMap((option, i) =>
      dates
        .filter((date) => option.weekdays.includes(planWeekday(date)))
        .map((date) => ({
          title: `${input.groups[i].title} · ${option.title}`,
          date,
          start: option.start,
          end: option.end,
          kind: 'FIXED' as const,
        })),
    );
    // A weekly option must fit in full, including all of its selected days.
    if (
      fixed.some(
        (block, i) =>
          (now && (block.date < now.date || (block.date === now.date && block.start < now.time))) ||
          schedules.some((s) => planConflict(s, block) && !samePlanBlock(s, block)) ||
          fixed.slice(0, i).some((s) => planConflict(s, block)),
      )
    ) {
      rejected++;
      continue;
    }
    for (const strategy of ['고르게 나누기', '앞쪽에 모으기', '뒤쪽에 모으기'] as const) {
      const blocks = fixed.filter((b) => !schedules.some((s) => samePlanBlock(b, s)));
      const occupied = [...schedules, ...fixed];
      const load = new Map(dates.map((d) => [d, 0]));
      const unmet: WeeklyPlan['unmet'] = [];
      let allocated = 0;
      // Most constrained needs first; stable input order is the tie-breaker.
      const needs = [...input.needs].sort(
        (a, b) => a.weekdays.length - b.weekdays.length || b.sessionMinutes - a.sessionMinutes,
      );
      for (const need of needs) {
        let remaining = need.minutes;
        const usedDays = new Set(need.scheduledDates ?? []);
        while (remaining > 0 && blocks.length < 200) {
          const candidates = dates.filter(
            (d) =>
              need.weekdays.includes(planWeekday(d)) &&
              (!need.differentDays || !usedDays.has(d)) &&
              (!now || d >= now.date),
          );
          candidates.sort((a, b) =>
            strategy === '고르게 나누기'
              ? load.get(a)! - load.get(b)! || a.localeCompare(b)
              : strategy === '뒤쪽에 모으기'
                ? b.localeCompare(a)
                : a.localeCompare(b),
          );
          let found: PlanBlock | undefined;
          for (const date of candidates) {
            const from = Math.max(
              minutes(input.start),
              now?.date === date ? Math.ceil(minutes(now.time) / 15) * 15 : 0,
            );
            let start = from;
            const dayIntervals = occupied
              .filter((other) => other.date.slice(0, 10) === date)
              .sort((a, b) => a.start.localeCompare(b.start));
            for (const other of dayIntervals) {
              if (start + need.sessionMinutes <= minutes(other.start)) break;
              if (start < minutes(other.end))
                start = from + Math.ceil((minutes(other.end) - from) / 15) * 15;
            }
            if (start + need.sessionMinutes <= minutes(input.end))
              found = {
                title: need.title.trim(),
                date,
                start: timeString(start),
                end: timeString(start + need.sessionMinutes),
                kind: 'FLEXIBLE',
                subjectId: need.subjectId,
                needId: need.id,
              };
            if (found) break;
          }
          if (!found) break;
          usedDays.add(found.date);
          blocks.push(found);
          occupied.push(found);
          load.set(found.date, load.get(found.date)! + need.sessionMinutes);
          remaining -= need.sessionMinutes;
          allocated += need.sessionMinutes;
        }
        if (remaining)
          unmet.push({ title: need.title.trim(), minutes: remaining, needId: need.id });
      }
      blocks.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
      const signature = JSON.stringify(blocks);
      if (!plans.some((p) => JSON.stringify(p.blocks) === signature))
        plans.push({
          id: `plan-${plans.length}`,
          title: strategy,
          choices: combo.map((o, i) => `${input.groups[i].title}: ${o.title}`),
          blocks,
          unmet,
          allocated,
        });
    }
  }
  plans.sort(
    (a, b) =>
      a.unmet.reduce((n, u) => n + u.minutes, 0) - b.unmet.reduce((n, u) => n + u.minutes, 0),
  );
  return { plans: plans.slice(0, 9), rejected, error: '' };
}
