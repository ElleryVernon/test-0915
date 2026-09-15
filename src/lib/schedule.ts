import type { Schedule } from './contracts';

/** Pure schedule arithmetic shared by the planner screen and the server planner. */
type Interval = Pick<Schedule, 'start' | 'end'>;
type Dated = Pick<Schedule, 'date' | 'start' | 'end'>;

export const DAY_END = 23 * 60 + 59;

export function minutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
export function timeString(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
export function formatMinutes(total: number): string {
  return total >= 60
    ? `${Math.floor(total / 60)}시간${total % 60 ? ` ${total % 60}분` : ''}`
    : `${total}분`;
}
export function durationLabel(start: string, end: string): string {
  return formatMinutes(minutes(end) - minutes(start));
}
export function overlapMinutes(a: Interval, b: Interval): number {
  return Math.max(
    0,
    Math.min(minutes(a.end), minutes(b.end)) - Math.max(minutes(a.start), minutes(b.start)),
  );
}

export interface ScheduleGap {
  beforeId: string;
  date: string;
  start: string;
  end: string;
}
/**
 * Free time between schedules of the same date. Day boundaries are never invented: time before
 * the first and after the last schedule is not a gap. `after` clips a gap that has partly passed.
 */
export function scheduleGaps(
  schedules: (Dated & { id: string })[],
  { min = 15, after }: { min?: number; after?: string } = {},
): ScheduleGap[] {
  const gaps: ScheduleGap[] = [];
  const sorted = [...schedules].sort(
    (a, b) =>
      a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)) || a.start.localeCompare(b.start),
  );
  let date = '';
  let occupiedUntil = '';
  for (const schedule of sorted) {
    const scheduleDate = schedule.date.slice(0, 10);
    if (date !== scheduleDate) {
      date = scheduleDate;
      occupiedUntil = schedule.end;
      continue;
    }
    const start = after && after > occupiedUntil ? after : occupiedUntil;
    if (minutes(schedule.start) - minutes(start) >= min) {
      gaps.push({ beforeId: schedule.id, date, start, end: schedule.start });
    }
    if (schedule.end > occupiedUntil) occupiedUntil = schedule.end;
  }
  return gaps;
}

/** A study day ends at 22:00; the server's evening fallback starts at 16:00. */
export const STUDY_DAY = { start: '16:00', end: '22:00' };
/**
 * Free time after the last schedule of a day until the end of the study day (school ends at
 * 16:00 → 16:00–22:00 is free). Returns null for an empty day or when less than `min` remains.
 */
export function eveningWindow(
  schedules: Interval[],
  { after, min = 60, end = STUDY_DAY.end }: { after?: string; min?: number; end?: string } = {},
): { start: string; end: string } | null {
  if (!schedules.length) return null;
  const lastEnd = schedules.reduce((latest, s) => (s.end > latest ? s.end : latest), '00:00');
  const start = after && after > lastEnd ? after : lastEnd;
  return minutes(end) - minutes(start) >= min ? { start, end } : null;
}
/** Every free window the timetable offers to fill: gaps between schedules and the evening. */
export function freeWindows(
  schedules: (Dated & { id: string })[],
  { after, min = 60 }: { after?: string; min?: number } = {},
): { start: string; end: string }[] {
  const evening = eveningWindow(schedules, { after, min });
  return [
    ...scheduleGaps(schedules, { min, after }).map(({ start, end }) => ({ start, end })),
    ...(evening ? [evening] : []),
  ];
}

/** Earliest slot of `duration` minutes starting at or after `from` that overlaps nothing. */
export function findFreeSlot(
  others: Interval[],
  from: number,
  duration: number,
  limit = DAY_END,
): { start: string; end: string } | null {
  const candidates = [
    from,
    ...others.map((other) => minutes(other.end)).filter((end) => end > from),
  ].sort((a, b) => a - b);
  for (const start of candidates) {
    const end = start + duration;
    if (end > limit) break;
    if (!others.some((other) => start < minutes(other.end) && minutes(other.start) < end))
      return { start: timeString(start), end: timeString(end) };
  }
  return null;
}

export interface ConflictFixes {
  shrink?: { start: string; end: string };
  move?: { start: string; end: string };
}
/**
 * Two ways to resolve an overlap without touching the other schedules: keep the start and end
 * before the next occupied time (or keep the end), or keep the length and move to the next free
 * time after the blocking schedule.
 */
export function conflictFixes(target: Interval, others: Interval[], minLength = 10): ConflictFixes {
  const start = minutes(target.start);
  const end = minutes(target.end);
  const blocking = others.filter(
    (other) => start < minutes(other.end) && minutes(other.start) < end,
  );
  if (!blocking.length || end <= start) return {};
  const fixes: ConflictFixes = {};
  const coversStart = blocking.some(
    (other) => minutes(other.start) <= start && start < minutes(other.end),
  );
  const coversEnd = blocking.some(
    (other) => minutes(other.start) < end && end <= minutes(other.end),
  );
  if (!coversStart) {
    const shrinkEnd = Math.min(...blocking.map((other) => minutes(other.start)));
    if (shrinkEnd - start >= minLength)
      fixes.shrink = { start: target.start, end: timeString(shrinkEnd) };
  } else if (!coversEnd) {
    const shrinkStart = Math.max(...blocking.map((other) => minutes(other.end)));
    if (end - shrinkStart >= minLength)
      fixes.shrink = { start: timeString(shrinkStart), end: target.end };
  }
  const move = findFreeSlot(
    others,
    Math.max(...blocking.map((other) => minutes(other.end))),
    end - start,
  );
  if (move) fixes.move = move;
  return fixes;
}
