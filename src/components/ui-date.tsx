'use client';

// Date and time fields drawn by the app instead of the OS pickers: a month grid sheet and a
// five-minute time list sheet. Values stay the same strings the API uses (YYYY-MM-DD, HH:MM).
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from '@/components/icons';
import { dateLabel, monthGrid, roundToStep, shiftMonth, timeOptions, WEEKDAY_LABELS } from '@/lib/ui-logic';
import { Button, Sheet } from '@/components/ui';

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** A date field; `clearable` adds a "날짜 없음" choice (exam dates). */
export function DateField({
  label,
  value,
  onChange,
  clearable = false,
  min,
  max,
  variant = 'field',
  name,
  format = dateLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  clearable?: boolean;
  min?: string;
  max?: string;
  /** `chip` is the compact inline trigger of the planner header. */
  variant?: 'field' | 'chip';
  name?: string;
  format?: (value: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${value ? format(value) : '없음'}`}
        data-choice="date"
        data-choice-name={name ?? label}
        data-choice-value={value}
        className={variant === 'chip' ? 'planner-date-chip' : 'field choice-field'}
        onClick={() => setOpen(true)}
      >
        <span className={value ? 'choice-field-value' : 'choice-field-placeholder'}>{value ? format(value) : '날짜 없음'}</span>
        <ChevronDown size={variant === 'chip' ? 12 : 18} aria-hidden="true" />
      </button>
      <Sheet open={open} onClose={close} title={label}>
        <MonthPicker value={value} min={min} max={max} onPick={(date) => { onChange(date); close(); }} />
        {clearable && (
          <Button variant="ghost" className="mt-3 w-full" data-date-clear onClick={() => { onChange(''); close(); }}>
            날짜 없음
          </Button>
        )}
      </Sheet>
    </>
  );
}

export function MonthPicker({ value, min, max, onPick }: { value: string; min?: string; max?: string; onPick: (date: string) => void }) {
  const today = todayKey();
  const base = value || today;
  const [cursor, setCursor] = useState({ year: Number(base.slice(0, 4)), month: Number(base.slice(5, 7)) });
  useEffect(() => {
    const next = value || today;
    setCursor({ year: Number(next.slice(0, 4)), month: Number(next.slice(5, 7)) });
    // Reset the month in view when the value changes from outside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const cells = monthGrid(cursor.year, cursor.month, { today, selected: value, min, max });
  return (
    <div className="date-picker" data-month-picker>
      <div className="date-picker-head">
        <button type="button" aria-label="이전 달" onClick={() => setCursor(shiftMonth(cursor.year, cursor.month, -1))}>
          <ChevronLeft size={20} />
        </button>
        <p aria-live="polite" data-month-label>
          {cursor.year}년 {cursor.month}월
        </p>
        <button type="button" aria-label="다음 달" onClick={() => setCursor(shiftMonth(cursor.year, cursor.month, 1))}>
          <ChevronRight size={20} />
        </button>
      </div>
      <div className="date-picker-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="date-picker-grid" role="grid" aria-label={`${cursor.year}년 ${cursor.month}월`}>
        {cells.map((cell) => (
          <button
            key={cell.date}
            type="button"
            role="gridcell"
            aria-label={`${dateLabel(cell.date)}${cell.today ? ' 오늘' : ''}`}
            aria-selected={cell.selected}
            aria-current={cell.today ? 'date' : undefined}
            disabled={cell.disabled}
            data-date={cell.date}
            className={`date-picker-day${cell.inMonth ? '' : ' is-outside'}${cell.today ? ' is-today' : ''}`}
            onClick={() => onPick(cell.date)}
          >
            <span>{cell.day}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A time field (HH:MM): an hour wheel and a minute wheel (5-minute steps) the app draws itself. */
export function TimeField({ label, value, onChange, step = 5, boxed = false, name }: { label: string; value: string; onChange: (value: string) => void; step?: number; /** planner style: label above the value */ boxed?: boolean; name?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const initial = roundToStep(value || '09:00', step) || '09:00';
  const [hour, setHour] = useState(initial.slice(0, 2));
  const [minute, setMinute] = useState(initial.slice(3, 5));
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const minutes = Array.from({ length: 60 / step }, (_, i) => String(i * step).padStart(2, '0'));
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const show = () => {
    const current = roundToStep(value || '09:00', step) || '09:00';
    setHour(current.slice(0, 2));
    setMinute(current.slice(3, 5));
    setOpen(true);
  };
  return (
    <>
      <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}: ${value || '없음'}`} data-choice="time" data-choice-name={name ?? label} data-choice-value={value} className={boxed ? 'time-box' : 'field choice-field'} onClick={show}>
        {boxed ? (
          <>
            <span className="time-box-label">{label}</span>
            <span className="time-box-value">{value || '--:--'}</span>
          </>
        ) : (
          <>
            <span className={value ? 'choice-field-value' : 'choice-field-placeholder'}>{value || '시각 선택'}</span>
            <ChevronDown size={18} aria-hidden="true" />
          </>
        )}
      </button>
      <Sheet open={open} onClose={close} title={label}>
        <p className="time-wheels-value" aria-live="polite" data-time-preview>
          {hour}:{minute}
        </p>
        <div className="time-wheels" data-time-wheels>
          <Wheel name="hour" label="시" values={hours} value={hour} onChange={setHour} suffix="시" />
          <Wheel name="minute" label="분" values={minutes} value={minute} onChange={setMinute} suffix="분" />
        </div>
        <Button className="mt-4 w-full" data-time-confirm onClick={() => { onChange(`${hour}:${minute}`); close(); }}>
          {hour}:{minute}로 정하기
        </Button>
      </Sheet>
    </>
  );
}

