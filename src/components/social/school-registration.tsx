'use client';
import { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from '@/components/icons';
import type { AppData } from '@/lib/contracts';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import { DateField } from '@/components/ui-date';
import { useJourneyState } from '../journey';
import { dayLabel } from './helpers';
import {
  normalizeSchoolTime,
  previewSchoolRegistration,
  schoolPeriodEnd,
  schoolRegistrationError,
  SCHOOL_WEEKDAYS,
  type SchoolHours,
  type SchoolRegistration,
} from '@/lib/school-schedule';

function SchoolTimeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="school-time-input">
      <span>{label}</span>
      <input
        aria-label={label}
        inputMode="numeric"
        autoComplete="off"
        placeholder={label.includes('하교') ? '16:00' : '08:30'}
        maxLength={5}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^\d:]/g, ''))}
        onBlur={() => {
          const normalized = normalizeSchoolTime(value);
          if (normalized && normalized !== value) onChange(normalized);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

export function SchoolRegistrationForm({
  data,
  day,
  today,
  onSaved,
  onBusyChange,
  onViewDate,
}: {
  data: AppData;
  day: string;
  today: string;
  onSaved: (message: string, date: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onViewDate: (date: string) => void;
}) {
  const [form, setForm] = useJourneyState<SchoolRegistration>('planner.schoolRegistration', () => ({
    title: '학교',
    from: day < today ? today : day,
    weeks: 1,
    weekdays: [0, 1, 2, 3, 4],
    hours: { start: '08:30', end: '16:00' },
    differentHours: false,
    byDay: {},
  }));
  const [receipt, setReceipt] = useJourneyState<{ message: string; date: string } | null>(
    'planner.schoolReceiptV2',
    null,
  );
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewId = useId();
  const [progress, setProgress] = useState({ saved: 0, total: 0 });
  const [error, setError] = useState('');
  const [known, setKnown] = useState(data.schedules);
  const [attempted, setAttempted] = useState(false);
  const set = (patch: Partial<SchoolRegistration>) => {
    if (!busy && !receipt) {
      setForm((current) => ({ ...current, ...patch }));
      setError('');
    }
  };
  const setHours = (hours: SchoolHours, weekday?: number) =>
    weekday === undefined ? set({ hours }) : set({ byDay: { ...form.byDay, [weekday]: hours } });
  const invalid = schoolRegistrationError(form, today);
  const rows = previewSchoolRegistration(form, known, today);
  const targets = rows.filter((row) => row.status === 'new');
  const existing = rows.filter((row) => row.status === 'existing');
  const conflicts = rows.filter((row) => row.status === 'conflict');
  const allExisting = rows.length > 0 && existing.length === rows.length;
  const blocked =
    invalid ||
    (!targets.length
      ? existing.length && !conflicts.length
        ? '선택한 날짜에 이미 등록되어 있어요.'
        : '등록할 수 있는 날이 없어요. 아래 날짜를 확인하고 시간이나 요일을 바꿔 주세요.'
      : '');
  const periodEnd = !schoolRegistrationError(
    {
      ...form,
      title: '학교',
      weekdays: [0],
      hours: { start: '08:30', end: '16:00' },
      differentHours: false,
    },
    today,
  )
    ? schoolPeriodEnd(form)
    : '';
  async function save() {
    if (busy || (!receipt && blocked)) return;
    setBusy(true);
    onBusyChange(true);
    setError('');
    let saved = 0;
    try {
      if (receipt) {
        await onSaved(receipt.message, receipt.date);
        setReceipt(null);
        return;
      }
      // Refresh the exact dates before writing. A retry after a lost response sees existing rows.
      const current = await api<AppData>('/bootstrap');
      setKnown(current.schedules);
      const checked = previewSchoolRegistration(form, current.schedules, today);
      const pending = checked.filter((row) => row.status === 'new');
      setProgress({ saved: 0, total: pending.length });
      let skipped = checked.filter((row) => row.status !== 'new').length;
      for (const row of pending) {
        try {
          await api('/schedules', {
            title: form.title.trim(),
            date: row.date,
            start: row.start,
            end: row.end,
            kind: 'FIXED',
          });
          saved++;
          setProgress({ saved, total: pending.length });
        } catch (e) {
          if (!/겹쳐요/.test((e as Error).message)) throw e;
          skipped++;
        }
      }
      const message = saved
        ? `학교 시간 ${saved}일을 등록했어요${skipped ? ` · 기존 일정이 있는 ${skipped}일은 유지했어요` : ''}`
        : '이미 있는 일정을 확인했어요. 새로 등록한 일정은 없어요.';
      const savedDate = pending[0]?.date ?? checked[0]?.date ?? form.from;
      setReceipt({ message, date: savedDate });
      await onSaved(message, savedDate);
      setReceipt(null);
    } catch (e) {
      setAttempted(true);
      setError(
        `${saved ? `${saved}일은 등록했어요. 다시 시도하면 등록된 날은 건너뛰어요. ` : ''}${(e as Error).message}`,
      );
      try {
        const current = await api<AppData>('/bootstrap');
        setKnown(current.schedules);
      } catch {
        /* Explicit retry re-reads first. */
      }
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  const hoursFields = (hours: SchoolHours, weekday?: number) => (
    <div className="school-hours-row">
      <SchoolTimeInput
        label={weekday === undefined ? '등교 시간' : `${SCHOOL_WEEKDAYS[weekday]}요일 등교`}
        value={hours.start}
        onChange={(start) => setHours({ ...hours, start }, weekday)}
      />
      <span aria-hidden="true">–</span>
      <SchoolTimeInput
        label={weekday === undefined ? '하교 시간' : `${SCHOOL_WEEKDAYS[weekday]}요일 하교`}
        value={hours.end}
        onChange={(end) => setHours({ ...hours, end }, weekday)}
      />
    </div>
  );
  return (
    <div className="planner-editor school-registration">
      <fieldset disabled={busy || !!receipt} className="contents">
        <section className="planner-editor-group">
          <h3 className="school-section-title">언제부터 등록할까요?</h3>
          <DateField
            inline
            label="등록 시작일"
            value={form.from}
            min={today}
            weekStartsOn={1}
            onChange={(from) => set({ from })}
            format={(date) => dayLabel(date, 'long')}
          />
          <div className="segmented-control" role="group" aria-label="등록 기간">
            {[1, 4].map((weeks) => (
              <button
                type="button"
                className="segment-option"
                aria-pressed={form.weeks === weeks}
                key={weeks}
                onClick={() => set({ weeks })}
              >
                {weeks}주
              </button>
            ))}
          </div>
          {periodEnd && (
            <p className="planner-help">
              {dayLabel(form.from)} ~ {dayLabel(periodEnd)} · 이 기간의 등교일만 등록해요
            </p>
          )}
        </section>
        <section className="planner-editor-group">
          <div className="planner-editor-label">
            <h3 className="school-section-title">등교하는 요일</h3>
            <button
              type="button"
              className="planner-header-chip"
              onClick={() => set({ weekdays: [0, 1, 2, 3, 4] })}
            >
              월–금 선택
            </button>
          </div>
          <div className="school-weekdays" role="group" aria-label="등교 요일">
            {SCHOOL_WEEKDAYS.map((name, index) => (
              <button
                type="button"
                key={name}
                className="planner-choice"
                aria-label={`${name}요일`}
                aria-pressed={form.weekdays.includes(index)}
                onClick={() =>
                  set({
                    weekdays: form.weekdays.includes(index)
                      ? form.weekdays.filter((d) => d !== index)
                      : [...form.weekdays, index].sort(),
                  })
                }
              >
                {name}
              </button>
            ))}
          </div>
        </section>
        <section className="planner-editor-group">
          <h3 className="school-section-title">학교에 있는 시간</h3>
          <div
            className="segmented-control school-time-mode"
            role="group"
            aria-label="등하교 시간 설정 방식"
          >
            <button
              type="button"
              className="segment-option"
              aria-pressed={!form.differentHours}
              onClick={() => set({ differentHours: false })}
            >
              매일 같은 시간
            </button>
            <button
              type="button"
              className="segment-option"
              aria-pressed={form.differentHours}
              onClick={() => set({ differentHours: true })}
            >
              요일별 설정
            </button>
          </div>
          {!form.differentHours && hoursFields(form.hours)}
          <p className="planner-help">숫자만 입력해도 돼요 · 0830 → 08:30</p>
          {form.differentHours &&
            form.weekdays.map((weekday) => (
              <div key={weekday} className="school-day-hours">
                {hoursFields(form.byDay[weekday] ?? form.hours, weekday)}
              </div>
            ))}
        </section>
        <label className="school-name">
          <span>시간표에 표시할 이름</span>
          <input
            aria-label="학교 일정 이름"
            className="field"
            maxLength={100}
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
          />
        </label>
      </fieldset>
      {!invalid && (
        <section className="school-preview" aria-label="등록할 날짜 확인">
          <button
            type="button"
            className="school-preview-toggle"
            aria-expanded={previewOpen}
            aria-controls={previewId}
            onClick={() => setPreviewOpen(!previewOpen)}
          >
            <span className="school-preview-heading">
              <strong>등록할 날짜</strong>
              <span>
                {targets.length
                  ? `${targets.length}일 등록 예정`
                  : allExisting
                    ? '모두 등록되어 있어요'
                    : '등록할 날짜를 확인해 주세요'}
              </span>
            </span>
            <ChevronDown size={18} aria-hidden="true" />
          </button>
          {(existing.length > 0 || conflicts.length > 0) && (
            <p className="school-preview-note">
              {[
                existing.length ? `이미 등록 ${existing.length}일` : '',
                conflicts.length ? `시간 겹침 ${conflicts.length}일` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
              {' — 기존 일정은 유지해요'}
            </p>
          )}
          {previewOpen && (
            <div id={previewId}>
              <ul className="school-preview-list">
                {rows.map((row) => (
                  <li key={row.date}>
                    <div className="school-preview-row">
                      <div className="school-preview-date">
                        <strong>{dayLabel(row.date)}</strong>
                        <span>
                          {row.start}–{row.end}
                        </span>
                      </div>
                      <span className="school-preview-status" data-status={row.status}>
                        {row.status === 'new'
                          ? '등록 예정'
                          : row.status === 'existing'
                            ? '이미 등록'
                            : '겹쳐서 제외'}
                      </span>
                    </div>
                    {row.status === 'conflict' && (
                      <p className="school-preview-conflict">
                        {row.conflicts.map((s) => `${s.title} ${s.start}–${s.end}`).join(', ')}과
                        시간이 겹쳐요.
                      </p>
                    )}
                    {row.status !== 'new' && (
                      <button
                        type="button"
                        className="school-preview-link"
                        disabled={busy}
                        aria-label={`${dayLabel(row.date)} 시간표 보기`}
                        onClick={() => onViewDate(row.date)}
                      >
                        시간표 보기 <ChevronRight size={14} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {conflicts.length > 0 && (
                <p className="planner-help">겹치는 날은 이번 등록에서 제외해요.</p>
              )}
            </div>
          )}
        </section>
      )}
      <p className="planner-help">
        닫아도 입력은 남아요. 등록 후에는 시간표에서 날짜별로 수정하거나 삭제할 수 있어요.
      </p>
      {receipt && <p role="status">{receipt.message}</p>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="planner-submit">
        <Button
          onClick={() => (allExisting && !receipt ? onViewDate(rows[0].date) : void save())}
          disabled={busy || (!receipt && !!blocked && !allExisting)}
        >
          {busy
            ? progress.total
              ? `${progress.saved}/${progress.total}일 등록 중…`
              : '등록할 날짜 확인 중…'
            : receipt
              ? '등록한 시간표 확인하기'
              : allExisting
                ? '등록한 시간표 보기'
                : invalid
                  ? '입력 내용을 확인해 주세요'
                  : !targets.length
                    ? '등록할 날짜를 확인해 주세요'
                    : `${targets.length}일 학교 시간 등록`}
        </Button>
        {!receipt && blocked && (
          <p className="planner-help" role={attempted ? 'alert' : undefined}>
            {blocked}
          </p>
        )}
        {conflicts.length > 0 && !blocked && (
          <p className="planner-help">
            겹치는 {conflicts.length}일을 제외하고 등록해요. 위에서 날짜를 확인해 주세요.
          </p>
        )}
      </div>
    </div>
  );
}
