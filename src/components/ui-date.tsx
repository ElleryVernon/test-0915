'use client';

// Date and time fields drawn by the app instead of the OS pickers: a month grid sheet and a
// five-minute time list sheet. Values stay the same strings the API uses (YYYY-MM-DD, HH:MM).
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from '@/components/icons';
import { dateLabel, monthGrid, shiftMonth, WEEKDAY_LABELS } from '@/lib/ui-logic';
import { Button, Sheet } from '@/components/ui';

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
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
  weekStartsOn = 0,
  inline = false,
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
  weekStartsOn?: 0 | 1;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const calendarId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const calendar = (
    <MonthPicker
      weekStartsOn={weekStartsOn}
      value={value}
      min={min}
      max={max}
      onPick={(date) => {
        onChange(date);
        close();
      }}
    />
  );
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup={inline ? undefined : 'dialog'}
        aria-controls={inline && open ? calendarId : undefined}
        aria-expanded={open}
        aria-label={`${label}: ${value ? format(value) : '없음'}`}
        data-inline-date-trigger={inline || undefined}
        data-choice="date"
        data-choice-name={name ?? label}
        data-choice-value={value}
        className={variant === 'chip' ? 'planner-date-chip' : 'field choice-field'}
        onClick={() => setOpen(!open)}
      >
        <span className={value ? 'choice-field-value' : 'choice-field-placeholder'}>
          {value ? format(value) : '날짜 없음'}
        </span>
        <ChevronDown size={variant === 'chip' ? 12 : 18} aria-hidden="true" />
      </button>
      {inline ? (
        open && (
          <div
            id={calendarId}
            className="inline-date-picker"
            role="region"
            aria-label={label}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                close();
              }
            }}
          >
            {calendar}
            <p className="planner-help">
              시작할 날짜를 누르면 적용돼요. 지난 날짜는 선택할 수 없어요.
            </p>
          </div>
        )
      ) : (
        <Sheet open={open} onClose={close} title={label}>
          {calendar}
          {clearable && (
            <Button
              variant="ghost"
              className="mt-3 w-full"
              data-date-clear
              onClick={() => {
                onChange('');
                close();
              }}
            >
              날짜 없음
            </Button>
          )}
        </Sheet>
      )}
    </>
  );
}

