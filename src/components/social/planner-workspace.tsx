'use client';
import { useState } from 'react';
import { ChevronLeft, ChevronRight, Plus } from '@/components/icons';
import { Button, Sheet } from '@/components/ui';
import { OptionField, Stepper, Switch } from '@/components/ui-choice';
import { DateField, TimeField } from '@/components/ui-date';
import { api, ApiError } from '@/lib/api';
import type { AppData } from '@/lib/contracts';
import { formatMinutes } from '@/lib/schedule';
import { isDue } from '@/lib/srs';
import {
  WEEKDAYS,
  planWeekday,
  shiftPlanDate,
  validDate,
  weeklyInputError,
  weeklyPlans,
  remainingWeeklyNeeds,
  weeklyBatchPayload,
  type WeeklyInput,
  type PendingWeeklyPlan,
  type WeeklyPlan,
  type WeeklyNeed,
  type AcademyGroup,
  type AcademyOption,
} from '@/lib/planner-workspace';
import { useJourneyState } from '../journey';
import { dayLabel, dateKey } from './helpers';
import styles from './planner-workspace.module.css';

// The sheet reads top to bottom as one question each: when, what, which options, then one action.
// Task rows stay compact until tapped (Tiimo/Structured property rows); the budget is
// "한 번에 × 주 N번" (Airbnb steppers) instead of two dropdown totals; the footer keeps the live
// summary beside the primary action (Airbnb filters); results are a week overview (Runna).
const uid = () => crypto.randomUUID();
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS_ONLY = [0, 1, 2, 3, 4];
const WEEKEND = [5, 6];
const SESSIONS = [30, 60, 90, 120];
const MAX_WEEK_MINUTES = 40 * 60;
const QUICK_DAYS: { label: string; days: number[] }[] = [
  { label: '매일', days: ALL_DAYS },
  { label: '평일', days: WEEKDAYS_ONLY },
  { label: '주말', days: WEEKEND },
];
/** Time-of-day windows as tiles before an exact range (Airtasker, Angi). */
export const TIME_WINDOWS = [
  { id: 'after-school', label: '방과 후', start: '16:00', end: '22:00' },
  { id: 'evening', label: '저녁', start: '18:00', end: '23:00' },
  { id: 'morning', label: '오전', start: '09:00', end: '13:00' },
  { id: 'all-day', label: '하루 종일', start: '09:00', end: '22:00' },
] as const;
const sameDays = (a: number[], b: number[]) => {
  const x = [...a].sort((m, n) => m - n);
  const y = [...b].sort((m, n) => m - n);
  return x.length === y.length && x.every((d, i) => d === y[i]);
};
export function daysLabel(days: number[]) {
  if (sameDays(days, ALL_DAYS)) return '매일';
  if (sameDays(days, WEEKDAYS_ONLY)) return '평일';
  if (sameDays(days, WEEKEND)) return '주말';
  if (!days.length) return '요일 없음';
  return [...days]
    .sort((m, n) => m - n)
    .map((d) => WEEKDAYS[d])
    .join('·');
}
export const sessionCount = (need: Pick<WeeklyNeed, 'minutes' | 'sessionMinutes'>) =>
  Math.max(1, Math.round(need.minutes / need.sessionMinutes));
export const needSummary = (need: WeeklyNeed) =>
  `${formatMinutes(need.sessionMinutes)} × 주 ${sessionCount(need)}번 · ${daysLabel(need.weekdays)}`;
export const optionSummary = (option: AcademyOption) =>
  `${daysLabel(option.weekdays)} · ${option.start}–${option.end}`;
