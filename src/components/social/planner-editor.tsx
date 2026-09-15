'use client';
import { useState, type FormEvent } from 'react';
import { ArrowRight, Trash2, TriangleAlert, X } from '@/components/icons';
import { DateField, TimeField } from '@/components/ui-date';
import { api } from '@/lib/api';
import type { AppData, Schedule } from '@/lib/contracts';
import { conflictFixes, formatMinutes, minutes, overlapMinutes, timeString } from '@/lib/schedule';
import { Button, Sheet } from '@/components/ui';
import { dayLabel, josa, particle, recentSchedules, scheduleError } from './helpers';

export type ScheduleDraft = Pick<Schedule, 'title' | 'date' | 'start' | 'end' | 'kind'> & {
  subjectId: string;
};
const DURATIONS = [25, 50, 60, 90];

/** Planner time box: the app's five-minute list instead of the OS time picker. */
export function TimeBox({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <TimeField label={label} name={label} value={value} onChange={onChange} boxed />;
}
/** Planner date chip: the app's month grid instead of the OS date picker. */
export function DateChip({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <DateField label="날짜 바꾸기" name="date" variant="chip" value={value} onChange={(date) => date && onChange(date)} format={(date) => dayLabel(date, 'long')} />;
}

export default function ScheduleEditor({
  data,
  editing,
  initial,
  onClose,
  onSaved,
}: {
  data: AppData;
  editing: Schedule | null;
  initial: ScheduleDraft;
  onClose: () => void;
  onSaved: (date: string, message: string) => Promise<void>;
}) {
  const [form, setForm] = useState<ScheduleDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<ScheduleDraft>) => {
    setForm((current) => ({ ...current, ...patch }));
    setError('');
  };
  const others = data.schedules.filter(
    (s) => s.date.slice(0, 10) === form.date && s.id !== editing?.id,
  );
  const validation = scheduleError(form);
  const timesValid = !scheduleError({ ...form, title: form.title || '-' });
  const overlapping = timesValid
    ? others
        .filter((s) => overlapMinutes(form, s) > 0)
        .sort((a, b) => a.start.localeCompare(b.start))
    : [];
  const fixes = overlapping.length ? conflictFixes(form, others) : {};
  const length = timesValid ? minutes(form.end) - minutes(form.start) : 0;
  const recent = editing
    ? []
    : recentSchedules(data.schedules, 6)
        .filter((s) => s.title.trim() !== form.title.trim())
        .slice(0, 4);
  const blocked = validation
    ? form.title.trim()
      ? validation
      : '일정 이름을 적으면 담을 수 있어요'
    : overlapping.length
      ? '겹치는 시간을 위에서 바꾸면 담을 수 있어요'
      : '';
  const range = `${form.start}–${form.end}`;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (blocked || busy) return;
    setBusy(true);
    setError('');
    try {
      const payload = {
        title: form.title.trim(),
        date: form.date,
        start: form.start,
        end: form.end,
        kind: form.kind,
      };
      if (editing)
        await api(
          `/schedules/${editing.id}`,
          { ...payload, subjectId: form.subjectId || null },
          'PATCH',
        );
      else await api('/schedules', { ...payload, subjectId: form.subjectId || undefined });
      await onSaved(form.date, editing ? `${josa(range, '으로')} 바꿨어요` : `${range}에 담았어요`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!editing || busy) return;
    setBusy(true);
    try {
      await api(`/schedules/${editing.id}`, {}, 'DELETE');
      await onSaved(editing.date.slice(0, 10), '일정을 삭제했어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const first = overlapping[0];
  return (
    <Sheet
      open
      onClose={() => !busy && onClose()}
      title={editing ? '일정 바꾸기' : '일정 추가'}
      description={<DateChip value={form.date} onChange={(date) => set({ date })} />}
    >
      <form onSubmit={save} noValidate className="planner-editor">
        <div className="planner-editor-group">
          <div className="segmented-control" role="group" aria-label="일정 종류">
            {(['FLEXIBLE', 'FIXED'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={form.kind === kind}
                className="segment-option"
                onClick={() => set({ kind })}
              >
                {kind === 'FIXED' ? '고정 일정' : '자율 학습'}
              </button>
            ))}
          </div>
          <p className="planner-help">
            {form.kind === 'FIXED'
              ? '학교·학원처럼 옮길 수 없는 시간이에요 · 추천은 이 시간을 피해요'
              : '완료를 체크하면 오늘 공부 시간에 쌓여요 · 학교·학원은 고정 일정으로'}
          </p>
        </div>
        <div className="planner-editor-group">
          <div className="planner-title-field">
            <input
              autoFocus={!editing}
              className="field"
              maxLength={100}
              aria-label="일정 이름"
              placeholder="예: 생명과학 개념 복습"
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
            />
            {form.title && (
              <button
                type="button"
                className="planner-title-clear"
                aria-label="일정 이름 지우기"
                onClick={() => set({ title: '' })}
              >
                <X size={16} />
              </button>
            )}
          </div>
          {recent.length > 0 && (
            <div className="planner-chip-row" aria-label="최근 일정">
              {recent.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="planner-choice planner-choice-outline"
                  onClick={() =>
                    set({
                      title: s.title,
                      kind: s.kind,
                      subjectId:
                        s.subjectId && data.subjects.some((subject) => subject.id === s.subjectId)
                          ? s.subjectId
                          : '',
                    })
                  }
                >
                  {s.title}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="planner-editor-group">
          <div className="time-range">
            <TimeBox label="시작" value={form.start} onChange={(start) => set({ start })} />
            <ArrowRight size={16} className="text-disabled" aria-hidden="true" />
            <TimeBox label="종료" value={form.end} onChange={(end) => set({ end })} />
          </div>
          <div className="planner-chip-row" role="group" aria-label="길이">
            {DURATIONS.map((duration) => {
              const start = /^\d{2}:\d{2}$/.test(form.start) ? minutes(form.start) : NaN;
              const fits = start + duration <= 23 * 60 + 59;
              return (
                <button
                  key={duration}
                  type="button"
                  className="planner-choice"
                  aria-pressed={length === duration}
                  disabled={!fits}
                  onClick={() => set({ end: timeString(start + duration) })}
                >
                  {formatMinutes(duration)}
                </button>
              );
            })}
          </div>
          {first ? (
            <div className="planner-conflict-box" role="status">
              <p>
                <TriangleAlert size={15} aria-hidden="true" />
                <span>
                  {`${first.title}(${first.start}–${first.end}${first.kind === 'FIXED' ? ', 고정' : ''})${particle(first.title, '과')}`}{' '}
                  {formatMinutes(overlapMinutes(form, first))} 겹쳐요
                  {overlapping.length > 1 ? ` · 외 ${overlapping.length - 1}개` : ''}
                </span>
              </p>
              {(fixes.shrink || fixes.move) && (
                <div className="planner-chip-row">
                  {fixes.shrink && (
                    <button
                      type="button"
                      className="planner-fix-chip"
                      onClick={() => set(fixes.shrink!)}
                    >
                      {josa(`${fixes.shrink.start}–${fixes.shrink.end}`, '으로')} 줄이기
                    </button>
                  )}
                  {fixes.move && (
                    <button
                      type="button"
                      className="planner-fix-chip"
                      onClick={() => set(fixes.move!)}
                    >
                      {josa(`${fixes.move.start}–${fixes.move.end}`, '으로')} 옮기기
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            timesValid && (
              <p className="planner-help">
                {formatMinutes(length)} 동안{' '}
                {form.kind === 'FIXED' ? '고정된 일정이에요' : '공부할 시간이에요'}
              </p>
            )
          )}
        </div>
        {data.subjects.length > 0 && (
          <div className="planner-editor-group">
            <div className="planner-editor-label">
              <span>연결할 과목</span>
              <small>복습 카드 수를 함께 보여 줘요</small>
            </div>
            <div className="planner-chip-row" role="group" aria-label="연결할 과목">
              {[
                ...data.subjects.map((s) => ({ id: s.id, name: s.name })),
                { id: '', name: '과목 없이' },
              ].map((subject) => (
                <button
                  key={subject.id || 'none'}
                  type="button"
                  className="planner-choice"
                  aria-pressed={form.subjectId === subject.id}
                  onClick={() => set({ subjectId: subject.id })}
                >
                  {subject.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="planner-submit">
          <Button type="submit" disabled={busy || !!blocked}>
            {busy
              ? '저장하고 있어요…'
              : editing
                ? `${josa(range, '으로')} 바꾸기`
                : `${range}에 담기`}
          </Button>
          {blocked && <p className="planner-help text-center">{blocked}</p>}
          {editing && (
            <Button type="button" variant="ghost" onClick={remove} disabled={busy}>
              <Trash2 size={17} /> 일정 삭제
            </Button>
          )}
        </div>
      </form>
    </Sheet>
  );
}
