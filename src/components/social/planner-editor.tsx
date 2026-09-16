'use client';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Trash2, TriangleAlert, X } from '@/components/icons';
import { DateField, TimeField } from '@/components/ui-date';
import { api } from '@/lib/api';
import type { AppData, Schedule } from '@/lib/contracts';
import {
  conflictFixes,
  formatMinutes,
  minutes,
  moveScheduleStart,
  overlapMinutes,
  timeString,
} from '@/lib/schedule';
import { Button, Sheet } from '@/components/ui';
import { dayLabel, josa, particle, recentSchedules, scheduleError } from './helpers';

export type ScheduleDraft = Pick<Schedule, 'title' | 'date' | 'start' | 'end' | 'kind'> & {
  subjectId: string;
};
export type ScheduleReceipt = { date: string; message: string };
const DURATIONS = [25, 50, 60, 90];

/** Planner time box: the app's five-minute list instead of the OS time picker. */
export function TimeBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return <TimeField label={label} name={label} value={value} onChange={onChange} boxed />;
}
/** Planner date chip: the app's month grid instead of the OS date picker. */
export function DateChip({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <DateField
      label="날짜 바꾸기"
      weekStartsOn={1}
      name="date"
      variant="chip"
      value={value}
      onChange={(date) => date && onChange(date)}
      format={(date) => dayLabel(date, 'long')}
    />
  );
}

