import type { AppData, Post, Schedule } from '@/lib/contracts';
import {
  conflictFixes,
  eveningWindow,
  findFreeSlot,
  freeWindows,
  minutes,
  scheduleGaps,
  STUDY_DAY,
} from '@/lib/schedule';

export function dateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function shiftDate(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);
  return dateKey(new Date(year, month - 1, day + days, 12));
}
export function weekDates(key: string): string[] {
  const day = new Date(`${key}T12:00:00`).getDay();
  const monday = shiftDate(key, -(day === 0 ? 6 : day - 1));
  return Array.from({ length: 7 }, (_, i) => shiftDate(monday, i));
}
export { durationLabel, formatMinutes, minutes, scheduleGaps } from '@/lib/schedule';
export function scheduleConflicts(schedules: Schedule[]): [Schedule, Schedule][] {
  const result: [Schedule, Schedule][] = [];
  for (let i = 0; i < schedules.length; i++) {
    for (let j = i + 1; j < schedules.length; j++) {
      const a = schedules[i],
        b = schedules[j];
      if (
        a.date === b.date &&
        minutes(a.start) < minutes(b.end) &&
        minutes(b.start) < minutes(a.end)
      )
        result.push([a, b]);
    }
  }
  return result;
}
export function scheduleError(
  schedule: Pick<Schedule, 'title' | 'date' | 'start' | 'end'>,
): string | null {
  if (!schedule.title.trim()) return '일정 이름을 적어 주세요.';
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(schedule.date) ||
    Number.isNaN(Date.parse(schedule.date)) ||
    new Date(schedule.date).toISOString().slice(0, 10) !== schedule.date
  )
    return '날짜를 선택해 주세요.';
  if (![schedule.start, schedule.end].every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))
    return '시간을 확인해 주세요.';
  if (minutes(schedule.end) <= minutes(schedule.start))
    return '끝나는 시간은 시작 시간보다 늦어야 해요.';
  return null;
}
const WEEKDAYS = '일월화수목금토';
export function dayLabel(key: string, weekday: 'short' | 'long' = 'short'): string {
  const day = new Date(`${key}T12:00:00`).getDay();
  return `${Number(key.slice(5, 7))}월 ${Number(key.slice(8, 10))}일 ${WEEKDAYS[day]}${weekday === 'long' ? '요일' : ''}`;
}
/** Korean particle for `word`: 과/와, 을/를, 이/가, 으로/로 (ㄹ-final takes 로). */
export function particle(word: string, kind: '과' | '을' | '이' | '으로'): string {
  const pairs = { 과: ['과', '와'], 을: ['을', '를'], 이: ['이', '가'], 으로: ['으로', '로'] };
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  let final: number | null = null;
  if (code >= 0 && code < 11172) final = code % 28;
  else if (/\d/.test(last)) final = [21, 8, 0, 16, 0, 0, 1, 8, 8, 0][Number(last)];
  const [withFinal, withoutFinal] = pairs[kind];
  if (!final || (kind === '으로' && final === 8)) return withoutFinal;
  return withFinal;
}
export const josa = (word: string, kind: Parameters<typeof particle>[1]) =>
  `${word}${particle(word, kind)}`;
