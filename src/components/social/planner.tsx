'use client';
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  LockKeyhole,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
} from '@/components/icons';
import { api } from '@/lib/api';
import {
  acknowledgeAiTask,
  findAiTask,
  inspectAiTask,
  runAiTask,
  type AiTaskRecord,
} from '@/lib/ai-task';
import type { AppData, Schedule, ScreenProps } from '@/lib/contracts';
import {
  Button,
  DateTimeField,
  EmptyState,
  IconButton,
  ScreenHeader,
  Sheet,
} from '@/components/ui';
import {
  dateKey,
  durationLabel,
  scheduleConflicts,
  scheduleError,
  scheduleGaps,
  shiftDate,
  weekDates,
} from './helpers';

type Plan = { name: string; blocks: Omit<Schedule, 'id'>[] };
type PlannerResult = { plans: Plan[]; method?: string };
type PlannerTask = AiTaskRecord<PlannerResult>;

export function recoverPlannerResult(
  result: PlannerResult,
  taskDate: string,
  schedules: Schedule[],
) {
  const matches = (block: Omit<Schedule, 'id'>) =>
    schedules.some(
      (schedule) =>
        schedule.date.slice(0, 10) === block.date &&
        schedule.title.trim() === block.title.trim() &&
        schedule.start === block.start &&
        schedule.end === block.end &&
        schedule.kind === block.kind &&
        (schedule.subjectId || '') === (block.subjectId || ''),
    );
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(taskDate) ||
    !Array.isArray(result.plans) ||
    result.plans.some(
      (plan) => !Array.isArray(plan.blocks) || plan.blocks.some((block) => block.date !== taskDate),
    )
  ) {
    throw new Error('추천 날짜를 확인할 수 없어요. 이전 요청 상태를 다시 확인해 주세요.');
  }
  const savedCounts = result.plans.map((plan) => plan.blocks.filter(matches).length);
  const selectedIndex = Math.max(0, savedCounts.indexOf(Math.max(0, ...savedCounts)));
  return {
    date: taskDate,
    plans: result.plans.map((plan) => ({
      ...plan,
      blocks: plan.blocks.filter((block) => !matches(block)),
    })),
    selectedIndex,
    savedCount: savedCounts[selectedIndex] ?? 0,
  };
}
const blank = (date: string) => ({
  title: '',
  date,
  start: '17:00',
  end: '18:00',
  kind: 'FLEXIBLE' as Schedule['kind'],
  subjectId: '',
});