const newNeed = (patch: Partial<WeeklyNeed> = {}): WeeklyNeed => ({
  id: uid(),
  title: '',
  minutes: 120,
  sessionMinutes: 60,
  weekdays: ALL_DAYS,
  ...patch,
});
const newOption = (n: number, weekdays: number[]): AcademyOption => ({
  id: uid(),
  title: `후보 ${n}`,
  weekdays,
  start: '18:00',
  end: '20:00',
});
const newGroup = (): AcademyGroup => ({
  id: uid(),
  title: '',
  options: [newOption(1, [0, 2, 4]), newOption(2, [1, 3])],
});
export type WeeklySuggestion = {
  title: string;
  subjectId?: string;
  sessionMinutes: number;
  count: number;
  note: string;
};
/** Subjects with cards due now come first (their load is the reason to plan), then one non-study item. */
export function weeklySuggestions(
  data: Pick<AppData, 'subjects' | 'cards'>,
  needs: WeeklyNeed[],
  now = Date.now(),
): WeeklySuggestion[] {
  const taken = new Set(needs.map((n) => n.title.trim()));
  const study = data.subjects
    .map((subject) => ({
      subject,
      due: data.cards.filter((c) => c.subjectId === subject.id && isDue(c, now)).length,
    }))
    .filter((x) => x.due > 0)
    .sort((a, b) => b.due - a.due)
    .slice(0, 3)
    .map(({ subject, due }) => ({
      title: `${subject.name} 복습`,
      subjectId: subject.id,
      sessionMinutes: 60,
      count: Math.min(3, Math.max(1, Math.ceil(due / 8))),
      note: `지금 복습 ${due}장`,
    }));
  return [...study, { title: '운동', sessionMinutes: 60, count: 2, note: '주 2번' }].filter(
    (s) => !taken.has(s.title),
  );
}

function Days({
  value,
  onChange,
  label,
}: {
  value: number[];
  onChange: (value: number[]) => void;
  label: string;
}) {
  return (
    <div className={styles.weekdays} role="group" aria-label={label}>
      {WEEKDAYS.map((day, i) => (
        <button
          key={day}
          type="button"
          aria-pressed={value.includes(i)}
          onClick={() => onChange(value.includes(i) ? value.filter((d) => d !== i) : [...value, i])}
        >
          {day}
        </button>
      ))}
    </div>
  );
}

