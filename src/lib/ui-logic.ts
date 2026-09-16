// Pure logic behind the shared controls (src/components/ui-choice.tsx, ui-date.tsx): month grids,
// five-minute time lists, stepper and slider arithmetic, and inline validation messages. No DOM —
// tests/ui-logic.test.ts covers every rule and scripts/ui-logic-mutation.mjs proves the tests bite.

export type DayCell = {
  date: string;
  day: number;
  inMonth: boolean;
  today: boolean;
  selected: boolean;
  disabled: boolean;
  weekday: number;
};

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (year: number, month: number, day: number) =>
  `${year}-${pad(month)}-${pad(day)}`;

/** Days in a month (month is 1–12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Weekday (0 = Sunday) of an ISO date, computed on the UTC calendar so the zone never shifts it. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Six weeks of cells for a month picker; days outside the month fill the first and last rows. */
export function monthGrid(
  year: number,
  month: number,
  options: {
    today?: string;
    selected?: string;
    min?: string;
    max?: string;
    weekStartsOn?: 0 | 1;
  } = {},
): DayCell[] {
  const first = (weekdayOf(isoDate(year, month, 1)) - (options.weekStartsOn ?? 0) + 7) % 7;
  const cells: DayCell[] = [];
  const start = new Date(Date.UTC(year, month - 1, 1 - first));
  for (let i = 0; i < 42; i++) {
    const at = new Date(start.getTime() + i * 86_400_000);
    const date = isoDate(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
    cells.push({
      date,
      day: at.getUTCDate(),
      inMonth: at.getUTCMonth() + 1 === month && at.getUTCFullYear() === year,
      today: date === options.today,
      selected: date === options.selected,
      disabled: (!!options.min && date < options.min) || (!!options.max && date > options.max),
      weekday: at.getUTCDay(),
    });
  }
  return cells;
}

/** The month `delta` months away from year/month. */
export function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

/** "9월 15일 (화)" for a picker heading; "" for an empty value. */
export function dateLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const [, m, d] = date.split('-').map(Number);
  return `${m}월 ${d}일 (${WEEKDAY_LABELS[weekdayOf(date)]})`;
}

/** Every time from `from` to `to` inclusive at `step` minutes: 00:00, 00:05, … */
export function timeOptions(step = 5, from = '00:00', to = '23:55'): string[] {
  const out: string[] = [];
  for (let m = toMinutes(from); m <= toMinutes(to); m += step) out.push(fromMinutes(m));
  return out;
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
export function fromMinutes(total: number): string {
  const clamped = Math.min(Math.max(total, 0), 23 * 60 + 59);
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

/** Nearest step: 09:07 → 09:05, 09:08 → 09:10; the day never wraps (23:58 → 23:55). */
export function roundToStep(time: string, step = 5): string {
  if (!/^\d{2}:\d{2}$/.test(time)) return '';
  const rounded = Math.round(toMinutes(time) / step) * step;
  return fromMinutes(Math.min(rounded, Math.floor((23 * 60 + 59) / step) * step));
}

/** Stepper: snap to the step grid from `min`, then clamp; a non-number falls back to min. */
export function clampStep(
  value: number,
  options: { min: number; max: number; step?: number },
): number {
  const step = options.step ?? 1;
  if (!Number.isFinite(value)) return options.min;
  const snapped = options.min + Math.round((value - options.min) / step) * step;
  return Math.min(options.max, Math.max(options.min, snapped));
}

/** Keyboard on a slider thumb (WAI-ARIA): arrows step, Page keys jump ten steps, Home/End hit the ends. */
export function sliderKey(
  value: number,
  key: string,
  options: { min: number; max: number; step?: number },
): number {
  const step = options.step ?? 1;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clampStep(value + step, options);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampStep(value - step, options);
    case 'PageUp':
      return clampStep(value + step * 10, options);
    case 'PageDown':
      return clampStep(value - step * 10, options);
    case 'Home':
      return options.min;
    case 'End':
      return options.max;
    default:
      return value;
  }
}

/** Slider position as a percentage for the filled track. */
export function sliderPercent(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

export type FieldRule = {
  label: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  patternMessage?: string;
};

const hasBatchim = (word: string) => {
  const code = word.charCodeAt(word.length - 1);
  return code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 !== 0 : false;
};
/** 을/를 particle for a label. */
export const objectParticle = (word: string) => (hasBatchim(word) ? '을' : '를');

/** Inline validation instead of the browser bubble: the first broken rule's message, or ''. */
export function validationMessage(value: string, rule: FieldRule): string {
  const trimmed = value.trim();
  if (rule.required && !trimmed) return `${rule.label}${objectParticle(rule.label)} 입력해 주세요.`;
  if (rule.minLength !== undefined && trimmed && [...trimmed].length < rule.minLength)
    return `${rule.label}${objectParticle(rule.label)} ${rule.minLength}자 이상 입력해 주세요.`;
  if (rule.maxLength !== undefined && [...trimmed].length > rule.maxLength)
    return `${rule.label}${objectParticle(rule.label)} ${rule.maxLength}자 이내로 줄여 주세요.`;
  if (rule.pattern && trimmed && !rule.pattern.test(trimmed))
    return rule.patternMessage ?? `${rule.label} 형식이 맞지 않아요.`;
  return '';
}
