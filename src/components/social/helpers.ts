import type { AppData, Post, Schedule } from '@/lib/contracts';

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
export function minutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
export function durationLabel(start: string, end: string): string {
  const duration = minutes(end) - minutes(start);
  return duration >= 60
    ? `${Math.floor(duration / 60)}시간${duration % 60 ? ` ${duration % 60}분` : ''}`
    : `${duration}분`;
}
export function scheduleGaps(schedules: Schedule[]) {
  const gaps: { beforeId: string; date: string; start: string; end: string }[] = [];
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
    if (minutes(schedule.start) - minutes(occupiedUntil) >= 15) {
      gaps.push({ beforeId: schedule.id, date, start: occupiedUntil, end: schedule.start });
    }
    if (schedule.end > occupiedUntil) occupiedUntil = schedule.end;
  }
  return gaps;
}
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