function NeedEditor({
  need,
  index,
  subjectOptions,
  onChange,
  onRemove,
  onDone,
}: {
  need: WeeklyNeed;
  index: number;
  subjectOptions: { value: string; label: string }[];
  onChange: (patch: Partial<WeeklyNeed>) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const count = sessionCount(need);
  const setSession = (sessionMinutes: number) =>
    onChange({ sessionMinutes, minutes: Math.min(MAX_WEEK_MINUTES, count * sessionMinutes) });
  const name = need.title.trim() || `할 일 ${index + 1}`;
  return (
    <div className={styles.card} role="group" aria-label={`${name} 편집`}>
      <input
        className={styles.input}
        aria-label={`할 일 ${index + 1} 이름`}
        placeholder="예: 생명과학 복습, 운동, 친구 약속"
        maxLength={100}
        value={need.title}
        onChange={(e) => onChange({ title: e.target.value })}
      />
      <div className={styles.block}>
        <span className={styles.label}>한 번에</span>
        <div className={styles.options} role="group" aria-label="한 번에 할 시간">
          {SESSIONS.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={need.sessionMinutes === m}
              onClick={() => setSession(m)}
            >
              {formatMinutes(m)}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.stepperLine}>
        <span className={styles.label}>이번 주</span>
        <Stepper
          label="주 횟수"
          name={`need-${need.id}-count`}
          value={count}
          min={1}
          max={Math.max(1, Math.floor(MAX_WEEK_MINUTES / need.sessionMinutes))}
          onChange={(n) => onChange({ minutes: n * need.sessionMinutes })}
          unit="번"
        />
        <strong className={styles.total}>= {formatMinutes(count * need.sessionMinutes)}</strong>
      </div>
      <div className={styles.block}>
        <div className={styles.rowHead}>
          <span className={styles.label}>가능한 요일</span>
          <div className={styles.quick} role="group" aria-label="요일 빠른 선택">
            {QUICK_DAYS.map((q) => (
              <button
                key={q.label}
                type="button"
                aria-pressed={sameDays(need.weekdays, q.days)}
                onClick={() => onChange({ weekdays: q.days })}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
        <Days
          value={need.weekdays}
          label={`${name} 가능한 요일`}
          onChange={(weekdays) => onChange({ weekdays })}
        />
      </div>
      <div className={styles.block}>
        <span className={styles.label}>과목 연결</span>
        <OptionField
          label="과목 연결"
          name={`need-${need.id}-subject`}
          value={need.subjectId ?? ''}
          options={subjectOptions}
          onChange={(subjectId) => onChange({ subjectId: subjectId || undefined })}
        />
      </div>
      <Switch
        label="하루에 한 번씩 나누기"
        description="같은 날에 두 번 몰아서 배치하지 않아요"
        checked={!!need.differentDays}
        onChange={(differentDays) => onChange({ differentDays })}
      />
      <div className={styles.cardFooter}>
        <button type="button" className={styles.textDanger} onClick={onRemove}>
          삭제
        </button>
        <Button variant="secondary" size="compact" onClick={onDone}>
          완료
        </Button>
      </div>
    </div>
  );
}

function GroupCard({
  group,
  index,
  open,
  onOpen,
  onChange,
  onRemove,
}: {
  group: AcademyGroup;
  index: number;
  open: string | null;
  onOpen: (id: string | null) => void;
  onChange: (patch: Partial<AcademyGroup>) => void;
  onRemove: () => void;
}) {
  const optionChange = (id: string, patch: Partial<AcademyOption>) =>
    onChange({ options: group.options.map((o) => (o.id === id ? { ...o, ...patch } : o)) });
  const name = group.title.trim() || `일정 ${index + 1}`;
  return (
    <div className={styles.card} role="group" aria-label={`비교할 일정 ${index + 1}`}>
      <div className={styles.rowHead}>
        <input
          className={styles.input}
          aria-label={`비교할 일정 ${index + 1} 이름`}
          placeholder="예: 과학 학원"
          maxLength={40}
          value={group.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <button type="button" className={styles.textDanger} onClick={onRemove}>
          삭제
        </button>
      </div>
      <p className={styles.hint}>
        후보 중 하나만 고르게 돼요. 후보의 모든 요일에 다닐 수 있어야 해요.
      </p>
      <div className={styles.needs}>
        {group.options.map((option, oi) =>
          open === option.id ? (
            <div className={styles.optionEditor} key={option.id}>
              <input
                className={styles.input}
                aria-label={`${index + 1}번 일정 후보 ${oi + 1} 이름`}
                maxLength={50}
                value={option.title}
                onChange={(e) => optionChange(option.id, { title: e.target.value })}
              />
              <Days
                value={option.weekdays}
                label={`${name} ${option.title || `후보 ${oi + 1}`} 요일`}
                onChange={(weekdays) => optionChange(option.id, { weekdays })}
              />
              <div className={styles.fields}>
                <TimeField
                  label="시작"
                  name={`option-${option.id}-start`}
                  value={option.start}
                  onChange={(start) => optionChange(option.id, { start })}
                  boxed
                />
                <TimeField
                  label="종료"
                  name={`option-${option.id}-end`}
                  value={option.end}
                  onChange={(end) => optionChange(option.id, { end })}
                  boxed
                />
              </div>
              <div className={styles.cardFooter}>
                <button
                  type="button"
                  className={styles.textDanger}
                  disabled={group.options.length <= 1}
                  onClick={() =>
                    onChange({ options: group.options.filter((o) => o.id !== option.id) })
                  }
                >
                  후보 삭제
                </button>
                <Button variant="secondary" size="compact" onClick={() => onOpen(null)}>
                  완료
                </Button>
              </div>
            </div>
          ) : (
            <button
              key={option.id}
              type="button"
              className={styles.needRow}
              onClick={() => onOpen(option.id)}
            >
              <span className={styles.needCopy}>
                <strong>{option.title.trim() || `후보 ${oi + 1}`}</strong>
                <small>{optionSummary(option)}</small>
              </span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          ),
        )}
        {group.options.length < 3 && (
          <button
            type="button"
            className={styles.addRow}
            onClick={() => {
              const option = newOption(group.options.length + 1, [0, 2, 4]);
              onChange({ options: [...group.options, option] });
              onOpen(option.id);
            }}
          >
            <Plus size={17} aria-hidden="true" />
            후보 추가
          </button>
        )}
      </div>
    </div>
  );
}

export type WeeklySetupProps = {
  data: Pick<AppData, 'subjects' | 'cards'>;
  input: WeeklyInput;
  today: string;
  invalid: string;
  error: string;
  busy: boolean;
  open: string | null;
  onOpen: (id: string | null) => void;
  customWindow: boolean;
  onCustomWindow: (custom: boolean) => void;
  onChange: (patch: Partial<WeeklyInput>) => void;
  onPropose: () => void;
};
/** The setup half of the sheet: period, tasks, optional candidate groups, and the sticky footer. */
export function WeeklySetup(p: WeeklySetupProps) {
  const { input } = p;
  const needChange = (id: string, patch: Partial<WeeklyNeed>) =>
    p.onChange({ needs: input.needs.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
  const groupChange = (id: string, patch: Partial<AcademyGroup>) =>
    p.onChange({ groups: input.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) });
  const preset = TIME_WINDOWS.find((w) => w.start === input.start && w.end === input.end);
  const showCustom = p.customWindow || !preset;
  const total = input.needs.reduce((sum, n) => sum + n.minutes, 0);
  const suggestions = weeklySuggestions(p.data, input.needs);
  const subjectOptions = [
    { value: '', label: '과목 없이' },
    ...p.data.subjects.map((s) => ({ value: s.id, label: s.name })),
  ];
  const addNeed = (patch: Partial<WeeklyNeed> = {}) => {
    if (input.needs.length >= 8) return;
    const need = newNeed(patch);
    p.onChange({ needs: [...input.needs, need] });
    p.onOpen(need.id);
  };
  const untilLabel = validDate(input.from) ? dayLabel(shiftPlanDate(input.from, 6)) : '종료일';
  return (
    <>
      <div className={styles.scroll}>
        <fieldset disabled={p.busy} className={styles.fieldset}>
          <section className={styles.section} aria-label="계획할 기간">
            <div className={styles.rowHead}>
              <h3>언제</h3>
              <DateField
                label="시작일"
                name="planFrom"
                value={input.from}
                min={p.today}
                onChange={(from) => p.onChange({ from })}
                variant="chip"
                weekStartsOn={1}
              />
            </div>
            <p className={styles.hint}>
              {dayLabel(input.from)}부터 7일 · {untilLabel}까지 배치해요.
            </p>
            <div className={styles.presets} role="group" aria-label="하루 배치 시간">
              {TIME_WINDOWS.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className={styles.preset}
                  aria-pressed={!showCustom && preset?.id === w.id}
                  onClick={() => {
                    p.onCustomWindow(false);
                    p.onChange({ start: w.start, end: w.end });
                  }}
                >
                  <strong>{w.label}</strong>
                  <small>
                    {w.start}–{w.end}
                  </small>
                </button>
              ))}
              <button
                type="button"
                className={styles.preset}
                aria-pressed={showCustom}
                onClick={() => p.onCustomWindow(true)}
              >
                <strong>직접 설정</strong>
                <small>{showCustom ? `${input.start}–${input.end}` : '시작·종료 시각'}</small>
              </button>
            </div>
            {showCustom && (
              <div className={styles.fields}>
                <TimeField
                  label="시작"
                  name="planStart"
                  value={input.start}
                  onChange={(start) => p.onChange({ start })}
                  boxed
                />
                <TimeField
                  label="종료"
                  name="planEnd"
                  value={input.end}
                  onChange={(end) => p.onChange({ end })}
                  boxed
                />
              </div>
            )}
          </section>
          <section className={styles.section} aria-label="이번 주 할 일">
            <div className={styles.rowHead}>
              <h3>이번 주 할 일</h3>
              <span className={styles.count}>{input.needs.length}/8</span>
            </div>
            {suggestions.length > 0 && input.needs.length < 8 && (
              <div className={styles.chips} role="group" aria-label="빠른 추가">
                {suggestions.map((s) => (
                  <button
                    key={s.title}
                    type="button"
                    className={styles.chip}
                    onClick={() =>
                      addNeed({
                        title: s.title,
                        subjectId: s.subjectId,
                        sessionMinutes: s.sessionMinutes,
                        minutes: s.sessionMinutes * s.count,
                      })
                    }
                  >
                    <Plus size={14} aria-hidden="true" />
                    {s.title}
                    <small>{s.note}</small>
                  </button>
                ))}
              </div>
            )}
            <div className={styles.needs}>
              {input.needs.map((need, i) =>
                p.open === need.id ? (
                  <NeedEditor
                    key={need.id}
                    need={need}
                    index={i}
                    subjectOptions={subjectOptions}
                    onChange={(patch) => needChange(need.id, patch)}
                    onRemove={() => {
                      p.onChange({ needs: input.needs.filter((n) => n.id !== need.id) });
                      p.onOpen(null);
                    }}
                    onDone={() => p.onOpen(null)}
                  />
                ) : (
                  <button
                    key={need.id}
                    type="button"
                    className={styles.needRow}
                    onClick={() => p.onOpen(need.id)}
                  >
                    <span className={styles.needCopy}>
                      <strong className={need.title.trim() ? undefined : styles.placeholder}>
                        {need.title.trim() || `할 일 ${i + 1} · 이름을 적어 주세요`}
                      </strong>
                      <small>{needSummary(need)}</small>
                    </span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                ),
              )}
              {input.needs.length < 8 && (
                <button type="button" className={styles.addRow} onClick={() => addNeed()}>
                  <Plus size={17} aria-hidden="true" />
                  직접 추가
                </button>
              )}
              {!input.needs.length && (
                <p className={styles.hint}>
                  공부·운동·약속처럼 이번 주에 시간을 내야 하는 일을 넣어요.
                </p>
              )}
            </div>
          </section>
          <section className={styles.section} aria-label="시간표 후보 비교">
            <div className={styles.rowHead}>
              <h3>
                후보 비교 <span className={styles.optional}>선택</span>
              </h3>
              {input.groups.length < 3 && (
                <button
                  type="button"
                  className={styles.textAction}
                  onClick={() => {
                    const group = newGroup();
                    p.onChange({ groups: [...input.groups, group] });
                    p.onOpen(group.options[0].id);
                  }}
                >
                  <Plus size={15} aria-hidden="true" />
                  묶음 추가
                </button>
              )}
            </div>
            {!input.groups.length ? (
              <p className={styles.hint}>
                학원처럼 요일을 하나만 골라야 하는 일정이 있으면 후보를 넣어 두세요. 할 일과 함께
                배치해 가능한 조합만 보여 줘요.
              </p>
            ) : (
              input.groups.map((group, gi) => (
                <GroupCard
                  key={group.id}
                  group={group}
                  index={gi}
                  open={p.open}
                  onOpen={p.onOpen}
                  onChange={(patch) => groupChange(group.id, patch)}
                  onRemove={() =>
                    p.onChange({ groups: input.groups.filter((g) => g.id !== group.id) })
                  }
                />
              ))
            )}
          </section>
          <p className={styles.hint}>
            조건 기반으로 계산해요. 기존 일정은 그대로 두고, 직접 고른 안만 시간표에 추가해요.
          </p>
        </fieldset>
      </div>
      <div className={styles.footer}>
        {(p.error || p.invalid) && (
          <p role="status" className={p.error ? styles.footerError : styles.footerNote}>
            {p.error || p.invalid}
          </p>
        )}
        <div className={styles.footerRow}>
          <div className={styles.summary}>
            <strong>할 일 {input.needs.length}개</strong>
            <small>
              {total ? `주 ${formatMinutes(total)}` : '아직 시간 없음'}
              {input.groups.length ? ` · 후보 ${input.groups.length}묶음` : ''}
            </small>
          </div>
          <Button onClick={p.onPropose} disabled={p.busy || !!p.invalid}>
            {p.busy ? '확인하는 중…' : '배치안 보기'}
          </Button>
        </div>
      </div>
    </>
  );
}

export type WeeklyResultProps = {
  input: WeeklyInput;
  result: { plans: WeeklyPlan[]; rejected: number; error: string };
  selected: number;
  onSelect: (index: number) => void;
  busy: boolean;
  error: string;
  pending: boolean;
  receipt: boolean;
  onApply: () => void;
  onBack: () => void;
};
/** The result half: plan choices, a three-number summary, the week overview, and accept/adjust. */
export function WeeklyResult(p: WeeklyResultProps) {
  const plan = p.result.plans[p.selected];
  const dates = validDate(p.input.from)
    ? Array.from({ length: 7 }, (_, i) => shiftPlanDate(p.input.from, i))
    : [];
  const unmetMinutes = plan ? plan.unmet.reduce((sum, u) => sum + u.minutes, 0) : 0;
  const locked = p.busy || p.receipt || p.pending;
  return (
    <>
      <div className={styles.scroll}>
        <div className={styles.fieldset}>
          {!p.result.plans.length || !plan ? (
            <div className={styles.notice}>
              <strong>지금 조건에 맞는 조합이 없어요</strong>
              <p>
                후보 일정이 기존 일정이나 서로 겹쳐요. 요일·시간을 바꾸거나 다른 후보를 넣어 보세요.
                아직 아무것도 추가하지 않았어요.
              </p>
            </div>
          ) : (
            <>
              {p.result.plans.length > 1 && (
                <div className={styles.planChoices} role="group" aria-label="배치안 선택">
                  {p.result.plans.map((x, i) => {
                    const short = x.unmet.reduce((sum, u) => sum + u.minutes, 0);
                    return (
                      <button
                        key={x.id}
                        type="button"
                        aria-pressed={p.selected === i}
                        disabled={locked}
                        onClick={() => p.onSelect(i)}
                      >
                        <strong>{i + 1}안</strong>
                        <small>{short ? `${formatMinutes(short)} 부족` : '모두 배치'}</small>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className={styles.stats} aria-label="배치 요약">
                <div>
                  <strong>{formatMinutes(plan.allocated)}</strong>
                  <small>배치한 시간</small>
                </div>
                <div>
                  <strong>{plan.blocks.length}개</strong>
                  <small>추가할 일정</small>
                </div>
                <div className={unmetMinutes ? styles.statWarn : undefined}>
                  <strong>{unmetMinutes ? formatMinutes(unmetMinutes) : '없음'}</strong>
                  <small>부족한 시간</small>
                </div>
              </div>
              {plan.choices.length > 0 && (
                <p className={styles.hint}>후보 선택 · {plan.choices.join(' / ')}</p>
              )}
              <div className={styles.week} aria-label="주간 미리보기">
                {dates.map((date) => {
                  const blocks = plan.blocks.filter((b) => b.date === date);
                  return (
                    <div className={styles.dayRow} key={date}>
                      <div className={styles.dayLabel}>
                        <strong>{WEEKDAYS[planWeekday(date)]}</strong>
                        <small>{Number(date.slice(8, 10))}</small>
                      </div>
                      <div className={styles.dayBlocks}>
                        {blocks.length ? (
                          blocks.map((b, i) => (
                            <span
                              key={`${date}-${i}`}
                              className={styles.blockChip}
                              data-kind={b.kind}
                            >
                              <time>{b.start}</time>
                              {b.title}
                            </span>
                          ))
                        ) : (
                          <span className={styles.empty}>비어 있어요</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {plan.unmet.length > 0 && (
                <div className={styles.notice}>
                  <strong>이 안에서 아직 배치하지 못한 시간</strong>
                  {plan.unmet.map((u, i) => (
                    <p key={i}>
                      {u.title} · {formatMinutes(u.minutes)}
                    </p>
                  ))}
                  <p>가능한 요일·시간을 넓히거나 한 번에 할 시간을 줄여 보세요.</p>
                </div>
              )}
              {p.result.rejected > 0 && (
                <p className={styles.hint}>
                  기존 일정이나 후보끼리 겹치는 {p.result.rejected}개 조합은 뺐어요.
                </p>
              )}
              {p.pending && !p.busy && (
                <div className={styles.notice} role="status">
                  <strong>등록 결과를 확인할게요</strong>
                  <p>마지막으로 보낸 안을 그대로 확인해요. 이미 등록됐다면 다시 추가하지 않아요.</p>
                </div>
              )}
              <p className={styles.hint}>
                이미 있는 일정은 그대로 두어요. 계산한 안 중 하나이며 가능한 모든 배치를 뜻하지는
                않아요.
              </p>
            </>
          )}
        </div>
      </div>
      <div className={styles.footer}>
        {p.error && (
          <p role="alert" className={styles.footerError}>
            {p.error}
          </p>
        )}
        <div className={styles.footerRow}>
          <Button variant="ghost" onClick={p.onBack} disabled={locked}>
            <ChevronLeft size={16} aria-hidden="true" />
            조건 바꾸기
          </Button>
          {plan && (
            <Button disabled={p.busy || (!p.receipt && !plan.blocks.length)} onClick={p.onApply}>
              {p.busy
                ? '담고 있어요…'
                : p.receipt
                  ? '등록한 일정 확인하기'
                  : p.pending
                    ? '등록 결과 확인하기'
                    : plan.unmet.length
                      ? `배치된 ${plan.blocks.length}개만 등록하기`
                      : `이 안으로 ${plan.blocks.length}개 등록하기`}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

export function PlannerWorkspace({
  data,
  day,
  onClose,
  onSaved,
}: {
  data: AppData;
  day: string;
  onClose: () => void;
  onSaved: (message: string, date: string) => Promise<void>;
}) {
  const today = dateKey(new Date());
  const [input, setInput] = useJourneyState<WeeklyInput>('planner.weeklyWorkspace', () => ({
    from: day < today ? today : day,
    start: '16:00',
    end: '22:00',
    needs: [newNeed()],
    groups: [],
  }));
  const [pending, setPending] = useJourneyState<PendingWeeklyPlan | null>(
    'planner.weeklyPendingV1',
    null,
  );
  const [receipt, setReceipt] = useJourneyState<{
    message: string;
    date: string;
    plan: WeeklyPlan;
  } | null>('planner.weeklyReceiptV1', null);
  const [result, setResult] = useState<ReturnType<typeof weeklyPlans> | null>(() => {
    const restored = pending?.plan ?? receipt?.plan;
    return restored ? { plans: [restored], rejected: 0, error: '' } : null;
  });
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The first untitled task opens ready to type; later rows stay compact until tapped.
  const [open, setOpen] = useState<string | null>(() =>
    input.needs.length === 1 && !input.needs[0].title ? input.needs[0].id : null,
  );
  const [customWindow, setCustomWindow] = useState(
    () => !TIME_WINDOWS.some((w) => w.start === input.start && w.end === input.end),
  );
  const change = (patch: Partial<WeeklyInput>) => {
    setInput((current) => ({ ...current, ...patch }));
    setError('');
  };
  // A blank task row is the common half-finished state; name it before the model's generic message.
  const invalid = input.needs.some((n) => !n.title.trim())
    ? '이름이 비어 있는 할 일이 있어요. 행을 눌러 적어 주세요.'
    : weeklyInputError(input) || (input.from < today ? '오늘 이후의 시작일을 골라 주세요.' : '');
  async function propose() {
    if (busy || invalid || pending || receipt) return;
    setBusy(true);
    setError('');
    try {
      const fresh = await api<AppData>('/bootstrap');
      const now = new Date();
      const next = weeklyPlans(input, fresh.schedules, {
        date: dateKey(now),
        time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      });
      setResult(next);
      setSelected(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const plan = result?.plans[selected];
  async function apply() {
    if (busy || (!plan && !pending && !receipt)) return;
    setBusy(true);
    setError('');
    try {
      if (receipt) {
        await onSaved(receipt.message, receipt.date);
        setReceipt(null);
        return;
      }
      // Persist exactly what may reach the server before sending. A lost response must
      // resume this batch rather than recomputing the same goals into other free hours.
      const snapshot = pending ?? { input, plan: plan! };
      setPending(snapshot);
      const saved = await api<{ added: number; existing: number }>(
        '/schedules/batch',
        weeklyBatchPayload(snapshot.plan),
      );
      const message = saved.added
        ? `${saved.added}개 일정을 담았어요${saved.existing ? ` · 이미 등록한 ${saved.existing}개는 유지했어요` : ''}`
        : '이미 등록한 일정을 확인했어요';
      const next = {
        message,
        date: snapshot.plan.blocks[0]?.date ?? snapshot.input.from,
        plan: snapshot.plan,
      };
      setReceipt(next);
      setPending(null);
      // Keep only unallocated needs. Reopening a saved plan must not add the same
      // weekly goal a second time into a different free slot.
      const remaining = remainingWeeklyNeeds(snapshot.input.needs, snapshot.plan);
      setInput((current) => ({
        ...current,
        needs: remaining.length ? remaining : [newNeed()],
        groups: [],
      }));
      await onSaved(next.message, next.date);
      setReceipt(null);
    } catch (e) {
      // Validation/conflict refusals guarantee no batch was committed. Transport/5xx
      // failures are uncertain, so retain the snapshot and offer an identical replay.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) setPending(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      open
      workspace
      onClose={() => !busy && onClose()}
      title={result ? '배치안 살펴보기' : '이번 주 계획'}
      description={
        result
          ? `${dayLabel(input.from)} – ${validDate(input.from) ? dayLabel(shiftPlanDate(input.from, 6)) : '종료일'}`
          : '언제, 무엇을, 얼마나 할지만 정하면 기존 일정 사이에 배치해요.'
      }
    >
      {!result ? (
        <WeeklySetup
          data={data}
          input={input}
          today={today}
          invalid={invalid}
          error={error}
          busy={busy}
          open={open}
          onOpen={setOpen}
          customWindow={customWindow}
          onCustomWindow={setCustomWindow}
          onChange={change}
          onPropose={propose}
        />
      ) : (
        <WeeklyResult
          input={input}
          result={result}
          selected={selected}
          onSelect={setSelected}
          busy={busy}
          error={error}
          pending={!!pending}
          receipt={!!receipt}
          onApply={apply}
          onBack={() => {
            setResult(null);
            setError('');
          }}
        />
      )}
    </Sheet>
  );
}