export default function Planner({ data, refresh, toast }: ScreenProps) {
  const [day, setDay] = useState(dateKey());
  const [now, setNow] = useState(() => new Date());
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [form, setForm] = useState(blank(day));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState(0);
  const [aiError, setAiError] = useState('');
  const [aiTask, setAiTask] = useState<PlannerTask | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiUnconfirmed, setAiUnconfirmed] = useState(false);
  const [suggestionDate, setSuggestionDate] = useState(day);
  const [savedPlanCount, setSavedPlanCount] = useState(0);
  const aiController = useRef<AbortController | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const schedules = useMemo(
    () =>
      data.schedules
        .filter((s) => s.date.slice(0, 10) === day)
        .sort((a, b) => a.start.localeCompare(b.start)),
    [data.schedules, day],
  );
  const conflicts = scheduleConflicts(schedules);
  const completed = schedules.filter((s) => s.done).length;
  const gaps = new Map(scheduleGaps(schedules).map((gap) => [gap.beforeId, gap]));
  const formValidation = scheduleError(form);
  const overlapping = data.schedules.find(
    (schedule) =>
      (!editing || editing === 'new' || schedule.id !== editing.id) &&
      schedule.date.slice(0, 10) === form.date &&
      form.start < schedule.end &&
      schedule.start < form.end,
  );
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const open = (schedule?: Schedule) => {
    setEditing(schedule ?? 'new');
    setForm(schedule ? { ...schedule, subjectId: schedule.subjectId ?? '' } : blank(day));
    setError('');
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    const validation = scheduleError(form);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(
        editing === 'new' ? '/schedules' : `/schedules/${(editing as Schedule).id}`,
        editing === 'new'
          ? { ...form, subjectId: form.subjectId || undefined }
          : {
              title: form.title,
              date: form.date,
              start: form.start,
              end: form.end,
              kind: form.kind,
              subjectId: form.subjectId || undefined,
            },
        editing === 'new' ? 'POST' : 'PATCH',
      );
      await refresh();
      setDay(form.date);
      setEditing(null);
      toast(editing === 'new' ? '일정을 추가했어요' : '일정을 바꿨어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!editing || editing === 'new') return;
    setBusy(true);
    try {
      await api(`/schedules/${editing.id}`, {}, 'DELETE');
      await refresh();
      setEditing(null);
      toast('일정을 삭제했어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(schedule: Schedule) {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/schedules/${schedule.id}`, { done: !schedule.done }, 'PATCH');
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const schedulesRef = useRef(data.schedules);
  schedulesRef.current = data.schedules;
  function showSuggestion(result: PlannerResult, date: string) {
    const recovered = recoverPlannerResult(result, date, schedulesRef.current);
    setSuggestionDate(recovered.date);
    setDay(recovered.date);
    setPlans(recovered.plans);
    setSelectedPlan(recovered.selectedIndex);
    setSavedPlanCount(recovered.savedCount);
    setAiError(result.plans.length ? '' : '지금은 추천할 빈 시간이 없어요. 일정을 확인해 주세요.');
  }
  async function inspectSuggestion(task: PlannerTask, signal: AbortSignal) {
    setAiUnconfirmed(false);
    setAiTask(task);
    let latest = await inspectAiTask<PlannerResult>(task, signal);
    for (let poll = 0; latest?.status === 'RUNNING' && poll < 45 && !signal.aborted; poll++) {
      setAiTask(latest);
      await new Promise((resolve) => setTimeout(resolve, 1600));
      if (signal.aborted) return;
      latest = await inspectAiTask<PlannerResult>(latest, signal);
    }
    if (signal.aborted) return;
    if (!latest) {
      setAiUnconfirmed(true);
      setAiError(
        '이전 요청의 접수 여부를 아직 확인하지 못했어요. 잠시 뒤 확인하거나 같은 요청을 이어서 보낼 수 있어요.',
      );
      return;
    }
    setAiTask(latest);
    if (latest.status === 'COMPLETED' && latest.result) {
      showSuggestion(latest.result, String(latest.payload.date));
    } else if (latest.status === 'FAILED' || latest.status === 'INTERRUPTED') {
      setAiError(latest.error || '이전 추천을 마치지 못했어요. 원할 때 다시 시작해 주세요.');
    } else {
      setAiError('추천 결과를 아직 기다리고 있어요. 화면을 닫아도 요청은 남아 있어요.');
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    aiController.current = controller;
    void (async () => {
      try {
        const task = await findAiTask<PlannerResult>({
          userId: data.profile.id,
          endpoint: '/planner/suggest',
        });
        if (!task || task.acknowledged || controller.signal.aborted) return;
        const taskDate = String(task.payload.date);
        setSuggestionDate(taskDate);
        setDay(taskDate);
        setAiOpen(true);
        setAiBusy(true);
        await inspectSuggestion(task, controller.signal);
      } catch (e) {
        if (!controller.signal.aborted) setAiError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setAiBusy(false);
      }
    })();
    return () => {
      controller.abort();
      aiController.current?.abort();
    };
  }, [data.profile.id]);
  async function suggest(retryFailed = false, continueRequest = false) {
    if (aiBusy) return;
    aiController.current?.abort();
    const controller = new AbortController();
    aiController.current = controller;
    setAiOpen(true);
    setAiError('');
    setAiBusy(true);
    setAiUnconfirmed(false);
    setAiTask(null);
    setPlans([]);
    setSuggestionDate(day);
    setSavedPlanCount(0);
    try {
      const stored = await findAiTask<PlannerResult>({
        userId: data.profile.id,
        endpoint: '/planner/suggest',
        payload: { date: day },
      });
      if (controller.signal.aborted) return;
      if (stored && !stored.acknowledged && !retryFailed && !continueRequest) {
        await inspectSuggestion(stored, controller.signal);
      } else {
        setPlans([]);
        const result = await runAiTask<PlannerResult>({
          userId: data.profile.id,
          endpoint: '/planner/suggest',
          payload: { date: day },
          retryFailed,
          signal: controller.signal,
          onStatus: (task) => {
            if (!controller.signal.aborted) setAiTask(task as PlannerTask);
          },
        });
        if (!controller.signal.aborted) showSuggestion(result, day);
      }
    } catch (e) {
      if (!controller.signal.aborted) setAiError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setAiBusy(false);
    }
  }
  async function checkPreviousRequest() {
    if (!aiTask || aiBusy) return;
    aiController.current?.abort();
    const controller = new AbortController();
    aiController.current = controller;
    setAiBusy(true);
    setAiError('');
    try {
      await inspectSuggestion(aiTask, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) setAiError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setAiBusy(false);
    }
  }
  function closeSuggestion() {
    if (busy) return;
    aiController.current?.abort();
    setAiBusy(false);
    setAiOpen(false);
  }
  async function applyPlan() {
    if (!plans[selectedPlan]) return;
    setBusy(true);
    setAiError('');
    let added = 0;
    const original = aiTask?.result ?? { plans };
    try {
      const current = await api<AppData>('/bootstrap');
      const recovered = recoverPlannerResult(original, suggestionDate, current.schedules);
      for (const block of recovered.plans[selectedPlan].blocks) {
        await api('/schedules', block);
        added++;
      }
      await refresh();
      await acknowledgeAiTask({
        userId: data.profile.id,
        endpoint: '/planner/suggest',
        payload: { date: suggestionDate },
      });
      setAiOpen(false);
      setPlans([]);
      setAiTask(null);
      toast(added ? `${added}개 일정을 시간표에 담았어요` : '저장된 일정을 확인했어요');
    } catch (e) {
      try {
        const current = await api<AppData>('/bootstrap');
        const recovered = recoverPlannerResult(original, suggestionDate, current.schedules);
        setPlans(recovered.plans);
        setSavedPlanCount(recovered.savedCount);
        await refresh();
      } catch {
        /* Keep the result for an explicit retry when connectivity returns. */
      }
      setAiError(
        added
          ? `${added}개 일정을 저장했어요. 다시 확인하면 저장된 일정은 건너뛰어요. ${(e as Error).message}`
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ScreenHeader
        title="시간표"
        action={
          <IconButton label="일정 추가" onClick={() => open()}>
            <Plus size={24} />
          </IconButton>
        }
      />
      <div className="page-inset pb-8">
        <div className="flex items-center justify-between mb-3">
          <span className="font-bold text-[17px] py-2">
            {new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long' }).format(
              new Date(`${day}T12:00:00`),
            )}
          </span>
          <div className="flex items-center">
            {day !== dateKey() && (
              <button
                onClick={() => setDay(dateKey())}
                className="min-h-11 px-2 text-[13px] font-semibold text-muted"
              >
                오늘
              </button>
            )}
            <IconButton label="이전 주" onClick={() => setDay(shiftDate(day, -7))}>
              <ChevronLeft size={20} />
            </IconButton>
            <IconButton label="다음 주" onClick={() => setDay(shiftDate(day, 7))}>
              <ChevronRight size={20} />
            </IconButton>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1.5 mb-6" aria-label="날짜 선택">
          {weekDates(day).map((date, index) => (
            <button
              key={date}
              aria-pressed={day === date}
              aria-current={date === dateKey() ? 'date' : undefined}
              aria-label={new Intl.DateTimeFormat('ko-KR', {
                month: 'long',
                day: 'numeric',
                weekday: 'long',
              }).format(new Date(`${date}T12:00:00`))}
              onClick={() => setDay(date)}
              className={`relative flex h-[68px] flex-col items-center justify-center gap-1 rounded-[18px] ${date === day ? 'bg-ink text-white' : 'text-muted'}`}
            >
              <span className="text-[12px] font-medium">{'월화수목금토일'[index]}</span>
              <span className={`text-[18px] font-bold ${date === day ? '' : 'text-ink'}`}>
                {Number(date.slice(-2))}
              </span>
              {data.schedules.some((s) => s.date.slice(0, 10) === date) && (
                <span
                  className={`absolute bottom-[7px] h-1 w-1 rounded-full ${date === day ? 'bg-white' : 'bg-brand'}`}
                />
              )}
            </button>
          ))}
        </div>
        {conflicts.length > 0 && (
          <button
            onClick={() => open(conflicts[0].find((s) => s.kind === 'FLEXIBLE') ?? conflicts[0][0])}
            className="mb-5 flex w-full items-center gap-3 rounded-2xl bg-ink px-4 py-3.5 text-left text-white"
          >
            <TriangleAlert size={20} className="shrink-0" />
            <span className="flex-1 text-[13px] font-semibold">
              {conflicts[0][0].title}와 {conflicts[0][1].title} 시간이 겹쳐요
            </span>
            <span className="text-[13px] font-bold whitespace-nowrap">바꾸기</span>
          </button>
        )}
        <div className="mb-4 flex justify-between items-center">
          <h2 className="font-bold text-[17px]">
            {day === dateKey()
              ? '오늘의 일정'
              : `${Number(day.slice(5, 7))}월 ${Number(day.slice(-2))}일 일정`}
          </h2>
          <span className="text-[13px] text-muted">
            {completed} / {schedules.length} 완료
          </span>
        </div>
        {!schedules.length ? (
          <EmptyState
            title="아직 여유로운 하루예요"
            description="학교, 학원처럼 정해진 시간부터 적어 볼까요?"
            action={
              <Button variant="secondary" onClick={() => open()}>
                <Plus size={18} />첫 일정 추가하기
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            {schedules.map((schedule) => {
              const gap = gaps.get(schedule.id);
              const current =
                !schedule.done &&
                day === dateKey(now) &&
                schedule.start <= currentTime &&
                currentTime < schedule.end;
              return (
                <Fragment key={schedule.id}>
                  {gap && (
                    <button
                      className="schedule-gap"
                      aria-label={`${gap.start}부터 ${gap.end}까지 ${durationLabel(gap.start, gap.end)} 여유 시간에 일정 추가`}
                      onClick={() => {
                        setEditing('new');
                        setForm({ ...blank(gap.date), start: gap.start, end: gap.end });
                        setError('');
                      }}
                    >
                      <span className="schedule-gap-description">
                        <Clock3 size={15} aria-hidden="true" />
                        {durationLabel(gap.start, gap.end)} 여유
                      </span>
                      <span className="schedule-gap-action">
                        <Plus size={16} aria-hidden="true" /> 일정 추가
                      </span>
                    </button>
                  )}
                  <div className="flex gap-3 items-start">
                    <span
                      className="schedule-time-range"
                      aria-label={`${schedule.start}부터 ${schedule.end}까지`}
                    >
                      <strong>{schedule.start}</strong>
                      <small>{schedule.end}</small>
                    </span>
                    <div
                      className={`flex flex-1 min-w-0 items-center rounded-[18px] ${schedule.done ? 'bg-canvas' : current ? 'bg-ink text-white' : 'bg-surface'}`}
                    >
                      <button
                        onClick={() => open(schedule)}
                        className="flex-1 min-w-0 px-4 py-[15px] text-left"
                      >
                        <span
                          className={`block text-[15px] font-bold break-words ${schedule.done ? 'line-through text-subtle' : ''}`}
                        >
                          {schedule.title}
                        </span>
                        <span
                          className={`mt-1 flex flex-wrap gap-x-1.5 items-center text-[12px] ${current ? 'text-white/70' : 'text-muted'}`}
                        >
                          {schedule.kind === 'FIXED' && <LockKeyhole size={12} />}
                          {durationLabel(schedule.start, schedule.end)}
                          {schedule.kind === 'FIXED' ? ' · 고정' : ''}
                          {current ? ' · 지금' : ''}
                        </span>
                      </button>
                      <button
                        disabled={busy}
                        aria-label={`${schedule.title} ${schedule.done ? '완료 취소' : '완료하기'}`}
                        aria-pressed={schedule.done}
                        onClick={() => toggle(schedule)}
                        className="p-3.5 shrink-0"
                      >
                        <span
                          className={`flex size-6 items-center justify-center rounded-full ${schedule.done ? 'bg-ink text-white' : current ? 'border-[1.5px] border-white/50' : 'border-[1.5px] border-line-strong'}`}
                        >
                          {schedule.done && <Check size={15} />}
                        </span>
                      </button>
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
        {!!schedules.length && (
          <button
            onClick={() => open()}
            className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl text-[14px] font-semibold text-muted"
          >
            <Plus size={18} />
            일정 추가
          </button>
        )}
        <div className="mt-6 flex justify-end">
          <Button onClick={() => void suggest()} disabled={aiBusy} className="!rounded-full">
            <Sparkles size={19} /> 빈 시간 추천받기
          </Button>
        </div>
      </div>
      <Sheet
        open={!!editing}
        onClose={() => !busy && setEditing(null)}
        title={editing === 'new' ? '어떤 일정을 담을까요?' : '일정 바꾸기'}
      >
        <form onSubmit={save} className="planner-editor flex flex-col gap-5">
          <label className="text-sm font-semibold">
            일정 이름
            <input
              autoFocus
              className="field mt-2"
              required
              maxLength={100}
              placeholder="예: 생명과학 개념 복습"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          {
            <div className="segmented-control">
              {(['FIXED', 'FLEXIBLE'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={form.kind === kind}
                  className="segment-option"
                  onClick={() => setForm({ ...form, kind })}
                >
                  {kind === 'FIXED' ? '고정 일정' : '자율 학습'}
                </button>
              ))}
            </div>
          }
          <label className="text-sm font-semibold">
            날짜
            <DateTimeField
              type="date"
              className="mt-2"
              required
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm font-semibold">
              시작
              <DateTimeField
                type="time"
                className="mt-2"
                required
                value={form.start}
                onChange={(e) => setForm({ ...form, start: e.target.value })}
              />
            </label>
            <label className="text-sm font-semibold">
              종료
              <DateTimeField
                type="time"
                className="mt-2"
                required
                value={form.end}
                onChange={(e) => setForm({ ...form, end: e.target.value })}
              />
            </label>
          </div>
          {form.start && form.end && !formValidation && (
            <p
              className={`-mt-2 flex items-start gap-2 text-[13px] leading-5 ${overlapping ? 'text-danger' : 'text-muted'}`}
              role={overlapping ? 'status' : undefined}
            >
              {overlapping ? (
                <TriangleAlert size={16} className="shrink-0 mt-0.5" />
              ) : (
                <Clock3 size={16} className="shrink-0 mt-0.5" />
              )}
              {overlapping
                ? `${overlapping.title}(${overlapping.start}–${overlapping.end})와 겹쳐요. 시간을 바꿔 주세요.`
                : `${durationLabel(form.start, form.end)} 동안 ${form.kind === 'FIXED' ? '고정된 일정이에요' : '공부할 시간이에요'}`}
            </p>
          )}
          {editing === 'new' && (
            <label className="text-sm font-semibold">
              연결할 과목
              <select
                className="field mt-2"
                value={form.subjectId}
                onChange={(e) => setForm({ ...form, subjectId: e.target.value })}
              >
                <option value="">과목 없이 추가</option>
                {data.subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || !!overlapping}>
            {busy ? '저장하고 있어요…' : '저장하기'}
          </Button>
          {editing !== 'new' && (
            <Button type="button" variant="ghost" onClick={remove} disabled={busy}>
              <Trash2 size={17} /> 일정 삭제
            </Button>
          )}
        </form>
      </Sheet>
      <Sheet open={aiOpen} onClose={closeSuggestion} title="빈 시간을 알차게 채워요">
        <p className="text-[15px] text-muted mb-5">
          고정 일정 사이의 빈 시간과 과목을 기준으로 두 가지 시간표를 만들어요. 추천을 확인하고 직접
          선택해 주세요.
        </p>
        {aiBusy && !plans.length && (
          <div role="status" className="py-10 text-center text-muted">
            <Sparkles className="mx-auto mb-3 animate-pulse" />
            {aiTask?.status === 'READY'
              ? '추천 요청을 준비하고 있어요'
              : '시간표를 살펴보고 있어요'}
            <p className="mt-3 text-[13px] leading-5">
              화면을 닫아도 요청은 남아 있어요.
              <br />
              다시 들어오면 결과를 확인할 수 있어요.
            </p>
          </div>
        )}
        {aiError && (
          <div role="alert" className="rounded-2xl bg-surface p-5 mb-5">
            <Clock3 size={24} className="mb-3" />
            <p className="text-[15px] leading-6">{aiError}</p>
            {aiTask && (
              <div className="mt-4 flex flex-col gap-2">
                <Button variant="secondary" onClick={checkPreviousRequest} disabled={aiBusy}>
                  이전 요청 확인
                </Button>
                {(aiTask.status === 'FAILED' || aiTask.status === 'INTERRUPTED') && (
                  <Button onClick={() => void suggest(true)} disabled={aiBusy}>
                    새로 추천받기
                  </Button>
                )}
                {(aiTask.status === 'READY' || aiUnconfirmed) && (
                  <Button onClick={() => void suggest(false, true)} disabled={aiBusy}>
                    같은 요청 이어서 보내기
                  </Button>
                )}
              </div>
            )}
            <button
              className="text-[14px] font-bold mt-4"
              onClick={() => {
                closeSuggestion();
                open();
              }}
            >
              직접 일정 추가하기 →
            </button>
          </div>
        )}
        {!!plans.length && (
          <p className="mb-4 text-[13px] text-muted">
            {Number(suggestionDate.slice(5, 7))}월 {Number(suggestionDate.slice(-2))}일 시간표
            {savedPlanCount > 0 ? ` · 저장한 ${savedPlanCount}개는 제외했어요` : ''}
          </p>
        )}
        <div className="flex flex-col gap-3">
          {plans.map((plan, i) => (
            <button
              key={plan.name}
              disabled={busy || aiBusy}
              onClick={() => {
                setSelectedPlan(i);
                setSavedPlanCount(
                  Math.max(
                    0,
                    (aiTask?.result?.plans[i]?.blocks.length ?? plan.blocks.length) -
                      plan.blocks.length,
                  ),
                );
              }}
              aria-pressed={selectedPlan === i}
              className={`text-left p-5 rounded-[20px] ${selectedPlan === i ? 'bg-ink text-white' : 'bg-surface'}`}
            >
              <span className="flex justify-between mb-3 font-bold text-[18px]">
                {plan.name}
                {selectedPlan === i && <Check size={21} />}
              </span>
              {plan.blocks.map((b, j) => (
                <span className="flex gap-3 text-sm py-1" key={j}>
                  <span className="opacity-60 tabular-nums">{b.start}</span>
                  {b.title}
                </span>
              ))}
            </button>
          ))}
        </div>
        {!!plans.length && (
          <Button className="w-full mt-5" onClick={applyPlan} disabled={busy || aiBusy}>
            {busy
              ? '일정을 담고 있어요…'
              : plans[selectedPlan]?.blocks.length
                ? `${plans[selectedPlan]?.name}로 채우기`
                : '저장된 일정 확인하고 닫기'}
          </Button>
        )}
      </Sheet>
    </>
  );
}
