'use client';
import { useState } from 'react';
import { ChevronLeft, Plus, X } from '@/components/icons';
import { Button, Sheet } from '@/components/ui';
import { Switch } from '@/components/ui-choice';
import { DateField } from '@/components/ui-date';
import { api, ApiError } from '@/lib/api';
import type { AppData } from '@/lib/contracts';
import { formatMinutes } from '@/lib/schedule';
import {
  WEEKDAYS,
  shiftPlanDate,
  validDate,
  weeklyInputError,
  weeklyPlans,
  remainingWeeklyNeeds,
  weeklyBatchPayload,
  weeklyDurationOptions,
  type WeeklyInput,
  type PendingWeeklyPlan,
  type WeeklyPlan,
  type WeeklyNeed,
  type AcademyGroup,
} from '@/lib/planner-workspace';
import { useJourneyState } from '../journey';
import { dayLabel, dateKey } from './helpers';
import styles from './planner-workspace.module.css';

const uid = () => crypto.randomUUID();
const allDays = [0, 1, 2, 3, 4, 5, 6];
const newNeed = (): WeeklyNeed => ({
  id: uid(),
  title: '',
  minutes: 120,
  sessionMinutes: 60,
  weekdays: allDays,
});
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
  const change = (patch: Partial<WeeklyInput>) => {
    setInput((current) => ({ ...current, ...patch }));
    setError('');
  };
  const needChange = (id: string, patch: Partial<WeeklyNeed>) =>
    change({ needs: input.needs.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
  const groupChange = (id: string, patch: Partial<AcademyGroup>) =>
    change({ groups: input.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) });
  const invalid =
    weeklyInputError(input) || (input.from < today ? '오늘 이후의 시작일을 골라 주세요.' : '');
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
  const dates = plan ? [...new Set(plan.blocks.map((b) => b.date))] : [];
  return (
    <Sheet
      open
      workspace
      onClose={() => !busy && onClose()}
      title={result ? '배치안 살펴보기' : '이번 주 계획'}
      description={
        result
          ? `${dayLabel(input.from)} – ${validDate(input.from) ? dayLabel(shiftPlanDate(input.from, 6)) : '종료일'}`
          : '할 일과 가능한 시간을 알려 주세요. 기존 일정 사이에 배치해요.'
      }
    >
      <div className={styles.workspace}>
        {!result ? (
          <fieldset disabled={busy} className="contents">
            <section className={styles.section} aria-label="계획할 기간">
              <DateField
                label="시작일"
                name="planFrom"
                value={input.from}
                onChange={(from) => change({ from })}
              />
              <p className={styles.intro}>
                선택한 날부터 7일 · {dayLabel(input.from)}–
                {validDate(input.from) ? dayLabel(shiftPlanDate(input.from, 6)) : '종료일'}
              </p>
              <div className={styles.fields}>
                <label className={styles.field}>
                  하루 배치 시작
                  <input
                    type="time"
                    value={input.start}
                    onChange={(e) => change({ start: e.target.value })}
                  />
                </label>
                <label className={styles.field}>
                  하루 배치 종료
                  <input
                    type="time"
                    value={input.end}
                    onChange={(e) => change({ end: e.target.value })}
                  />
                </label>
              </div>
            </section>
            <section className={styles.section} aria-label="이번 주 할 일">
              <div className={styles.row}>
                <h3>이번 주 할 일</h3>
                <span className={styles.intro}>{input.needs.length}/8</span>
              </div>
              <p className={styles.intro}>
                공부, 운동, 약속까지 · 총 시간과 한 번에 할 시간을 정해요.
              </p>
              {input.needs.map((need, i) => (
                <div className={styles.entry} key={need.id}>
                  <div className={styles.row}>
                    <label className={styles.field} style={{ flex: 1 }}>
                      할 일 {i + 1}
                      <input
                        aria-label={`할 일 ${i + 1} 이름`}
                        placeholder="예: 생명과학, 운동, 친구 약속"
                        maxLength={100}
                        value={need.title}
                        onChange={(e) => needChange(need.id, { title: e.target.value })}
                      />
                    </label>
                    <button
                      className={styles.remove}
                      aria-label={`할 일 ${i + 1} 삭제`}
                      onClick={() => change({ needs: input.needs.filter((n) => n.id !== need.id) })}
                    >
                      <X size={18} />
                    </button>
                  </div>
                  <div className={styles.fields}>
                    <label className={styles.field}>
                      이번 주 총 시간
                      <select
                        value={need.minutes}
                        onChange={(e) => needChange(need.id, { minutes: Number(e.target.value) })}
                      >
                        {weeklyDurationOptions(need.minutes).map((n) => (
                          <option key={n} value={n}>
                            {formatMinutes(n)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.field}>
                      한 번에 할 시간
                      <select
                        value={need.sessionMinutes}
                        onChange={(e) =>
                          needChange(need.id, { sessionMinutes: Number(e.target.value) })
                        }
                      >
                        {[15, 30, 60, 90, 120].map((n) => (
                          <option key={n} value={n}>
                            {formatMinutes(n)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className={styles.field}>
                    과목 연결 · 선택
                    <select
                      value={need.subjectId ?? ''}
                      onChange={(e) =>
                        needChange(need.id, { subjectId: e.target.value || undefined })
                      }
                    >
                      <option value="">과목 없이</option>
                      {data.subjects.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Switch
                    label="하루에 한 번씩 나누기"
                    checked={!!need.differentDays}
                    onChange={(differentDays) => needChange(need.id, { differentDays })}
                  />
                  <div className={styles.field}>
                    <span>가능한 요일</span>
                    <Days
                      value={need.weekdays}
                      label={`${need.title || `할 일 ${i + 1}`} 가능한 요일`}
                      onChange={(weekdays) => needChange(need.id, { weekdays })}
                    />
                  </div>
                </div>
              ))}
              {input.needs.length < 8 && (
                <Button
                  variant="secondary"
                  onClick={() => change({ needs: [...input.needs, newNeed()] })}
                >
                  <Plus size={17} />할 일 추가
                </Button>
              )}
            </section>
            <section className={styles.section} aria-label="시간표 후보 비교">
              <h3>
                시간표 후보 비교 <small className={styles.intro}>선택</small>
              </h3>
              <p className={styles.intro}>
                예: 과학 학원의 화·목반과 월·금반. 같은 일정의 후보 중 하나를 골라 조합해요. 각
                후보의 모든 요일에 다닐 수 있어야 해요.
              </p>
              {input.groups.map((group, gi) => (
                <div className={styles.entry} key={group.id}>
                  <div className={styles.row}>
                    <label className={styles.field} style={{ flex: 1 }}>
                      비교할 일정
                      <input
                        aria-label={`비교할 일정 ${gi + 1}`}
                        placeholder="예: 과학 학원"
                        maxLength={40}
                        value={group.title}
                        onChange={(e) => groupChange(group.id, { title: e.target.value })}
                      />
                    </label>
                    <button
                      className={styles.remove}
                      aria-label={`비교할 일정 ${gi + 1} 삭제`}
                      onClick={() =>
                        change({ groups: input.groups.filter((g) => g.id !== group.id) })
                      }
                    >
                      <X size={18} />
                    </button>
                  </div>
                  {group.options.map((option, oi) => {
                    const edit = (patch: Partial<typeof option>) =>
                      groupChange(group.id, {
                        options: group.options.map((o) =>
                          o.id === option.id ? { ...o, ...patch } : o,
                        ),
                      });
                    return (
                      <div className={styles.section} key={option.id}>
                        <div className={styles.row}>
                          <label className={styles.field} style={{ flex: 1 }}>
                            후보 {oi + 1}
                            <input
                              aria-label={`${gi + 1}번 일정 후보 ${oi + 1} 이름`}
                              maxLength={50}
                              value={option.title}
                              onChange={(e) => edit({ title: e.target.value })}
                            />
                          </label>
                          <button
                            className={styles.remove}
                            aria-label={`${gi + 1}번 일정 후보 ${oi + 1} 삭제`}
                            onClick={() =>
                              groupChange(group.id, {
                                options: group.options.filter((o) => o.id !== option.id),
                              })
                            }
                          >
                            <X size={16} />
                          </button>
                        </div>
                        <Days
                          value={option.weekdays}
                          label={`${group.title} ${option.title} 요일`}
                          onChange={(weekdays) => edit({ weekdays })}
                        />
                        <div className={styles.fields}>
                          <label className={styles.field}>
                            시작
                            <input
                              type="time"
                              value={option.start}
                              onChange={(e) => edit({ start: e.target.value })}
                            />
                          </label>
                          <label className={styles.field}>
                            종료
                            <input
                              type="time"
                              value={option.end}
                              onChange={(e) => edit({ end: e.target.value })}
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                  {group.options.length < 3 && (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        groupChange(group.id, {
                          options: [
                            ...group.options,
                            {
                              id: uid(),
                              title: `후보 ${group.options.length + 1}`,
                              weekdays: [1, 3],
                              start: '18:00',
                              end: '20:00',
                            },
                          ],
                        })
                      }
                    >
                      후보 추가
                    </Button>
                  )}
                </div>
              ))}
              {input.groups.length < 3 && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    change({
                      groups: [
                        ...input.groups,
                        {
                          id: uid(),
                          title: '',
                          options: [
                            {
                              id: uid(),
                              title: '후보 1',
                              weekdays: [0, 2, 4],
                              start: '18:00',
                              end: '20:00',
                            },
                            {
                              id: uid(),
                              title: '후보 2',
                              weekdays: [1, 3],
                              start: '18:00',
                              end: '20:00',
                            },
                          ],
                        },
                      ],
                    })
                  }
                >
                  <Plus size={17} />
                  비교할 일정 추가
                </Button>
              )}
            </section>
            <p className={styles.intro}>
              조건 기반으로 가능한 배치안을 계산해요. AI 추천과 별개이며, 직접 확인한 안만 시간표에
              추가해요. 기존 일정은 고정해 두어요.
            </p>
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
            <div className={styles.footer}>
              <Button onClick={propose} disabled={busy || !!invalid}>
                {busy ? '시간을 확인하고 있어요…' : '가능한 배치안 보기'}
              </Button>
              {invalid && <p className={styles.intro}>{invalid}</p>}
            </div>
          </fieldset>
        ) : (
          <>
            {!receipt && !pending && (
              <Button
                variant="ghost"
                onClick={() => {
                  setResult(null);
                  setError('');
                }}
                disabled={busy}
              >
                <ChevronLeft size={16} />
                조건 바꾸기
              </Button>
            )}
            {!result.plans.length ? (
              <div className={styles.notice}>
                <strong>지금 조건에 맞는 시간표 조합이 없어요</strong>
                <p>
                  후보 일정이 기존 일정 또는 서로 겹쳐요. 요일·시간을 바꾸거나 다른 후보를 추가해
                  주세요. 아직 일정을 추가하지 않았어요.
                </p>
              </div>
            ) : (
              <>
                <div className={styles.planChoices} role="group" aria-label="배치안 선택">
                  {result.plans.map((p, i) => (
                    <button
                      key={p.id}
                      aria-pressed={selected === i}
                      disabled={busy || !!receipt || !!pending}
                      onClick={() => setSelected(i)}
                    >
                      {i + 1}안 · {p.title}
                    </button>
                  ))}
                </div>
                {plan && (
                  <>
                    <div className={styles.section}>
                      <h3>
                        {plan.blocks.length}개 일정 · 할 일 {formatMinutes(plan.allocated)} 배치
                      </h3>
                      {plan.choices.length > 0 && (
                        <p className={styles.intro}>{plan.choices.join(' / ')}</p>
                      )}
                      <p className={styles.intro}>
                        이미 있는 일정은 그대로 유지해요. 후보는 최대 9개, 일정은 한 번에 200개까지
                        보여요.
                      </p>
                    </div>
                    {plan.unmet.length > 0 && (
                      <div className={styles.notice}>
                        <strong>이 안에서 아직 배치하지 못한 시간</strong>
                        {plan.unmet.map((u, i) => (
                          <p key={i}>
                            {u.title} · {formatMinutes(u.minutes)}
                          </p>
                        ))}
                        <p>
                          가능한 요일·시간을 넓히거나 한 번에 할 시간을 줄여 보세요. 계산한 안의
                          결과이며, 가능한 모든 배치를 찾았다는 뜻은 아니에요.
                        </p>
                      </div>
                    )}
                    {result.rejected > 0 && (
                      <p className={styles.intro}>
                        기존 일정 또는 후보끼리 겹치는 {result.rejected}개 조합은 제외했어요.
                      </p>
                    )}
                    <div className={styles.list} aria-label="추가할 일정 미리보기">
                      {dates.map((date) => (
                        <section className={styles.day} key={date}>
                          <h4>{dayLabel(date, 'long')}</h4>
                          {plan.blocks
                            .filter((b) => b.date === date)
                            .map((b, i) => (
                              <div className={styles.block} key={`${date}-${i}`}>
                                <time>
                                  {b.start}–{b.end}
                                </time>
                                <span>
                                  {b.title}
                                  {b.kind === 'FIXED' ? ' · 고정' : ''}
                                </span>
                              </div>
                            ))}
                        </section>
                      ))}
                    </div>
                    {error && (
                      <p role="alert" className="text-danger">
                        {error}
                      </p>
                    )}
                    {pending && !busy && (
                      <div className={styles.notice} role="status">
                        <strong>등록 결과를 확인할게요</strong>
                        <p>
                          마지막으로 보낸 배치안을 그대로 확인해요. 이미 등록됐다면 중복해서
                          추가하지 않아요. 확인 후 새 계획을 만들 수 있어요.
                        </p>
                      </div>
                    )}
                    <Button disabled={busy || (!receipt && !plan.blocks.length)} onClick={apply}>
                      {busy
                        ? '일정에 담고 있어요…'
                        : receipt
                          ? '등록한 일정 확인하기'
                          : pending
                            ? '등록 결과 확인하기'
                            : plan.unmet.length
                              ? `배치된 ${plan.blocks.length}개만 등록하기`
                              : `이 안으로 ${plan.blocks.length}개 등록하기`}
                    </Button>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
