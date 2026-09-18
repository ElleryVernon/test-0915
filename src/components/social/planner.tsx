'use client';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Plus,
  Sparkles,
  TriangleAlert,
} from '@/components/icons';
import { api } from '@/lib/api';
import {
  acknowledgeAiTask,
  findAiTask,
  inspectAiTask,
  listAiTasks,
  markAiTaskSeen,
  runAiTask,
} from '@/lib/ai-task';
import { retryAtOf, useRetryCountdown, waitingLabel } from '@/lib/retry-countdown';
import { PLANNER_COPY, progressCopy } from '@/lib/ai-progress';
import type { AppData, Schedule, ScreenProps } from '@/lib/contracts';
import {
  formatMinutes,
  minutes,
  scheduleGaps,
  scheduleMatchesDraft,
  timeString,
} from '@/lib/schedule';
import { isDue } from '@/lib/srs';
import { Button, EmptyState, ErrorNote, IconButton, ScreenHeader, Sheet } from '@/components/ui';
import { useJourneyState } from '../journey';
import ScheduleEditor, { type ScheduleDraft, type ScheduleReceipt } from './planner-editor';
import { PlannerWorkspace } from './planner-workspace';
import workspaceStyles from './planner-workspace.module.css';
import { MonthSheet } from './planner-pickers';
import { SchoolRegistrationForm } from './school-registration';
import {
  ceilTime,
  dateKey,
  dayLabel,
  defaultSlot,
  durationLabel,
  josa,
  particle,
  plannerRows,
  shiftDate,
  studyProgress,
  weekDates,
} from './helpers';

import {
  readyToast,
  recoverPlannerResult,
  suggestionState,
  type Plan,
  type PlannerResult,
  type PlannerTask,
} from './planner-suggestion';

export { recoverPlannerResult };
type Gap = { start: string; end: string };
const clock = (date: Date) =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

const FAILURE_TITLE = {
  failed: '추천을 만들지 못했어요',
  unconfirmed: '요청이 전달됐는지 확인하지 못했어요',
  waiting: '추천을 아직 만들고 있어요',
  empty: '추천할 빈 시간이 없어요',
  unknown: '추천을 불러오지 못했어요',
};
const blockMinutes = (blocks: Pick<Schedule, 'start' | 'end'>[]) =>
  blocks.reduce((sum, block) => sum + minutes(block.end) - minutes(block.start), 0);