export default function ScheduleEditor({
  data,
  editing,
  initial,
  hasDraft,
  schoolPanel,
  schoolBusy,
  onClose,
  onSaved,
  onDraft,
  onDiscard,
  receipt: initialReceipt,
}: {
  data: AppData;
  editing: Schedule | null;
  initial: ScheduleDraft;
  hasDraft: boolean;
  schoolPanel: ReactNode;
  schoolBusy: boolean;
  onClose: () => void;
  onSaved: (date: string, message: string) => Promise<void>;
  onDraft: (draft: ScheduleDraft, receipt?: ScheduleReceipt) => void;
  onDiscard: () => void;
  receipt?: ScheduleReceipt;
}) {
  const [tab, setTab] = useState<'single' | 'school'>('single');
  const tabId = useId();
  const [form, setForm] = useState<ScheduleDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(initialReceipt);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (patch: Partial<ScheduleDraft>) => {
    if (busy || receipt) return;
    const next = { ...form, ...patch };
    if ((Object.keys(patch) as (keyof ScheduleDraft)[]).every((key) => form[key] === next[key]))
      return;
    setForm(next);
    onDraft(next);
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
    if (busy || (!receipt && blocked)) return;
    setBusy(true);
    setError('');
    try {
      if (receipt) {
        await onSaved(receipt.date, receipt.message);
        return;
      }
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
      const saved = {
        date: form.date,
        message: editing ? `${josa(range, '으로')} 바꿨어요` : `${range}에 담았어요`,
      };
      setReceipt(saved);
      onDraft(form, saved);
      await onSaved(saved.date, saved.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!editing || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/schedules/${editing.id}`, {}, 'DELETE');
      const saved = { date: editing.date.slice(0, 10), message: '일정을 삭제했어요' };
      setReceipt(saved);
      onDraft(form, saved);
      setConfirmDelete(false);
      await onSaved(saved.date, saved.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const first = overlapping[0];
  return (
    <>
      <Sheet
        open
        adaptiveHeight
        onClose={() => !busy && !schoolBusy && onClose()}
        title={editing ? '일정 바꾸기' : '일정 추가'}
        description={
          <div className="planner-registration-description">
            {tab === 'single' ? (
              <DateChip value={form.date} onChange={(date) => set({ date })} />
            ) : (
              '등교하는 요일과 시간을 한 번에 등록해요.'
            )}
          </div>
        }
      >
        {!editing && (
          <div className="planner-registration-tabs" role="tablist" aria-label="추가할 일정">
            {(['single', 'school'] as const).map((value, index) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`${tabId}-${value}-tab`}
                aria-selected={tab === value}
                aria-controls={`${tabId}-${value}-panel`}
                tabIndex={tab === value ? 0 : -1}
                disabled={busy || schoolBusy || !!receipt}
                onClick={() => setTab(value)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 'single'
                      : event.key === 'End'
                        ? 'school'
                        : index === 0
                          ? 'school'
                          : 'single';
                  setTab(next);
                  document.getElementById(`${tabId}-${next}-tab`)?.focus();
                }}
              >
                {value === 'single' ? '일정' : '학교 시간'}
              </button>
            ))}
          </div>
        )}
        <div
          className="planner-registration-panel"
          id={`${tabId}-single-panel`}
          role={editing ? undefined : 'tabpanel'}
          aria-labelledby={editing ? undefined : `${tabId}-single-tab`}
          hidden={tab !== 'single'}
        >
          <form onSubmit={save} noValidate className="planner-editor">
            <p className="planner-help">
              {receipt
                ? '저장된 일정이 있어요. 다시 불러오면 시간표에 반영돼요.'
                : '닫아도 이 시간표에 초안이 남아요. 저장 버튼을 눌러야 일정에 반영돼요.'}
            </p>
            <fieldset disabled={busy || !!receipt} className="contents">
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
                    ? '선택한 날짜의 고정 일정이에요 · 다른 날짜는 함께 바뀌지 않아요'
                    : '완료를 체크하면 이 날짜의 공부 시간에 쌓여요'}
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
                              s.subjectId &&
                              data.subjects.some((subject) => subject.id === s.subjectId)
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
                  <TimeBox
                    label="시작"
                    value={form.start}
                    onChange={(start) => set(moveScheduleStart(form, start))}
                  />
                  <ArrowRight size={16} className="text-disabled" aria-hidden="true" />
                  <TimeBox label="종료" value={form.end} onChange={(end) => set({ end })} />
                </div>
                {form.end === '23:59' && (
                  <p className="planner-help">
                    이 날짜의 마지막 시각은 23:59예요. 자정을 넘는 일정은 날짜별로 나눠 담아 주세요.
                  </p>
                )}
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
            </fieldset>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div className="planner-submit">
              <Button type="submit" disabled={busy || (!receipt && !!blocked)}>
                {busy
                  ? '저장하고 있어요…'
                  : receipt
                    ? '저장한 일정 다시 불러오기'
                    : editing
                      ? `${josa(range, '으로')} 바꾸기`
                      : `${range}에 담기`}
              </Button>
              {!receipt && blocked && <p className="planner-help text-center">{blocked}</p>}
              {!receipt && hasDraft && (
                <Button type="button" variant="ghost" onClick={onDiscard} disabled={busy}>
                  초안 버리기
                </Button>
              )}
              {editing && !receipt && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                >
                  <Trash2 size={17} /> 일정 삭제
                </Button>
              )}
            </div>
          </form>
        </div>
        {!editing && (
          <div
            className="planner-registration-panel"
            id={`${tabId}-school-panel`}
            role="tabpanel"
            aria-labelledby={`${tabId}-school-tab`}
            hidden={tab !== 'school'}
          >
            {schoolPanel}
          </div>
        )}
      </Sheet>
      {confirmDelete && editing && (
        <Sheet open onClose={() => !busy && setConfirmDelete(false)} title="이 일정을 삭제할까요?">
          <p className="mb-4">
            {dayLabel(editing.date.slice(0, 10), 'long')} · {editing.start}–{editing.end}
            <br />
            {editing.title}
          </p>
          <p className="planner-help mb-4">
            이 날짜의 일정만 삭제해요. 삭제한 일정은 되돌릴 수 없어요.
          </p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} disabled={busy}>
              유지하기
            </Button>
            <Button onClick={remove} disabled={busy}>
              {busy ? '삭제 중…' : '일정 삭제하기'}
            </Button>
          </div>
        </Sheet>
      )}
    </>
  );
}
