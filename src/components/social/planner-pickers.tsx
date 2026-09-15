'use client';
import { useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight } from '@/components/icons';
import { api } from '@/lib/api';
import type { AppData, Schedule } from '@/lib/contracts';
import { overlapMinutes } from '@/lib/schedule';
import { Button, IconButton, Sheet } from '@/components/ui';
import { TimeBox } from './planner-editor';
import {
  dayLabel,
  josa,
  monthGrid,
  scheduleError,
  shiftDate,
  shiftMonth,
  weekDates,
} from './helpers';

export function MonthSheet({
  day,
  today,
  schedules,
  onPick,
  onClose,
}: {
  day: string;
  today: string;
  schedules: Schedule[];
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(`${day.slice(0, 7)}-01`);
  const busy = new Set(schedules.map((s) => s.date.slice(0, 10)));
  const [year, number] = month.split('-').map(Number);
  return (
    <Sheet open onClose={onClose} title="날짜 고르기">
      <div className="month-picker">
        <div className="month-picker-head">
          <IconButton label="이전 달" onClick={() => setMonth(shiftMonth(month, -1))}>
            <ChevronLeft size={20} />
          </IconButton>
          <strong aria-live="polite">
            {year}년 {number}월
          </strong>
          <IconButton label="다음 달" onClick={() => setMonth(shiftMonth(month, 1))}>
            <ChevronRight size={20} />
          </IconButton>
        </div>
        <div className="month-picker-grid" role="grid" aria-label={`${year}년 ${number}월`}>
          <div role="row" className="month-picker-row">
            {'월화수목금토일'.split('').map((name) => (
              <span role="columnheader" key={name} className="month-picker-weekday">
                {name}
              </span>
            ))}
          </div>
          {monthGrid(month).map((week, index) => (
            <div role="row" className="month-picker-row" key={index}>
              {week.map((date, column) =>
                date ? (
                  <button
                    role="gridcell"
                    key={date}
                    className="month-picker-day"
                    aria-selected={date === day}
                    aria-current={date === today ? 'date' : undefined}
                    aria-label={`${dayLabel(date, 'long')}${busy.has(date) ? ', 일정 있음' : ''}`}
                    onClick={() => onPick(date)}
                  >
                    <span>{Number(date.slice(8))}</span>
                    <i data-on={busy.has(date)} />
                  </button>
                ) : (
                  <span role="gridcell" key={`empty-${column}`} />
                ),
              )}
            </div>
          ))}
        </div>
        <Button variant="secondary" className="w-full" onClick={() => onPick(today)}>
          오늘로 이동
        </Button>
      </div>
    </Sheet>
  );
}

const SCHOOL_DAYS = ['월', '화', '수', '목', '금'];
/**
 * Creates the same fixed block on the chosen weekdays. The schedule model has no recurrence, so
 * "repeat" writes one ordinary FIXED schedule per date; past dates and overlapping dates are left
 * out and reported before anything is saved.
 */
export function SchoolSheet({
  data,
  day,
  today,
  onClose,
  onSaved,
}: {
  data: AppData;
  day: string;
  today: string;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('학교');
  const [start, setStart] = useState('08:30');
  const [end, setEnd] = useState('16:00');
  const [weekdays, setWeekdays] = useState([0, 1, 2, 3, 4]);
  const [weeks, setWeeks] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const monday = weekDates(day)[0];
  const dates = Array.from({ length: weeks }, (_, week) =>
    weekDates(shiftDate(monday, week * 7)).filter((_, index) => weekdays.includes(index)),
  )
    .flat()
    .filter((date) => date >= today);
  const clashes = dates.filter((date) =>
    data.schedules.some(
      (s) => s.date.slice(0, 10) === date && overlapMinutes({ start, end }, s) > 0,
    ),
  );
  const targets = dates.filter((date) => !clashes.includes(date));
  const invalid = scheduleError({ title, date: today, start, end });
  const blocked = invalid
    ? invalid
    : !targets.length
      ? dates.length
        ? '고른 날짜가 모두 다른 일정과 겹쳐요'
        : '지난 날짜에는 담지 않아요 · 요일을 골라 주세요'
      : '';
  async function save() {
    if (blocked || busy) return;
    setBusy(true);
    setError('');
    let saved = 0;
    let skipped = clashes.length;
    try {
      for (const date of targets) {
        try {
          await api('/schedules', { title: title.trim(), date, start, end, kind: 'FIXED' });
          saved++;
        } catch (e) {
          if (!/겹쳐요/.test((e as Error).message)) throw e;
          skipped++;
        }
      }
      await onSaved(
        `${josa(title.trim(), '을')} ${saved}일에 담았어요${skipped ? ` · ${skipped}일은 겹쳐서 뺐어요` : ''}`,
      );
    } catch (e) {
      if (!saved) setError((e as Error).message);
      else
        await onSaved(
          `${josa(title.trim(), '을')} ${saved}일에 담았어요 · 나머지는 저장하지 못했어요. ${(e as Error).message}`,
        );
    } finally {
      setBusy(false);
    }
  }
  const thisWeek = weekDates(today)[0] === monday;
  return (
    <Sheet
      open
      onClose={() => !busy && onClose()}
      title="학교 시간부터 담기"
      description="고정 일정으로 담으면 빈 시간과 추천이 이 시간을 피해요"
    >
      <div className="planner-editor">
        <div className="planner-editor-group">
          <input
            className="field"
            aria-label="일정 이름"
            maxLength={100}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="time-range">
            <TimeBox label="시작" value={start} onChange={setStart} />
            <ArrowRight size={16} className="text-disabled" aria-hidden="true" />
            <TimeBox label="종료" value={end} onChange={setEnd} />
          </div>
        </div>
        <div className="planner-editor-group">
          <div className="planner-editor-label">
            <span>요일</span>
            <small>{thisWeek ? '이번 주부터' : `${dayLabel(monday)} 주부터`}</small>
          </div>
          <div className="planner-chip-row" role="group" aria-label="요일">
            {SCHOOL_DAYS.map((name, index) => (
              <button
                key={name}
                type="button"
                className="planner-choice planner-choice-day"
                aria-pressed={weekdays.includes(index)}
                onClick={() =>
                  setWeekdays((current) =>
                    current.includes(index)
                      ? current.filter((value) => value !== index)
                      : [...current, index].sort(),
                  )
                }
              >
                {name}
              </button>
            ))}
          </div>
          <div className="segmented-control" role="group" aria-label="반복">
            {[1, 4].map((count) => (
              <button
                key={count}
                type="button"
                className="segment-option"
                aria-pressed={weeks === count}
                onClick={() => setWeeks(count)}
              >
                {count === 1 ? '한 주만' : '4주 동안'}
              </button>
            ))}
          </div>
          {clashes.length > 0 && (
            <p className="planner-help">
              겹쳐서 빼는 날 ·{' '}
              {clashes
                .map((date) => dayLabel(date))
                .slice(0, 3)
                .join(', ')}
              {clashes.length > 3 ? ` 외 ${clashes.length - 3}일` : ''}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="planner-submit">
          <Button onClick={save} disabled={busy || !!blocked}>
            {busy ? '담고 있어요…' : `${start}–${end} · ${targets.length}일에 담기`}
          </Button>
          {blocked && <p className="planner-help text-center">{blocked}</p>}
        </div>
      </div>
    </Sheet>
  );
}