export default function Planner({ data, refresh, toast }: ScreenProps) {
  const [now, setNow] = useState(() => new Date());
  const today = dateKey(now);
  const [day, setDay] = useJourneyState('planner.day', today);
  type EditorDraft = {
    editing: Schedule | null;
    initial: ScheduleDraft;
    baseline?: ScheduleDraft;
    receipt?: ScheduleReceipt;
  };
  const [drafts, setDrafts] = useJourneyState<Record<string, EditorDraft>>('planner.drafts', {});
  const [editor, setEditor] = useState<{
    key: string;
    receipt?: ScheduleReceipt;
    editing: Schedule | null;
    initial: ScheduleDraft;
    baseline?: ScheduleDraft;
  } | null>(null);
  useEffect(() => {
    const completed = Object.entries(drafts)
      .filter(
        ([, draft]) =>
          data.schedules.some(
            (schedule) =>
              (!draft.editing || schedule.id === draft.editing.id) &&
              !draft.initial.repeat &&
              scheduleMatchesDraft(schedule, draft.initial),
          ) ||
          (!!draft.receipt &&
            !!draft.editing &&
            !data.schedules.some((schedule) => schedule.id === draft.editing!.id)),
      )
      .map(([key]) => key);
    if (completed.length)
      setDrafts((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => !completed.includes(key))),
      );
  }, [data.schedules, drafts, setDrafts]);
  const [monthOpen, setMonthOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [schoolBusy, setSchoolBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiContext, setAiContext] = useState<{ free: number; gap?: Gap }>({ free: 0 });
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planMethod, setPlanMethod] = useState('');
  const [planDropped, setPlanDropped] = useState(0);
  const [selectedPlan, setSelectedPlan] = useState(0);
  const [aiError, setAiError] = useState('');
  const [aiTask, setAiTask] = useState<PlannerTask | null>(null);
  // A refusal (or a stored failure) that said when to come back keeps the retry buttons waiting.
  const [aiRetryAt, setAiRetryAt] = useState<number | null>(null);
  const retryIn = useRetryCountdown(aiRetryAt, aiTask?.retryAt);
  const [aiBusy, setAiBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [aiUnconfirmed, setAiUnconfirmed] = useState(false);
  const [suggestionDate, setSuggestionDate] = useState(day);
  const [savedPlanCount, setSavedPlanCount] = useState(0);
  // Unacknowledged suggestions on this device, and the day of a request from an earlier visit being polled.
  const [stored, setStored] = useState<PlannerTask[]>([]);
  const [resumed, setResumed] = useState<string | null>(null);
  // The latest record of a request resumed on entry, for its stage; and when the shown request began.
  const [resumedTask, setResumedTask] = useState<PlannerTask | null>(null);
  const requestStartedAt = useRef<number | null>(null);
  const resumeController = useRef<AbortController | null>(null);
  const interacting = useRef(false);
  interacting.current = !!editor || monthOpen || workspaceOpen;
  const viewedDay = useRef(day);
  viewedDay.current = day;
  const aiController = useRef<AbortController | null>(null);
  const nowLine = useRef<HTMLDivElement>(null);
  const scrollToNow = useRef(true);
  const strip = useRef<HTMLDivElement>(null);
  const focusDay = useRef(false);
  const swipe = useRef<{ x: number; y: number; swiped: boolean } | null>(null);
  // jitter: none — a local 60 s clock for due counts and gaps; it sends no request [site src/components/social/planner.tsx:113]
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const isToday = day === today;
  const nowTime = clock(now);
  const daySchedules = useMemo(
    () =>
      data.schedules
        .filter((s) => s.date.slice(0, 10) === day)
        .sort((a, b) => a.start.localeCompare(b.start)),
    [data.schedules, day],
  );
  const rows = plannerRows(daySchedules, { now: isToday ? nowTime : undefined, minGap: 25 }).filter(
    (row) => row.type !== 'gap' || day >= today,
  );
  const freeMinutes = rows.reduce(
    (sum, row) => sum + (row.type === 'gap' && row.minutes >= 60 ? row.minutes : 0),
    0,
  );
  const progress = studyProgress(daySchedules);
  const dueBySubject = useMemo(() => {
    const counts = new Map<string, number>();
    const at = now.getTime();
    for (const card of data.cards)
      if (isDue(card, at)) counts.set(card.subjectId, (counts.get(card.subjectId) ?? 0) + 1);
    return counts;
  }, [data.cards, now]);
  const subjectNames = new Map(data.subjects.map((s) => [s.id, s.name]));
  const weekday = new Date(`${day}T12:00:00`).getDay() % 6 !== 0;
  const suggestionContext = { today, now: nowTime, schedules: data.schedules };
  // The newest stored suggestion of a day decides that day's button; an unseen one elsewhere gets a notice.
  const dayTask = stored.find((task) => String(task.payload.date) === day);
  const dayState = dayTask ? suggestionState(dayTask, suggestionContext).kind : null;
  const reopenable = dayState === 'ready' || dayState === 'seen' ? dayTask : undefined;
  const readyElsewhere = stored.find(
    (task) =>
      String(task.payload.date) !== day &&
      suggestionState(task, suggestionContext).kind === 'ready',
  );
  const freeOn = (date: string) =>
    plannerRows(
      data.schedules
        .filter((s) => s.date.slice(0, 10) === date)
        .sort((a, b) => a.start.localeCompare(b.start)),
      { now: date === today ? nowTime : undefined },
    ).reduce((sum, row) => sum + (row.type === 'gap' ? row.minutes : 0), 0);
  const ctaVisible = day >= today && (freeMinutes >= 60 || !!reopenable);
  const generating = (aiBusy && !aiOpen && suggestionDate === day) || resumed === day;
  // Elapsed seconds since the request itself started (its stored createdAt when resumed), so the
  // count does not restart when the indicator reappears; the stage comes from the recorded steps.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!generating) return setElapsed(0);
    const startedAt = requestStartedAt.current ?? Date.now();
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    // jitter: none — an elapsed-time counter in the UI; it sends nothing [site src/components/social/planner.tsx:171]
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [generating]);
  const aiProgress = progressCopy(
    PLANNER_COPY,
    (resumed === day ? resumedTask : aiTask)?.steps,
    elapsed,
  );
  const announced =
    aiTask?.status === 'READY' && resumed !== day ? '추천 요청을 준비하는 중' : aiProgress.stage;
  const generatingCopy =
    aiTask?.status === 'READY'
      ? '추천 요청을 준비하는 중'
      : elapsed >= 5000
        ? `${aiProgress.stage} · ${aiProgress.elapsed}`
        : aiProgress.stage;
  const working = (
    <>
      <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
      {generatingCopy}
    </>
  );

  useLayoutEffect(() => {
    if (!scrollToNow.current || !isToday) return;
    const line = nowLine.current;
    scrollToNow.current = false;
    if (line && line.getBoundingClientRect().bottom > window.innerHeight - 160)
      line.scrollIntoView({ block: 'center' });
  });
  useEffect(() => {
    if (!focusDay.current) return;
    focusDay.current = false;
    strip.current?.querySelector<HTMLButtonElement>(`[data-date="${day}"]`)?.focus();
  }, [day]);

  function draftFor(date: string, gap?: Gap): ScheduleDraft {
    const blank = { title: '', date, kind: 'FLEXIBLE' as const, subjectId: '' };
    if (gap)
      return {
        ...blank,
        start: gap.start,
        end: timeString(Math.min(minutes(gap.end), minutes(gap.start) + 60)),
      };
    return {
      ...blank,
      ...defaultSlot(
        data.schedules.filter((s) => s.date.slice(0, 10) === date),
        date === today ? ceilTime(now, 10) : undefined,
      ),
    };
  }
  const openNew = (gap?: Gap, date = day) => {
    const initial = draftFor(date, gap);
    const key = `new:${date}:${initial.start}`;
    setEditor({ key, ...(drafts[key] ?? { editing: null, initial, baseline: initial }) });
  };
  const forgetDraft = (key: string) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  const openEdit = (schedule: Schedule) =>
    setEditor({
      key: `edit:${schedule.id}`,
      ...(drafts[`edit:${schedule.id}`] ?? {
        editing: schedule,
        baseline: {
          title: schedule.title,
          date: schedule.date.slice(0, 10),
          start: schedule.start,
          end: schedule.end,
          kind: schedule.kind,
          subjectId: schedule.subjectId ?? '',
        },
        initial: {
          title: schedule.title,
          date: schedule.date.slice(0, 10),
          start: schedule.start,
          end: schedule.end,
          kind: schedule.kind,
          subjectId: schedule.subjectId ?? '',
        },
      }),
    });
  function goToday() {
    scrollToNow.current = true;
    setDay(today);
    if (isToday) {
      nowLine.current?.scrollIntoView({ block: 'center' });
      scrollToNow.current = false;
    }
  }

  async function toggle(schedule: Schedule) {
    if (pending) return;
    setPending(schedule.id);
    try {
      await api(`/schedules/${schedule.id}`, { done: !schedule.done }, 'PATCH');
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setPending(null);
    }
  }
  async function applyFix(schedule: Schedule, fix: { start: string; end: string; kind: string }) {
    if (pending) return;
    setPending(schedule.id);
    try {
      await api(`/schedules/${schedule.id}`, { start: fix.start, end: fix.end }, 'PATCH');
      await refresh();
      toast(
        `${josa(schedule.title, '을')} ${josa(`${fix.start}–${fix.end}`, '으로')} ${fix.kind === 'move' ? '옮겼어요' : '줄였어요'}`,
      );
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setPending(null);
    }
  }

  function onStripKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!step) return;
    event.preventDefault();
    focusDay.current = true;
    setDay(shiftDate(day, step));
  }
  function onStripDown(event: PointerEvent<HTMLDivElement>) {
    swipe.current = { x: event.clientX, y: event.clientY, swiped: false };
  }
  function onStripUp(event: PointerEvent<HTMLDivElement>) {
    const start = swipe.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      start.swiped = true;
      setDay(shiftDate(day, dx < 0 ? 7 : -7));
    } else swipe.current = null;
  }

  // AI suggestions: the durable task keeps one request per date; acknowledging ends it.
  const schedulesRef = useRef(data.schedules);
  schedulesRef.current = data.schedules;
  function showSuggestion(result: PlannerResult, date: string) {
    const recovered = recoverPlannerResult(result, date, schedulesRef.current);
    setSuggestionDate(recovered.date);
    setPlans(recovered.plans);
    setPlanMethod(result.method ?? '');
    setPlanDropped(result.dropped ?? 0);
    setSelectedPlan(recovered.selectedIndex);
    setSavedPlanCount(recovered.savedCount);
    setAiError(
      result.plans.some((plan) => plan.blocks.length)
        ? ''
        : '담을 수 있는 빈 시간을 찾지 못했어요. 직접 추가하거나 다른 날을 골라 보세요.',
    );
  }
  async function inspectSuggestion(task: PlannerTask, signal: AbortSignal) {
    setAiUnconfirmed(false);
    requestStartedAt.current = task.createdAt;
    setAiTask(task);
    let latest = await inspectAiTask<PlannerResult>(task, signal);
    // jitter: none — a fixed 1600 ms poll (up to 45) started by a tap; errors are thrown to the caller [site src/components/social/planner.tsx:314]
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
  // Entering the planner never opens a sheet or changes the day. Stored suggestions only change the
  // fill button; a request left running is polled (never sent again) and announced when it lands.
  const lookup = { userId: data.profile.id, endpoint: '/planner/suggest' as const };
  async function refreshStored() {
    setStored(await listAiTasks<PlannerResult>(lookup));
  }
  async function resume(task: PlannerTask, signal: AbortSignal) {
    const date = String(task.payload.date);
    requestStartedAt.current = task.createdAt;
    setResumedTask(task);
    setResumed(date);
    try {
      let latest = await inspectAiTask<PlannerResult>(task, signal);
      // jitter: none — each student's own visit starts it, the first error ends it, nothing re-aligns it [site src/components/social/planner.tsx:346]
      for (let poll = 0; latest?.status === 'RUNNING' && poll < 45 && !signal.aborted; poll++) {
        setResumedTask(latest);
        await new Promise((resolve) => setTimeout(resolve, 1600));
        if (signal.aborted) return;
        latest = await inspectAiTask<PlannerResult>(latest, signal);
      }
      if (signal.aborted) return;
      const at = new Date();
      const context = { today: dateKey(at), now: clock(at), schedules: schedulesRef.current };
      const message =
        latest && suggestionState(latest, context).kind === 'ready'
          ? readyToast(date, viewedDay.current, context.today)
          : null;
      if (message) toast(message);
      await refreshStored();
    } catch {
      /* The next visit polls again. */
    } finally {
      if (!signal.aborted) setResumed(null);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    resumeController.current = controller;
    void (async () => {
      try {
        const at = new Date();
        const context = { today: dateKey(at), now: clock(at), schedules: schedulesRef.current };
        const live: PlannerTask[] = [];
        for (const task of await listAiTasks<PlannerResult>(lookup)) {
          if (suggestionState(task, context).kind !== 'stale') live.push(task);
          // A stale result ends here and never returns; failed or running ones age out with their day.
          else if (task.status === 'COMPLETED')
            await acknowledgeAiTask({ ...lookup, payload: task.payload });
        }
        if (controller.signal.aborted) return;
        setStored(live);
        const running = live.find((task) => task.status === 'RUNNING');
        if (running) await resume(running, controller.signal);
      } catch {
        /* The planner works without its stored suggestions. */
      }
    })();
    return () => {
      controller.abort();
      aiController.current?.abort();
    };
  }, [data.profile.id]);
  // The first time a result is on screen it becomes "seen"; after that only the button brings it back.
  useEffect(() => {
    if (!aiOpen || aiTask?.status !== 'COMPLETED' || !plans.some((plan) => plan.blocks.length))
      return;
    void markAiTaskSeen({ ...lookup, payload: aiTask.payload }).then(refreshStored, () => {});
  }, [aiOpen, aiTask, plans]);
  /** Opens a stored result from the button or the notice without sending a request. */
  function reviewStored(task: PlannerTask, gap?: Gap) {
    if (aiBusy || !task.result) return;
    const date = String(task.payload.date);
    setDay(date);
    setAiContext({ free: freeOn(date), gap });
    setAiTask(task);
    setAiUnconfirmed(false);
    try {
      showSuggestion(task.result, date);
    } catch (e) {
      setPlans([]);
      setAiError((e as Error).message);
    }
    setAiOpen(true);
  }
  async function suggest(
    options: { gap?: Gap; retryFailed?: boolean; continueRequest?: boolean } = {},
  ) {
    const { gap, retryFailed = false, continueRequest = false } = options;
    if (aiBusy) return;
    // The learner's own request takes over from a background poll of an earlier one.
    resumeController.current?.abort();
    setResumed(null);
    aiController.current?.abort();
    const controller = new AbortController();
    aiController.current = controller;
    // Today's proposals must not start in time that has already passed.
    const payload = isToday ? { date: day, after: ceilTime(new Date(), 5) } : { date: day };
    if (!retryFailed && !continueRequest) setAiContext({ free: freeMinutes, gap });
    // Every request works on the screen itself (button, free-time rows, toast), including retries
    // started from the sheet; the sheet only ever shows a result or an error.
    const startedAt = Date.now();
    requestStartedAt.current = startedAt;
    setAiOpen(false);
    toast(
      retryFailed
        ? '추천을 다시 만들고 있어요'
        : continueRequest
          ? '같은 요청을 이어서 보내고 있어요'
          : '빈 시간에 맞는 공부를 찾고 있어요',
    );
    setAiError('');
    setAiBusy(true);
    setAiUnconfirmed(false);
    setPlans([]);
    setSuggestionDate(day);
    setSavedPlanCount(0);
    try {
      const stored = await findAiTask<PlannerResult>({
        userId: data.profile.id,
        endpoint: '/planner/suggest',
        match: { date: day },
      });
      if (controller.signal.aborted) return;
      const stale =
        stored &&
        suggestionState(stored, { today, now: clock(new Date()), schedules: schedulesRef.current })
          .kind === 'stale';
      // A result that no longer fits ends here; the tap asks for a fresh one.
      if (stored && stale && stored.status === 'COMPLETED')
        await acknowledgeAiTask({ ...lookup, payload: stored.payload });
      if (stored && !stale && !retryFailed && !continueRequest) {
        await inspectSuggestion(stored, controller.signal);
      } else {
        // Continuing or retrying keeps the stored identity so no second task lingers for the day.
        const request =
          (continueRequest || retryFailed) && aiTask && !stale ? aiTask.payload : payload;
        setAiTask(null);
        // jitter: none — one request per tap; polling and cooldown belong to the ai-task loop [site src/components/social/planner.tsx:466]
        const result = await runAiTask<PlannerResult>({
          userId: data.profile.id,
          endpoint: '/planner/suggest',
          payload: request,
          retryFailed,
          signal: controller.signal,
          onStatus: (task) => {
            if (!controller.signal.aborted) setAiTask(task as PlannerTask);
          },
        });
        if (!controller.signal.aborted) showSuggestion(result, day);
      }
      setAiRetryAt(null);
    } catch (e) {
      if (!controller.signal.aborted) {
        setAiError((e as Error).message);
        setAiRetryAt(retryAtOf(e));
      }
    } finally {
      await revealResult(controller, startedAt);
    }
  }
  /** Keeps the working state readable even for an instant result, then opens the sheet. */
  async function revealResult(controller: AbortController, startedAt: number) {
    if (controller.signal.aborted) return;
    // jitter: none — a 900 ms minimum reveal for the UI only; it sends nothing [site src/components/social/planner.tsx:488]
    const rest = 900 - (Date.now() - startedAt);
    if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
    if (controller.signal.aborted) return;
    setAiBusy(false);
    await refreshStored().catch(() => {});
    if (viewedDay.current === day && !interacting.current) setAiOpen(true);
    else toast(`${dayLabel(day)} 추천 요청 결과를 확인해 주세요.`);
  }
  async function checkPreviousRequest() {
    if (!aiTask || aiBusy) return;
    aiController.current?.abort();
    const controller = new AbortController();
    aiController.current = controller;
    const startedAt = Date.now();
    setAiOpen(false);
    toast('이전 요청을 확인하고 있어요');
    setAiBusy(true);
    setAiError('');
    try {
      await inspectSuggestion(aiTask, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) setAiError((e as Error).message);
    } finally {
      await revealResult(controller, startedAt);
    }
  }
  function closeSuggestion() {
    if (applying) return;
    aiController.current?.abort();
    setAiBusy(false);
    setAiOpen(false);
    void refreshStored().catch(() => {});
  }
  async function declineSuggestion() {
    if (applying) return;
    if (aiTask?.status === 'COMPLETED')
      await acknowledgeAiTask({
        userId: data.profile.id,
        endpoint: '/planner/suggest',
        payload: aiTask.payload,
      }).catch(() => {});
    closeSuggestion();
    setPlans([]);
    setAiTask(null);
    openNew(aiContext.gap, suggestionDate);
  }
  async function applyPlan() {
    if (!plans[selectedPlan]) return;
    setApplying(true);
    setAiError('');
    let added = 0;
    const original = aiTask?.result ?? { plans };
    try {
      const current = await api<AppData>('/bootstrap');
      const recovered = recoverPlannerResult(original, suggestionDate, current.schedules);
      const blocks = recovered.plans[selectedPlan].blocks;
      if (blocks.length) {
        const saved = await api<{ added: number }>('/schedules/batch', { blocks });
        added = saved.added;
      }
      await refresh();
      if (aiTask)
        await acknowledgeAiTask({
          userId: data.profile.id,
          endpoint: '/planner/suggest',
          payload: aiTask.payload,
        });
      setAiOpen(false);
      setPlans([]);
      setAiTask(null);
      toast(added ? `${added}개 일정을 시간표에 담았어요` : '저장된 일정을 확인했어요');
      void refreshStored().catch(() => {});
    } catch (e) {
      // jitter: none — one bounded re-read after a failed tap, no loop [site src/components/social/planner.tsx:558]
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
      setApplying(false);
    }
  }

  const monthLabel =
    day.slice(0, 4) === today.slice(0, 4)
      ? `${Number(day.slice(5, 7))}월`
      : `${day.slice(0, 4)}년 ${Number(day.slice(5, 7))}월`;
  const fixedTitles = [
    ...new Set(
      data.schedules
        .filter((s) => s.date.slice(0, 10) === suggestionDate && s.kind === 'FIXED')
        .map((s) => s.title.trim()),
    ),
  ];
  const selected = plans[selectedPlan];
  // What went wrong decides the single next action: retry, resend, re-check or add by hand.
  const failure: keyof typeof FAILURE_TITLE =
    aiTask?.status === 'FAILED' || aiTask?.status === 'INTERRUPTED'
      ? 'failed'
      : aiTask?.status === 'READY' || aiUnconfirmed
        ? 'unconfirmed'
        : aiTask?.status === 'RUNNING'
          ? 'waiting'
          : aiTask?.status === 'COMPLETED'
            ? 'empty'
            : 'unknown';
  function meta(schedule: Schedule) {
    const length = durationLabel(schedule.start, schedule.end);
    if (schedule.kind === 'FIXED') {
      const subject = schedule.subjectId ? subjectNames.get(schedule.subjectId) : '';
      return [length, subject && !schedule.title.includes(subject) ? subject : ''];
    }
    if (schedule.done) return [length, '완료'];
    const subject = schedule.subjectId ? subjectNames.get(schedule.subjectId) : '';
    const due = schedule.subjectId ? (dueBySubject.get(schedule.subjectId) ?? 0) : 0;
    return [
      length,
      subject && !schedule.title.includes(subject) ? subject : '',
      due ? `복습 카드 ${due}장` : '',
    ];
  }

  return (
    <>
      <ScreenHeader
        title="시간표"
        action={
          <div className="planner-header-actions">
            <button type="button" className="planner-header-chip" onClick={goToday}>
              오늘
            </button>
            <button
              type="button"
              className="planner-header-chip"
              aria-haspopup="dialog"
              aria-label={`${day.slice(0, 4)}년 ${Number(day.slice(5, 7))}월 · 날짜 고르기`}
              onClick={() => setMonthOpen(true)}
            >
              {monthLabel}
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            <IconButton label="일정 추가" onClick={() => openNew()}>
              <Plus size={24} />
            </IconButton>
          </div>
        }
      />
      <div className="page-inset planner-screen">
        <button
          type="button"
          className={workspaceStyles.entryPoint}
          onClick={() => setWorkspaceOpen(true)}
          aria-haspopup="dialog"
        >
          <span>
            <strong>이번 주 계획 세우기</strong>
            <small>할 일에 시간 배치 · 학원 시간표 후보 비교</small>
          </span>
          <ChevronRight size={20} />
        </button>
        <div className="flex items-center justify-between">
          <IconButton label="이전 주" onClick={() => setDay(shiftDate(day, -7))}>
            <ChevronLeft size={18} />
          </IconButton>
          <span className="text-sm text-muted">
            {dayLabel(weekDates(day)[0])} – {dayLabel(weekDates(day)[6])}
          </span>
          <IconButton label="다음 주" onClick={() => setDay(shiftDate(day, 7))}>
            <ChevronRight size={18} />
          </IconButton>
        </div>
        <div
          ref={strip}
          className="week-strip"
          role="group"
          aria-label="날짜 선택 · 좌우로 밀면 주가 바뀌어요"
          onKeyDown={onStripKey}
          onPointerDown={onStripDown}
          onPointerUp={onStripUp}
          onPointerCancel={() => (swipe.current = null)}
          onClickCapture={(event) => {
            if (swipe.current?.swiped) {
              event.preventDefault();
              event.stopPropagation();
            }
            swipe.current = null;
          }}
        >
          {weekDates(day).map((date, index) => (
            <button
              key={date}
              data-date={date}
              className="week-day"
              tabIndex={date === day ? 0 : -1}
              aria-pressed={day === date}
              aria-current={date === today ? 'date' : undefined}
              aria-label={`${dayLabel(date, 'long')}${data.schedules.some((s) => s.date.slice(0, 10) === date) ? ', 일정 있음' : ''}`}
              onClick={() => setDay(date)}
            >
              <span className="week-day-name">{'월화수목금토일'[index]}</span>
              <span className="week-day-number">{Number(date.slice(-2))}</span>
              <i data-on={data.schedules.some((s) => s.date.slice(0, 10) === date)} />
            </button>
          ))}
        </div>

        {Object.keys(drafts).length > 0 && (
          <section className="planner-drafts" aria-label="작성 중인 일정">
            <h2>
              이어서 진행하기 <span>{Object.keys(drafts).length}</span>
            </h2>
            {Object.entries(drafts).map(([key, draft]) => (
              <button
                key={key}
                type="button"
                className="planner-draft-card"
                onClick={() => setEditor({ key, ...draft })}
              >
                <span className="planner-draft-copy">
                  <span className="planner-draft-state">
                    {draft.receipt
                      ? '저장 확인 필요'
                      : draft.editing
                        ? '수정 중 · 아직 반영 전'
                        : '작성 중 · 아직 등록 전'}
                  </span>
                  <strong>{draft.initial.title.trim() || '새 일정'}</strong>
                  <span className="planner-draft-meta">
                    {dayLabel(draft.initial.date)} · {draft.initial.start}–{draft.initial.end}
                  </span>
                </span>
                <span className="planner-draft-action">
                  {draft.receipt ? '확인' : '이어쓰기'}
                  <ChevronRight size={15} aria-hidden="true" />
                </span>
              </button>
            ))}
          </section>
        )}

        {readyElsewhere && (
          <button
            type="button"
            className="planner-hint planner-ready"
            data-date={String(readyElsewhere.payload.date)}
            disabled={aiBusy}
            onClick={() => reviewStored(readyElsewhere)}
          >
            <Sparkles size={16} aria-hidden="true" />
            <span>{dayLabel(String(readyElsewhere.payload.date))} 추천이 준비됐어요</span>
            <strong>
              보기
              <ChevronRight size={12} aria-hidden="true" />
            </strong>
          </button>
        )}

        {progress.count > 0 ? (
          <div className="planner-progress">
            <div className="planner-progress-copy">
              <p>
                {progress.doneMinutes === progress.minutes ? (
                  <>공부 {josa(formatMinutes(progress.minutes), '을')} 모두 마쳤어요</>
                ) : !progress.doneMinutes && day > today ? (
                  <>공부 {josa(formatMinutes(progress.minutes), '을')} 계획했어요</>
                ) : (
                  <>
                    공부 {formatMinutes(progress.minutes)} 중{' '}
                    <em>{formatMinutes(progress.doneMinutes)}</em> 했어요
                  </>
                )}
              </p>
              <span aria-label={`자율 학습 ${progress.count}개 중 ${progress.doneCount}개 완료`}>
                {progress.doneCount}/{progress.count}
              </span>
            </div>
            <div
              className="planner-progress-bar"
              role="progressbar"
              aria-label="공부 시간 진행"
              aria-valuemin={0}
              aria-valuemax={progress.minutes}
              aria-valuenow={progress.doneMinutes}
            >
              <span style={{ width: `${(progress.doneMinutes / progress.minutes) * 100}%` }} />
            </div>
          </div>
        ) : daySchedules.length ? (
          <p className="planner-progress-empty">자율 학습을 담으면 공부 시간을 함께 세어 드려요</p>
        ) : null}

        {!daySchedules.length ? (
          <EmptyState
            title="비어 있는 하루예요"
            description={
              day < today
                ? '이날 담긴 일정이 없어요. 지난 공부도 기록으로 남길 수 있어요.'
                : weekday
                  ? '학교·학원처럼 정해진 시간부터 담으면 남는 공부 시간을 정확히 계산해요.'
                  : '공부할 시간을 직접 담거나 추천을 받아 보세요.'
            }
            action={
              <div className="planner-empty-actions">
                <Button variant="secondary" onClick={() => openNew()}>
                  <Plus size={18} /> 일정 추가
                </Button>
                {day >= today && (
                  <Button
                    variant="ghost"
                    className={generating ? 'is-loading' : ''}
                    aria-busy={generating}
                    onClick={() => void suggest()}
                    disabled={aiBusy}
                  >
                    {generating ? (
                      working
                    ) : (
                      <>
                        <Sparkles size={18} />
                        공부 일정 추천받기
                      </>
                    )}
                  </Button>
                )}
              </div>
            }
          />
        ) : (
          <div className="planner-list">
            {rows.map((row) => {
              if (row.type === 'now')
                return (
                  <div
                    key="now"
                    ref={nowLine}
                    className="planner-now"
                    role="separator"
                    aria-label={`지금 ${row.time}`}
                  >
                    <span>{row.time}</span>
                    <i />
                  </div>
                );
              if (row.type === 'gap')
                return (
                  <div key={`gap-${row.start}`} className="planner-row">
                    <span className="planner-gap-time" aria-hidden="true">
                      {row.start}
                      <br />
                      {row.end}
                    </span>
                    <button
                      type="button"
                      className="planner-gap"
                      aria-label={`${row.start}부터 ${row.end}까지 ${formatMinutes(row.minutes)} 비어 있어요. 일정 추가`}
                      onClick={() => openNew({ start: row.start, end: row.end })}
                    >
                      <span>{formatMinutes(row.minutes)} 비어 있어요</span>
                      <strong>
                        일정 추가
                        <Plus size={12} aria-hidden="true" />
                      </strong>
                    </button>
                  </div>
                );
              if (row.type === 'conflict') {
                const { movable, fix, other } = row;
                const range = fix ? `${fix.start}–${fix.end}` : '';
                return (
                  <div key={row.id} className="planner-row">
                    <span />
                    <div className="planner-conflict" role="status">
                      <span>
                        <TriangleAlert size={15} aria-hidden="true" />
                        <span className="truncate">
                          {`${other.title}${particle(other.title, '과')}`}{' '}
                          {formatMinutes(row.overlap)} 겹쳐요
                        </span>
                      </span>
                      {movable && fix ? (
                        <button
                          type="button"
                          disabled={!!pending}
                          aria-label={`${josa(movable.title, '을')} ${josa(range, '으로')} ${fix.kind === 'move' ? '옮기기' : '줄이기'}`}
                          onClick={() => void applyFix(movable, fix)}
                        >
                          {fix.kind === 'move'
                            ? `${josa(fix.start, '으로')} 옮기기`
                            : `${josa(range, '으로')} 줄이기`}
                        </button>
                      ) : (
                        <button type="button" onClick={() => openEdit(row.anchor)}>
                          바꾸기
                        </button>
                      )}
                    </div>
                  </div>
                );
              }
              const { schedule, current } = row;
              const fixed = schedule.kind === 'FIXED';
              const done = !fixed && schedule.done;
              const state = current ? 'current' : done ? 'done' : fixed ? 'fixed' : 'open';
              return (
                <div key={schedule.id} className="planner-row planner-item" data-state={state}>
                  <span
                    className="planner-time"
                    aria-label={`${schedule.start}부터 ${schedule.end}까지`}
                  >
                    <strong>{schedule.start}</strong>
                    <small>{schedule.end}</small>
                  </span>
                  <div className="planner-card">
                    <button
                      type="button"
                      className="planner-card-main"
                      onClick={() => openEdit(schedule)}
                    >
                      <span className="planner-card-title">{schedule.title}</span>
                      <span className="planner-card-meta">
                        {meta(schedule).filter(Boolean).join(' · ')}
                        {current ? <span className="sr-only"> · 지금</span> : null}
                      </span>
                    </button>
                    {fixed ? (
                      <span className="planner-card-tag">고정</span>
                    ) : (
                      <button
                        type="button"
                        className="planner-check"
                        disabled={!!pending}
                        aria-label={`${schedule.title} ${schedule.done ? '완료 취소' : '완료하기'}`}
                        aria-pressed={schedule.done}
                        onClick={() => void toggle(schedule)}
                      >
                        <span>{schedule.done && <Check size={13} />}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="planner-row">
              <span />
              <Button variant="secondary" className="planner-add" onClick={() => openNew()}>
                <Plus size={18} aria-hidden="true" />
                일정 추가
              </Button>
            </div>
          </div>
        )}
        {ctaVisible && <div className="planner-cta-space" aria-hidden="true" />}
        <span className="sr-only" role="status">
          {generating ? announced : ''}
        </span>
      </div>
      {ctaVisible && (
        <div className="planner-cta">
          <Button
            className={`w-full${generating ? ' is-loading' : ''}`}
            aria-busy={generating}
            onClick={() => (reopenable ? reviewStored(reopenable) : void suggest())}
            disabled={aiBusy}
          >
            {generating ? (
              working
            ) : reopenable ? (
              <>
                <Sparkles size={18} />
                {dayState === 'seen' ? '추천 다시 보기' : '추천 보기'}
              </>
            ) : (
              <>
                <Sparkles size={18} />빈 시간 추천받기
              </>
            )}
          </Button>
        </div>
      )}

      {workspaceOpen && (
        <PlannerWorkspace
          data={data}
          day={day}
          onClose={() => setWorkspaceOpen(false)}
          onSaved={async (message, date) => {
            await refresh();
            setDay(date);
            setWorkspaceOpen(false);
            toast(message);
          }}
        />
      )}
      {editor && (
        <ScheduleEditor
          key={editor.key}
          data={data}
          editing={editor.editing}
          initial={editor.initial}
          hasDraft={!!drafts[editor.key]}
          schoolBusy={schoolBusy}
          schoolPanel={
            <SchoolRegistrationForm
              data={data}
              day={day}
              today={today}
              onBusyChange={setSchoolBusy}
              onViewDate={(date) => {
                setDay(date);
                setEditor(null);
              }}
              onSaved={async (message, date) => {
                await refresh();
                setDay(date);
                setEditor(null);
                toast(message);
              }}
            />
          }
          receipt={editor.receipt}
          onDraft={(initial, receipt) => {
            // A no-op selection or returning to the original values is not an unfinished task.
            if (
              !receipt &&
              editor.baseline &&
              !initial.repeat &&
              scheduleMatchesDraft(editor.baseline, initial)
            ) {
              forgetDraft(editor.key);
              return;
            }
            setDrafts((current) => ({
              ...current,
              [editor.key]: {
                editing: editor.editing,
                initial,
                receipt,
                baseline: editor.baseline,
              },
            }));
          }}
          onDiscard={() => {
            forgetDraft(editor.key);
            setEditor(null);
            toast('초안을 버렸어요');
          }}
          onClose={() => {
            setEditor(null);
          }}
          onSaved={async (date, message) => {
            await refresh();
            forgetDraft(editor.key);
            setDay(date);
            setEditor(null);
            toast(message);
          }}
        />
      )}
      {monthOpen && (
        <MonthSheet
          day={day}
          today={today}
          schedules={data.schedules}
          onClose={() => setMonthOpen(false)}
          onPick={(date) => {
            scrollToNow.current = date === today;
            setDay(date);
            setMonthOpen(false);
          }}
        />
      )}

      <Sheet
        open={aiOpen}
        onClose={closeSuggestion}
        title={aiError && !plans.length ? FAILURE_TITLE[failure] : '공부 일정을 골라 보세요'}
        description={
          aiError && !plans.length
            ? dayLabel(suggestionDate)
            : `${dayLabel(suggestionDate)} · ${
                fixedTitles.length === 0
                  ? '지금 있는 일정은 그대로 둬요'
                  : fixedTitles.length <= 2
                    ? `${fixedTitles.join('·')} 시간은 피했어요`
                    : `고정 일정 ${fixedTitles.length}개는 피했어요`
              }`
        }
      >
        {aiError && plans.length > 0 && <ErrorNote error={aiError} />}
        {aiError && !plans.length && (
          <div className="planner-error">
            <ErrorNote error={aiError} />
            <div className="planner-submit">
              {failure === 'failed' && (
                <Button disabled={retryIn > 0} onClick={() => void suggest({ retryFailed: true })}>
                  {waitingLabel('새로 추천받기', retryIn)}
                </Button>
              )}
              {failure === 'unconfirmed' && (
                <>
                  <Button onClick={() => void suggest({ continueRequest: true })}>
                    같은 요청 이어서 보내기
                  </Button>
                  <Button variant="secondary" onClick={checkPreviousRequest}>
                    이전 요청 확인
                  </Button>
                </>
              )}
              {failure === 'waiting' && (
                <Button onClick={checkPreviousRequest}>다시 확인하기</Button>
              )}
              {failure === 'unknown' && (
                <Button disabled={retryIn > 0} onClick={() => void suggest()}>
                  {waitingLabel('다시 시도하기', retryIn)}
                </Button>
              )}
              <Button
                variant={failure === 'empty' ? 'primary' : 'ghost'}
                onClick={() => void declineSuggestion()}
              >
                직접 일정 추가하기
              </Button>
            </div>
          </div>
        )}
        {!!plans.length && (
          <>
            {savedPlanCount > 0 && (
              <p className="planner-help mb-3">저장한 {savedPlanCount}개는 목록에서 뺐어요</p>
            )}
            <div className="planner-plans">
              {plans.map((plan, i) => {
                const total = blockMinutes(plan.blocks);
                return (
                  <button
                    key={`${i}-${plan.name}`}
                    type="button"
                    className="planner-plan"
                    disabled={applying || aiBusy}
                    aria-pressed={selectedPlan === i}
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
                  >
                    <span className="planner-plan-head">
                      <span>
                        <strong>{plan.name}</strong>
                        <small>
                          {plan.blocks.length}개 일정 · 공부 {formatMinutes(total)}
                        </small>
                      </span>
                      <i>{selectedPlan === i && <Check size={13} />}</i>
                    </span>
                    {plan.blocks.length ? (
                      <span className="planner-plan-blocks">
                        {plan.blocks.map((block, j) => (
                          <span key={j} className="planner-plan-block">
                            <b>{block.start}</b>
                            <span>{block.title}</span>
                            <small>{durationLabel(block.start, block.end)}</small>
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="planner-help">담을 블록이 남아 있지 않아요</span>
                    )}
                    {plan.blocks.length > 0 && (
                      <span className="planner-plan-foot">
                        <span>{formatMinutes(total)}</span>
                        <span>{plan.blocks.length}개</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="planner-help text-center planner-plan-note">
              담은 뒤에도 하나씩 옮기거나 지울 수 있어요 · 닫아도 아래 버튼으로 다시 볼 수 있어요
              {planMethod === 'AI+규칙'
                ? ' · 한 안은 규칙 기반이에요'
                : planMethod && planMethod !== 'AI'
                  ? ' · 규칙 기반 추천이에요'
                  : ''}
              {planDropped > 0 ? ` · 조건에 맞지 않는 ${planDropped}개는 뺐어요` : ''}
            </p>
            <div className="planner-submit">
              <Button onClick={applyPlan} disabled={applying || aiBusy}>
                {applying
                  ? '일정을 담고 있어요…'
                  : selected?.blocks.length
                    ? `${josa(selected.name, '으로')} ${selected.blocks.length}개 담기`
                    : '저장된 일정 확인하고 닫기'}
              </Button>
              <Button variant="ghost" onClick={() => void declineSuggestion()} disabled={applying}>
                둘 다 아니에요 · 직접 추가
              </Button>
            </div>
          </>
        )}
      </Sheet>
    </>
  );
}