const WHEEL_ITEM = 44;

/** One drum: items snap to the centre band; scrolling, tapping and arrow keys all select. */
function Wheel({ name, label, values, value, onChange, suffix }: { name: string; label: string; values: string[]; value: string; onChange: (value: string) => void; suffix: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Put the current value in the band when the sheet opens; later changes come from the wheel itself.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const index = Math.max(0, values.indexOf(value));
    if (Math.abs(el.scrollTop - index * WHEEL_ITEM) > 1) el.scrollTop = index * WHEEL_ITEM;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pick = (index: number, smooth = true) => {
    const el = ref.current;
    const clamped = Math.min(values.length - 1, Math.max(0, index));
    el?.scrollTo({ top: clamped * WHEEL_ITEM, behavior: smooth ? 'smooth' : 'auto' });
    onChange(values[clamped]);
  };
  return (
    <div
      ref={ref}
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={`wheel-${name}-${value}`}
      data-wheel={name}
      className="time-wheel"
      onScroll={() => {
        clearTimeout(settle.current);
        // jitter: none — UI only: this 80 ms scroll-settle timer and the requestAnimationFrame focus restores send nothing [site src/components/ui-date.tsx:204]
        settle.current = setTimeout(() => {
          const el = ref.current;
          if (!el) return;
          const index = Math.min(values.length - 1, Math.max(0, Math.round(el.scrollTop / WHEEL_ITEM)));
          if (values[index] !== value) onChange(values[index]);
        }, 80);
      }}
      onKeyDown={(e) => {
        const index = values.indexOf(value);
        if (e.key === 'ArrowDown') pick(index + 1);
        else if (e.key === 'ArrowUp') pick(index - 1);
        else if (e.key === 'Home') pick(0);
        else if (e.key === 'End') pick(values.length - 1);
        else return;
        e.preventDefault();
      }}
    >
      {values.map((item, index) => (
        <div key={item} id={`wheel-${name}-${item}`} role="option" aria-selected={item === value} data-wheel-value={item} className={`time-wheel-item${item === value ? ' is-active' : ''}`} onClick={() => pick(index)}>
          {item}
          <small>{suffix}</small>
        </div>
      ))}
    </div>
  );
}