/** Rounds a clock up to the next `step` minutes as HH:MM, capped at 23:59. */
export function ceilTime(date: Date, step = 5): string {
  const total = Math.min(
    23 * 60 + 59,
    Math.ceil((date.getHours() * 60 + date.getMinutes()) / step) * step,
  );
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
/** Study time counts self-study blocks only; fixed school/academy time is not checked off. */
export function studyProgress(schedules: Schedule[]) {
  const study = schedules.filter((s) => s.kind === 'FLEXIBLE');
  const length = (s: Schedule) => minutes(s.end) - minutes(s.start);
  const done = study.filter((s) => s.done);
  return {
    count: study.length,
    doneCount: done.length,
    minutes: study.reduce((sum, s) => sum + length(s), 0),
    doneMinutes: done.reduce((sum, s) => sum + length(s), 0),
  };
}
export function monthGrid(key: string): (string | null)[][] {
  const [year, month] = key.split('-').map(Number);
  const first = new Date(year, month - 1, 1, 12);
  const days = new Date(year, month, 0, 12).getDate();
  const cells: (string | null)[] = Array.from({ length: (first.getDay() + 6) % 7 }, () => null);
  for (let day = 1; day <= days; day++) cells.push(dateKey(new Date(year, month - 1, day, 12)));
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
}
export function shiftMonth(key: string, months: number): string {
  const [year, month] = key.split('-').map(Number);
  return dateKey(new Date(year, month - 1 + months, 1, 12));
}
/** Most recently scheduled distinct titles, newest date first. */
export function recentSchedules(schedules: Schedule[], limit = 4): Schedule[] {
  const seen = new Set<string>();
  return [...schedules]
    .sort((a, b) => b.date.localeCompare(a.date) || b.start.localeCompare(a.start))
    .filter((s) => {
      const title = s.title.trim();
      if (!title || seen.has(title)) return false;
      seen.add(title);
      return true;
    })
    .slice(0, limit);
}

/**
 * Default hour for a new schedule: the first free window of the day (school ends 16:00 → 16:00),
 * otherwise 16:00; never earlier than `after` (today's current time).
 */
export function defaultSlot(scheduled: Schedule[], after?: string) {
  const window = freeWindows(scheduled, { after })[0];
  const from = window
    ? minutes(window.start)
    : Math.max(minutes(STUDY_DAY.start), after ? minutes(after) : 0);
  return findFreeSlot(scheduled, from, 60) ?? { start: '17:00', end: '18:00' };
}

export type PlannerRow =
  | { type: 'item'; schedule: Schedule; current: boolean }
  | { type: 'gap'; start: string; end: string; minutes: number }
  | { type: 'now'; time: string }
  | {
      type: 'conflict';
      id: string;
      anchor: Schedule;
      other: Schedule;
      movable: Schedule | null;
      overlap: number;
      fix: { start: string; end: string; kind: 'move' | 'shrink' } | null;
    };
/**
 * Orders one day's timetable: free time of at least `minGap` minutes, the current-time line and
 * an inline row for each overlap sit directly before the schedule they precede; the evening
 * after the last schedule (until 22:00) closes the list. For today only the unpassed part of a
 * gap counts, and a gap that has fully passed is hidden.
 */
export function plannerRows(
  daySchedules: Schedule[],
  { now, minGap = 60 }: { now?: string; minGap?: number } = {},
): PlannerRow[] {
  const sorted = [...daySchedules].sort(
    (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
  );
  const gaps = new Map(
    scheduleGaps(sorted, { min: minGap, after: now }).map((gap) => [gap.beforeId, gap]),
  );
  const conflicts = new Map<string, [Schedule, Schedule]>();
  for (const [a, b] of scheduleConflicts(sorted)) {
    const [first, second] = a.start <= b.start ? [a, b] : [b, a];
    if (!conflicts.has(second.id)) conflicts.set(second.id, [first, second]);
  }
  const rows: PlannerRow[] = [];
  let nowPlaced = !now;
  for (const schedule of sorted) {
    const gap = gaps.get(schedule.id);
    if (!nowPlaced && (schedule.end > now! || (gap && gap.end > now!))) {
      rows.push({ type: 'now', time: now! });
      nowPlaced = true;
    }
    if (gap)
      rows.push({
        type: 'gap',
        start: gap.start,
        end: gap.end,
        minutes: minutes(gap.end) - minutes(gap.start),
      });
    const pair = conflicts.get(schedule.id);
    if (pair) {
      const [first, second] = pair;
      const movable =
        second.kind === 'FLEXIBLE' ? second : first.kind === 'FLEXIBLE' ? first : null;
      const other = movable === first ? second : first;
      const fixes = movable
        ? conflictFixes(
            movable,
            sorted.filter((s) => s.id !== movable.id),
          )
        : {};
      rows.push({
        type: 'conflict',
        id: `${first.id}:${second.id}`,
        anchor: schedule,
        other,
        movable,
        overlap: Math.min(minutes(first.end), minutes(second.end)) - minutes(second.start),
        fix: fixes.move
          ? { ...fixes.move, kind: 'move' }
          : fixes.shrink
            ? { ...fixes.shrink, kind: 'shrink' }
            : null,
      });
    }
    rows.push({
      type: 'item',
      schedule,
      current: !!now && !schedule.done && schedule.start <= now && now < schedule.end,
    });
  }
  if (!nowPlaced && sorted.length) rows.push({ type: 'now', time: now! });
  const evening = eveningWindow(sorted, { after: now, min: minGap });
  if (evening)
    rows.push({
      type: 'gap',
      start: evening.start,
      end: evening.end,
      minutes: minutes(evening.end) - minutes(evening.start),
    });
  return rows;
}
export function selectPosts(
  posts: Post[],
  role: AppData['profile']['role'],
  options: {
    category?: string;
    query?: string;
    sort?: 'latest' | 'popular';
    saved?: boolean;
    mine?: string;
  },
): Post[] {
  const query = options.query?.trim().toLocaleLowerCase();
  return posts
    .filter(
      (p) =>
        p.role === role &&
        (!options.category || options.category === '전체' || p.category === options.category) &&
        (!options.saved || p.saved) &&
        (!options.mine || p.authorId === options.mine) &&
        (!query || `${p.title} ${p.body} ${p.author}`.toLocaleLowerCase().includes(query)),
    )
    .sort((a, b) =>
      options.sort === 'popular'
        ? b.likes - a.likes || Date.parse(b.createdAt) - Date.parse(a.createdAt)
        : Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
}
export function relativeTime(value: string, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  if (mins < 1440) return `${Math.floor(mins / 60)}시간 전`;
  if (mins < 10080) return `${Math.floor(mins / 1440)}일 전`;
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(
    new Date(value),
  );
}
export function subjectAccuracy(data: AppData) {
  const privacy = data.profile.role === 'PARENT' ? data.child?.privacy : data.profile.privacy;
  if (!privacy?.accuracy) return [];
  return data.subjects.map((subject) => {
    const questionIds = new Set(
      data.questions.filter((q) => q.subjectId === subject.id).map((q) => q.id),
    );
    const essayIds = new Set(
      data.essays.filter((q) => q.subjectId === subject.id).map((q) => q.id),
    );
    const attempts = data.attempts.filter(
      (a) =>
        (a.questionId && questionIds.has(a.questionId)) || (a.essayId && essayIds.has(a.essayId)),
    );
    return {
      id: subject.id,
      name: subject.name,
      count: attempts.length,
      accuracy: attempts.length
        ? Math.round(attempts.reduce((total, a) => total + a.score, 0) / attempts.length)
        : null,
    };
  });
}
