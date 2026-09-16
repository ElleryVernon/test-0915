import type { Schedule } from './contracts';
import { overlapMinutes } from './schedule';

export const SCHOOL_WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];
export type SchoolHours = { start: string; end: string };
export interface SchoolRegistration {
  title: string;
  from: string;
  weeks: number;
  weekdays: number[];
  hours: SchoolHours;
  differentHours: boolean;
  byDay: Record<number, SchoolHours>;
}
export function normalizeSchoolTime(value: string) {
  const compact = value.trim();
  const match = compact.match(/^(\d{1,2}):(\d{2})$/) ?? compact.match(/^(\d{1,2})(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return '';
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}
function shift(date: string, days: number) {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
export function schoolPeriodEnd(form: Pick<SchoolRegistration, 'from' | 'weeks'>) {
  return shift(form.from, form.weeks * 7 - 1);
}
export function schoolRegistrationError(form: SchoolRegistration, today: string) {
  if (!form.title.trim()) return '일정 이름을 입력해 주세요.';
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(form.from) ||
    !Number.isFinite(Date.parse(`${form.from}T12:00:00Z`)) ||
    shift(form.from, 0) !== form.from
  )
    return '시작 날짜를 확인해 주세요.';
  if (form.from < today) return '오늘 이후의 시작 날짜를 골라 주세요.';
  if (![1, 4].includes(form.weeks)) return '등록 기간을 골라 주세요.';
  if (!form.weekdays.length) return '등교하는 요일을 하나 이상 골라 주세요.';
  for (const day of form.weekdays) {
    if (!Number.isInteger(day) || day < 0 || day > 6) return '등교 요일을 확인해 주세요.';
    const hours = form.differentHours ? (form.byDay[day] ?? form.hours) : form.hours;
    const start = normalizeSchoolTime(hours.start),
      end = normalizeSchoolTime(hours.end);
    const prefix = form.differentHours ? `${SCHOOL_WEEKDAYS[day]}요일 ` : '';
    if (!start || !end) return `${prefix}시간을 0830 또는 08:30처럼 입력해 주세요.`;
    if (end <= start) return `${prefix}하교 시간은 등교 시간보다 늦어야 해요.`;
  }
  return '';
}
export type SchoolPreview = SchoolHours & {
  date: string;
  status: 'new' | 'existing' | 'conflict';
  conflicts: Schedule[];
};
export function previewSchoolRegistration(
  form: SchoolRegistration,
  schedules: Schedule[],
  today: string,
): SchoolPreview[] {
  if (schoolRegistrationError(form, today)) return [];
  const result: SchoolPreview[] = [];
  for (let i = 0; i < form.weeks * 7; i++) {
    const date = shift(form.from, i);
    const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
    if (!form.weekdays.includes(weekday)) continue;
    const raw = form.differentHours ? (form.byDay[weekday] ?? form.hours) : form.hours;
    const hours = { start: normalizeSchoolTime(raw.start), end: normalizeSchoolTime(raw.end) };
    const conflicts = schedules.filter(
      (s) => s.date.slice(0, 10) === date && overlapMinutes(hours, s) > 0,
    );
    const existing = conflicts.some(
      (s) =>
        s.kind === 'FIXED' &&
        s.title.trim() === form.title.trim() &&
        s.start === hours.start &&
        s.end === hours.end,
    );
    result.push({
      date,
      ...hours,
      status: existing ? 'existing' : conflicts.length ? 'conflict' : 'new',
      conflicts,
    });
  }
  return result;
}