export function MonthPicker({
  value,
  min,
  max,
  onPick,
  weekStartsOn = 0,
}: {
  weekStartsOn?: 0 | 1;
  value: string;
  min?: string;
  max?: string;
  onPick: (date: string) => void;
}) {
  const today = todayKey();
  const base = value || today;
  const [cursor, setCursor] = useState({
    year: Number(base.slice(0, 4)),
    month: Number(base.slice(5, 7)),
  });
  useEffect(() => {
    const next = value || today;
    setCursor({ year: Number(next.slice(0, 4)), month: Number(next.slice(5, 7)) });
    // Reset the month in view when the value changes from outside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const grid = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);
  const [focused, setFocused] = useState(value || today);
  useEffect(() => {
    if (focusPending.current) {
      grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus();
      focusPending.current = false;
    }
  }, [focused]);
  const cells = monthGrid(cursor.year, cursor.month, {
    today,
    selected: value,
    min,
    max,
    weekStartsOn,
  });
  const monthKey = `${cursor.year}-${String(cursor.month).padStart(2, '0')}`;
  const tabDate =
    cells.find((cell) => cell.date === focused && !cell.disabled)?.date ??
    cells.find((cell) => cell.inMonth && !cell.disabled)?.date;
  return (
    <div className="date-picker" data-month-picker>
      <div className="date-picker-head">
        <button
          type="button"
          aria-label="이전 달"
          disabled={!!min && monthKey <= min.slice(0, 7)}
          onClick={() => setCursor(shiftMonth(cursor.year, cursor.month, -1))}
        >
          <ChevronLeft size={20} />
        </button>
        <p aria-live="polite" data-month-label>
          {cursor.year}년 {cursor.month}월
        </p>
        <button
          type="button"
          aria-label="다음 달"
          disabled={!!max && monthKey >= max.slice(0, 7)}
          onClick={() => setCursor(shiftMonth(cursor.year, cursor.month, 1))}
        >
          <ChevronRight size={20} />
        </button>
      </div>
      <div className="date-picker-weekdays" aria-hidden="true">
        {[...WEEKDAY_LABELS.slice(weekStartsOn), ...WEEKDAY_LABELS.slice(0, weekStartsOn)].map(
          (w) => (
            <span key={w}>{w}</span>
          ),
        )}
      </div>
      <div
        ref={grid}
        className="date-picker-grid"
        role="grid"
        aria-label={`${cursor.year}년 ${cursor.month}월`}
      >
        {Array.from({ length: 6 }, (_, week) => (
          <div role="row" className="date-picker-row" key={week}>
            {cells.slice(week * 7, week * 7 + 7).map((cell, column) => (
              <div role="gridcell" aria-selected={cell.selected} key={cell.date}>
                <button
                  type="button"
                  aria-label={`${dateLabel(cell.date)}${cell.today ? ' 오늘' : ''}${cell.selected ? ', 선택됨' : ''}`}
                  aria-current={cell.today ? 'date' : undefined}
                  disabled={cell.disabled}
                  tabIndex={cell.date === tabDate ? 0 : -1}
                  data-date={cell.date}
                  data-selected={cell.selected}
                  className={`date-picker-day${cell.inMonth ? '' : ' is-outside'}${cell.today ? ' is-today' : ''}`}
                  onFocus={() => setFocused(cell.date)}
                  onKeyDown={(event) => {
                    const delta = {
                      ArrowLeft: -1,
                      ArrowRight: 1,
                      ArrowUp: -7,
                      ArrowDown: 7,
                      Home: -column,
                      End: 6 - column,
                    }[event.key];
                    if (delta === undefined) return;
                    event.preventDefault();
                    const at = new Date(`${cell.date}T12:00:00Z`);
                    at.setUTCDate(at.getUTCDate() + delta);
                    let next = at.toISOString().slice(0, 10);
                    if (min && next < min) next = min;
                    if (max && next > max) next = max;
                    focusPending.current = true;
                    setCursor({ year: Number(next.slice(0, 4)), month: Number(next.slice(5, 7)) });
                    setFocused(next);
                  }}
                  onClick={() => onPick(cell.date)}
                >
                  <span>{cell.day}</span>
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="date-picker-footer">
        <span>
          <i aria-hidden="true" /> 오늘
        </span>
        {(!min || today >= min) && (!max || today <= max) && (
          <button type="button" onClick={() => onPick(today)}>
            오늘 선택
          </button>
        )}
      </div>
    </div>
  );
}

/** A time field (HH:MM): an hour wheel and a minute wheel (5-minute steps) the app draws itself. */
export function TimeField({
  label,
  value,
  onChange,
  step = 5,
  boxed = false,
  name,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  step?: number;
  /** planner style: label above the value */ boxed?: boolean;
  name?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const initial = /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '09:00';
  const [hour, setHour] = useState(initial.slice(0, 2));
  const [minute, setMinute] = useState(initial.slice(3, 5));
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const minutes = [
    ...new Set([
      ...Array.from({ length: 60 / step }, (_, i) => String(i * step).padStart(2, '0')),
      minute,
    ]),
  ].sort();
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const show = () => {
    const current = /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '09:00';
    setHour(current.slice(0, 2));
    setMinute(current.slice(3, 5));
    setOpen(true);
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${value || '없음'}`}
        data-choice="time"
        data-choice-name={name ?? label}
        data-choice-value={value}
        className={boxed ? 'time-box' : 'field choice-field'}
        onClick={show}
      >
        {boxed ? (
          <>
            <span className="time-box-label">{label}</span>
            <span className="time-box-value">{value || '--:--'}</span>
          </>
        ) : (
          <>
            <span className={value ? 'choice-field-value' : 'choice-field-placeholder'}>
              {value || '시각 선택'}
            </span>
            <ChevronDown size={18} aria-hidden="true" />
          </>
        )}
      </button>
      <Sheet open={open} onClose={close} title={label}>
        <p className="time-wheels-value" aria-live="polite" data-time-preview>
          {hour}:{minute}
        </p>
        <div className="time-wheels" data-time-wheels>
          <Wheel
            name="hour"
            label="시"
            values={hours}
            value={hour}
            onChange={setHour}
            suffix="시"
          />
          <Wheel
            name="minute"
            label="분"
            values={minutes}
            value={minute}
            onChange={setMinute}
            suffix="분"
          />
        </div>
        <Button
          className="mt-4 w-full"
          data-time-confirm
          onClick={() => {
            onChange(`${hour}:${minute}`);
            close();
          }}
        >
          {hour}:{minute}로 정하기
        </Button>
      </Sheet>
    </>
  );
}

const WHEEL_ITEM = 44;

/** One drum: items snap to the centre band; scrolling, tapping and arrow keys all select. */
function Wheel({
  name,
  label,
  values,
  value,
  onChange,
  suffix,
}: {
  name: string;
  label: string;
  values: string[];
  value: string;
  onChange: (value: string) => void;
  suffix: string;
}) {
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
          const index = Math.min(
            values.length - 1,
            Math.max(0, Math.round(el.scrollTop / WHEEL_ITEM)),
          );
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
        <div
          key={item}
          id={`wheel-${name}-${item}`}
          role="option"
          aria-selected={item === value}
          data-wheel-value={item}
          className={`time-wheel-item${item === value ? ' is-active' : ''}`}
          onClick={() => pick(index)}
        >
          {item}
          <small>{suffix}</small>
        </div>
      ))}
    </div>
  );
}
