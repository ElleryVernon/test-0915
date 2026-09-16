'use client';
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from '@/components/icons';
import type { Schedule } from '@/lib/contracts';
import { Button, IconButton, Sheet } from '@/components/ui';
import { dayLabel, monthGrid, shiftMonth } from './helpers';

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
