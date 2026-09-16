'use client';
import { CommunityAsk } from '../social/community-ask';
import { useEffect, useState } from 'react';
import { Check, ChevronRight, Eye, PencilLine, RotateCcw } from '@/components/icons';
import type { Essay, Material, ScreenProps } from '@/lib/contracts';
import {
  findEssayDraft,
  saveEssayDraft,
  removeEssayDraft,
  essayRevision,
} from '@/lib/study-drafts';
import { useJourneyLayer, useJourneyState } from '../journey';
import { Button, EmptyState, IconButton, ScreenHeader } from '@/components/ui';
import {
  acknowledgeAiTask,
  AiTaskFailureError,
  AiTaskPendingError,
  findAiTask,
  inspectAiTask,
  runAiTask,
  type AiTaskRecord,
} from '@/lib/ai-task';
import { useRetryCountdown, waitingLabel } from '@/lib/retry-countdown';
import {
  essaySelection,
  toggleEssayKeyword,
  appendEssayOrder,
  restartEssayOrder,
  completeEssayOutline,
  essayPracticeStart,
} from '@/lib/essay-interaction';
import { exactKeywords, latestAttempts, mix } from './logic';
import {
  BusyText,
  Chip,
  Citation,
  ErrorNote,
  GenerationSheet,
  MaterialViewer,
  params,
  Progress,
  SubjectSelect,
  useAction,
} from './shared';

type Feedback = { score: number; matched: string[]; missing: string[]; feedback: string };
export function EssayScreen(props: ScreenProps) {
  const query = params(props.path);
  const [subject, setSubject] = useJourneyState('essay.subject', query.get('subject') || '');
  const selected = props.data.essays.find((e) => e.id === query.get('essay'));
  const [generate, setGenerate] = useState(false);
  if (selected)
    return (
      <EssayExercise
        key={selected.id}
        essay={selected}
        props={props}
        onBack={() => {
          const rest = new URLSearchParams(query);
          rest.delete('essay');
          rest.delete('revise');
          props.back(`/essay${rest.size ? `?${rest}` : ''}`);
        }}
      />
    );
  const essays = props.data.essays.filter(
    (e) =>
      (!subject || e.subjectId === subject) &&
      (!query.get('material') || e.materialId === query.get('material')),
  );
  const latest = latestAttempts(props.data.attempts, 'essayId');
  return (
    <>
      <ScreenHeader title="서술형 코칭" back={() => props.back('/study')} />
      <div className="page-inset pb-8">
        <h2 className="mt-3 text-[26px] font-extrabold leading-[1.3] tracking-[-.035em]">
          아는 것을
          <br />내 문장으로 꺼내는 연습
        </h2>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          바로 써 보고 코칭을 받아 보세요.
          <br />
          막힐 때는 키워드와 예시로 연습할 수 있어요.
        </p>
        <div className="mt-6">
          <SubjectSelect data={props.data} value={subject} onChange={setSubject} />
        </div>
        <div className="mt-4">
          {essays.map((e) => (
            <button
              key={e.id}
              className="flex min-h-[100px] w-full items-center gap-3 py-4 text-left"
              onClick={() => {
                const next = new URLSearchParams(query);
                next.set('essay', e.id);
                props.navigate(`/essay?${next}`);
              }}
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface">
                <PencilLine size={22} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="mb-1 block text-[12px] text-muted">
                  {props.data.subjects.find((s) => s.id === e.subjectId)?.name} ·{' '}
                  {latest.get(e.id) ? `지난 점수 ${latest.get(e.id)!.score}점` : '아직 안 푼 문제'}
                </span>
                <span className="line-clamp-2 text-[15px] font-bold leading-relaxed">
                  {e.prompt}
                </span>
              </span>
              <ChevronRight size={18} className="shrink-0 text-disabled" />
            </button>
          ))}
          {!essays.length && (
            <EmptyState
              title="아직 서술형 문제가 없어요"
              description="학습 자료를 선택해서 나만의 서술형 문제를 만들어 보세요."
            />
          )}
        </div>
        <Button className="mt-5 w-full" variant="secondary" onClick={() => setGenerate(true)}>
          서술형 문제 만들기
        </Button>
      </div>
      <GenerationSheet
        open={generate}
        onClose={() => setGenerate(false)}
        props={props}
        mode="essay"
      />
    </>
  );
}
function EssayExercise({
  essay,
  props,
  onBack,
}: {
  essay: Essay;
  props: ScreenProps;
  onBack: () => void;
}) {
  const previous = latestAttempts(props.data.attempts, 'essayId').get(essay.id);
  const [draft] = useState(() => {
    const saved = findEssayDraft(props.data.profile.id, essay);
    return saved && (!previous || Date.parse(saved.updatedAt) > Date.parse(previous.createdAt))
      ? saved
      : undefined;
  });
  const initial = essayPracticeStart(
    draft,
    params(props.path).get('revise') === '1' ? previous?.answer : undefined,
  );
  const [stage, setStage] = useState(initial.stage);
  const [guided, setGuided] = useState(initial.guided);
  const [keywordHelp, setKeywordHelp] = useState(false);
  const choices = mix([...new Set([...essay.keywords, ...essay.distractors])]);
  const [selected, setSelected] = useState<string[]>(() =>
    essaySelection(draft?.selected || [], choices, essay.keywords.length),
  );
  const [checked, setChecked] = useState(false);
  const [order, setOrder] = useState(() =>
    essaySelection(
      draft?.stage && draft.stage > 1 ? draft.order : [],
      essay.keywords,
      essay.keywords.length,
    ),
  );
  const [hint, setHint] = useState(draft?.hint || false);
  const [answer, setAnswer] = useState(initial.answer);
  const [coaching, setCoaching] = useState(draft?.coaching || '');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [viewer, setViewer] = useState<{ material: Material; citation?: string } | null>(null);
  const [task, setTask] = useState<AiTaskRecord | null>(null);
  const action = useAction();
  // A refused or interrupted grading that said when to come back keeps the button waiting.
  const retryIn = useRetryCountdown(action.retryAt, task?.retryAt);
  useEffect(() => {
    if (feedback) {
      removeEssayDraft(props.data.profile.id, essay.id);
    } else if (selected.length || guided || answer.trim().length) {
      saveEssayDraft(props.data.profile.id, {
        essayId: essay.id,
        revision: essayRevision(essay),
        stage,
        guided,
        coaching,
        selected,
        order,
        hint,
        answer,
        updatedAt: new Date().toISOString(),
      });
    } else {
      removeEssayDraft(props.data.profile.id, essay.id);
    }
  }, [
    props.data.profile.id,
    essay,
    stage,
    guided,
    coaching,
    selected,
    order,
    hint,
    answer,
    feedback,
    previous?.answer,
  ]);
  // jitter: none — one status GET for a stored submission on navigation, with no loop [site src/components/study/essay.tsx:197]
  useEffect(() => {
    const controller = new AbortController();
    findAiTask<Feedback>({
      userId: props.data.profile.id,
      endpoint: '/essay/submit',
      match: { essayId: essay.id },
    })
      .then(async (stored) => {
        if (!stored || controller.signal.aborted) return;
        const recovered = await inspectAiTask(stored, controller.signal).catch(() => stored);
        if (controller.signal.aborted) return;
        const current = recovered || stored;
        setTask(current);
        if (typeof current.payload.answer === 'string') setAnswer(current.payload.answer);
        setStage(4);
        if (current.status === 'COMPLETED' && current.result) {
          setFeedback(current.result);
          await props.refresh();
          await acknowledgeAiTask({
            userId: props.data.profile.id,
            endpoint: '/essay/submit',
            payload: current.payload,
          });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          action.setError(
            error instanceof Error ? error.message : '이전 답안을 불러오지 못했어요.',
          );
      });
    return () => controller.abort();
    // Recovery only reads a previously submitted answer; it never starts a new evaluation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [essay.id, props.data.profile.id]);
  const labels = ['키워드', '글의 순서', '예시 비교', '답안 작성'];
  const keywords = choices;
  const material = props.data.materials.find((m) => m.id === essay.materialId);
  const closeGuide = useJourneyLayer(guided && !feedback, () => {
    if (feedback) return;
    setGuided(false);
    setStage(4);
  });
  const backToKeywords = useJourneyLayer(guided && stage >= 2 && !feedback, () => {
    if (feedback) return;
    setStage(1);
    setChecked(false);
  });
  const backToOrder = useJourneyLayer(guided && stage >= 3 && !feedback, () => {
    if (feedback) return;
    setStage(2);
  });
  const backToHint = useJourneyLayer(guided && stage >= 4 && !feedback, () => {
    if (feedback) return;
    setStage(3);
  });
  const previousStage =
    stage === 4
      ? backToHint
      : stage === 3
        ? backToOrder
        : stage === 2
          ? backToKeywords
          : closeGuide;
  const allKeywords = exactKeywords(selected, essay.keywords);
  const outlineComplete = completeEssayOutline(order, essay.keywords);
  const unchangedRevision = !!previous && answer.trim() === previous.answer.trim();
  const pending = action.busy || task?.status === 'RUNNING' || task?.status === 'READY';
  return (
    <>
      <ScreenHeader title="서술형 코칭" back={guided && !feedback ? previousStage : onBack} />
      <div className="page-inset pb-8">
        {guided && !feedback && (
          <div className="essay-steps" aria-label="선택한 연습 도움 단계">
            {labels.map((label, i) => (
              <div
                key={label}
                className={`essay-step ${stage === i + 1 ? 'current' : ''}`}
                aria-current={stage === i + 1 ? 'step' : undefined}
              >
                <div
                  className={`mb-2 h-1 rounded-full ${stage >= i + 1 ? 'bg-brand' : 'bg-surface'}`}
                />
                <span
                  className={`text-[12px] font-semibold ${stage === i + 1 ? 'text-ink' : 'text-muted'}`}
                >
                  {i + 1}. {label}
                </span>
              </div>
            ))}
          </div>
        )}
        {!feedback && (
          <>
            <span className="text-[13px] font-semibold text-muted">
              {guided ? `연습 도움 · ${labels[stage - 1]}` : '서술형 연습'}
            </span>
            <h1 className="mt-2 whitespace-pre-line text-[25px] font-extrabold leading-[1.35] tracking-[-.035em]">
              {stage === 1
                ? `설명에 필요한 키워드\n${essay.keywords.length}개를 골라 주세요`
                : stage === 2
                  ? '설명할 순서대로\n생각을 정리해 보세요'
                  : stage === 3
                    ? '예시와 비교하며\n생각을 다듬어 보세요'
                    : params(props.path).get('revise') === '1' || coaching
                      ? '내 답안을\n더 명확하게 다듬어 보세요'
                      : '내 문장으로\n설명해 보세요'}
            </h1>
            <p className="essay-prompt">{essay.prompt}</p>
          </>
        )}
        {stage === 1 && !feedback && (
          <>
            <div className="essay-selection-summary" aria-live="polite">
              <span>
                {keywords.length}개 중 {essay.keywords.length}개 선택
              </span>
              <strong>
                {selected.length} / {essay.keywords.length}
              </strong>
            </div>
            <p id="keyword-instruction" className="text-[13px] leading-relaxed text-muted">
              {selected.length === essay.keywords.length
                ? '다 골랐어요. 바꾸려면 선택한 단어를 먼저 눌러 해제하세요.'
                : '질문을 설명하는 데 꼭 필요한 단어만 골라 주세요.'}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {keywords.map((word) => (
                <button
                  key={word}
                  aria-pressed={selected.includes(word)}
                  disabled={!selected.includes(word) && selected.length >= essay.keywords.length}
                  aria-describedby="keyword-instruction"
                  onClick={() => {
                    setChecked(false);
                    setSelected((current) =>
                      toggleEssayKeyword(current, word, choices, essay.keywords.length),
                    );
                  }}
                  className="keyword-option"
                >
                  {selected.includes(word) && <Check size={17} className="shrink-0" />}
                  {word}
                </button>
              ))}
            </div>
            <div className="mt-6 space-y-3">
              {checked && !allKeywords && (
                <p role="alert" className="rounded-2xl bg-surface p-4 text-[14px] leading-relaxed">
                  {selected.some((k) => !essay.keywords.includes(k))
                    ? '이 답안의 핵심 키워드와 다른 선택이 있어요. 근거에서 어떤 작용을 설명하는지 확인해 보세요.'
                    : `필요한 키워드가 더 있어요. ${essay.keywords.length}개를 모두 골라 주세요.`}
                </p>
              )}
              <Button
                className="w-full"
                disabled={selected.length !== essay.keywords.length}
                onClick={() => {
                  setChecked(true);
                  if (allKeywords) {
                    setChecked(false);
                    setStage(2);
                    window.scrollTo({ top: 0 });
                  }
                }}
              >
                키워드 확인하기
              </Button>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => setKeywordHelp((shown) => !shown)}
              >
                {keywordHelp ? '핵심 키워드와 근거 접기' : '핵심 키워드와 근거 보기'}
              </Button>
              {keywordHelp && (
                <div className="rounded-2xl bg-surface p-4 space-y-3">
                  <p className="text-sm font-semibold">{essay.keywords.join(' · ')}</p>
                  <p className="text-sm leading-relaxed">{essay.citation}</p>
                  <Button
                    className="w-full"
                    variant="secondary"
                    onClick={() => {
                      setSelected(essay.keywords);
                      setStage(2);
                      window.scrollTo({ top: 0 });
                    }}
                  >
                    이 키워드로 생각 정리하기
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
        {stage === 2 && !feedback && (
          <>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              글에서 설명할 순서대로 골라 주세요. 문장으로 관계를 설명하면 되므로 정해진 단어 순서를
              맞힐 필요는 없어요.
            </p>
            <div className="essay-selection-summary" aria-live="polite">
              <span>
                {order.length < essay.keywords.length
                  ? `${order.length + 1}번째에 올 키워드를 골라 주세요`
                  : '순서를 모두 채웠어요'}
              </span>
              <strong>
                {order.length} / {essay.keywords.length}
              </strong>
            </div>
            <ol className="essay-order" aria-label="내가 정한 키워드 순서">
              {essay.keywords.map((_, index) => {
                const word = order[index];
                return (
                  <li key={index} className={index === order.length ? 'is-next' : ''}>
                    <span className="essay-order-number">{index + 1}</span>
                    {word ? (
                      <button
                        onClick={() => {
                          setOrder(restartEssayOrder(order, index));
                        }}
                        aria-label={`${index + 1}번째 ${word}, 여기부터 다시 고르기`}
                      >
                        <strong>{word}</strong>
                        <span>여기부터 다시</span>
                      </button>
                    ) : (
                      <span className="essay-order-empty">
                        {index === order.length
                          ? '아래에서 선택해 주세요'
                          : '아직 선택하지 않았어요'}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            <div
              className="mt-4 grid grid-cols-2 gap-2"
              role="group"
              aria-label="다음 순서에 놓을 키워드"
            >
              {mix(essay.keywords).map((word) => (
                <button
                  key={word}
                  className="keyword-option"
                  disabled={order.includes(word)}
                  aria-pressed={order.includes(word)}
                  onClick={() => {
                    setOrder((current) => appendEssayOrder(current, word, essay.keywords));
                  }}
                >
                  {word}
                </button>
              ))}
            </div>
            <div className="essay-order-tools">
              <button
                disabled={!order.length}
                onClick={() => {
                  setOrder(order.slice(0, -1));
                }}
              >
                <RotateCcw size={15} /> 마지막 선택 취소
              </button>
              <button
                disabled={!order.length}
                onClick={() => {
                  setOrder([]);
                }}
              >
                처음부터
              </button>
            </div>
            <Button
              className="w-full"
              disabled={!outlineComplete}
              onClick={() => {
                setStage(3);
                window.scrollTo({ top: 0 });
              }}
            >
              이 흐름으로 이어가기
            </Button>
            <Button className="mt-2 w-full" variant="ghost" onClick={backToKeywords}>
              키워드 다시 고르기
            </Button>
          </>
        )}
        {stage === 3 && !feedback && (
          <>
            <div className="mt-5 rounded-2xl bg-surface p-4">
              <h2 className="text-sm font-bold">내가 정한 글의 순서</h2>
              <ol className="mt-3 space-y-2">
                {order.map((word, i) => (
                  <li key={word} className="text-sm">
                    {i + 1}. {word}
                  </li>
                ))}
              </ol>
            </div>
            {hint ? (
              <div className="mt-4 rounded-2xl bg-surface p-4">
                <h2 className="text-sm font-bold">예시 답안</h2>
                <p className="mt-3 text-sm leading-relaxed">{essay.modelAnswer}</p>
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  표현과 설명 순서는 달라도 괜찮아요. 핵심 내용과 관계가 드러나도록 써 보세요.
                </p>
              </div>
            ) : (
              <Button className="mt-4 w-full" variant="secondary" onClick={() => setHint(true)}>
                <Eye size={17} /> 예시 답안 보기
              </Button>
            )}
            <Button
              className="mt-6 w-full"
              onClick={() => {
                setStage(4);
                window.scrollTo({ top: 0 });
              }}
            >
              답안 쓰기
            </Button>
            <Button className="mt-2 w-full" variant="ghost" onClick={backToOrder}>
              순서 다시 정하기
            </Button>
          </>
        )}
        {stage === 4 && !feedback && (
          <>
            {guided && (
              <p className="mt-4 text-sm leading-relaxed text-muted">
                내 글의 순서 · {order.join(' → ')}
              </p>
            )}
            {!guided && (
              <p className="mt-3 text-sm leading-relaxed text-muted">
                {params(props.path).get('revise') === '1' || coaching
                  ? '지난 답안을 가져왔어요. 빠진 내용이나 설명이 부족한 부분을 고쳐 보세요.'
                  : '먼저 떠오르는 대로 써 보세요. 막히면 아래에서 키워드와 예시의 도움을 받을 수 있어요.'}
              </p>
            )}
            {coaching && (
              <details className="mt-4 rounded-2xl bg-surface p-4">
                <summary className="cursor-pointer text-sm font-semibold">
                  보완할 내용 다시 보기
                </summary>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{coaching}</p>
              </details>
            )}
            <label className="mt-5 block">
              <span className="sr-only">서술형 답안</span>
              <textarea
                className="field min-h-60 resize-y !bg-canvas text-[16px] leading-[1.8]"
                maxLength={5000}
                value={answer}
                disabled={action.busy || task?.status === 'RUNNING' || task?.status === 'READY'}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="왜 그런지, 어떻게 이어지는지 내 말로 설명해 주세요."
              />
            </label>
            <p className="mt-2 text-right text-xs text-muted">
              {answer.trim().length < 10 ? '10자 이상 쓰면 코칭을 받을 수 있어요 · ' : ''}
              {answer.length} / 5,000자
            </p>
            {!guided && (
              <Button
                className="mt-3 w-full"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setGuided(true);
                  setStage(1);
                  window.scrollTo({ top: 0 });
                }}
              >
                막혔나요? 키워드부터 연습하기
              </Button>
            )}
            {previous?.answer && (
              <details className="mt-4 rounded-2xl bg-surface p-4">
                <summary className="cursor-pointer text-sm font-semibold">
                  지난 답안 보기 · {previous.score}점
                </summary>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">
                  {previous.answer}
                </p>
                <Button
                  className="mt-3 w-full"
                  variant="secondary"
                  disabled={pending || !!answer.trim()}
                  onClick={() => setAnswer(previous.answer!)}
                >
                  지난 답안 가져와 고치기
                </Button>
                {!!answer.trim() && (
                  <p className="mt-2 text-xs text-muted">
                    작성 중인 내용을 지우지 않도록 가져오기는 빈 답안에서만 가능해요.
                  </p>
                )}
              </details>
            )}
            <div className="mt-5 space-y-3">
              {!props.data.aiAvailable && (
                <p className="rounded-2xl bg-surface p-4 text-sm leading-relaxed text-secondary">
                  키워드·순서·분량 기준으로 연습 채점해요. AI 의미 평가는 연결 준비가 끝나면 이용할
                  수 있어요.
                </p>
              )}
              {task && (task.status === 'RUNNING' || task.status === 'READY') && !action.busy && (
                <p className="rounded-2xl bg-surface p-4 text-sm leading-relaxed">
                  채점이 진행 중이에요. 화면을 나갔다 돌아와도 이어서 확인할 수 있어요.
                </p>
              )}
              {task && (task.status === 'FAILED' || task.status === 'INTERRUPTED') && (
                <p className="rounded-2xl bg-surface p-4 text-sm leading-relaxed">
                  {task.error || '이전 채점을 마치지 못했어요.'} 새로 채점 요청하기를 누르면 다시
                  시작해요.
                </p>
              )}
              <ErrorNote error={action.error} />
              {unchangedRevision && (
                <p className="text-sm text-muted" role="status">
                  지난 답안과 같아요. 내용을 고치면 다시 코칭을 받을 수 있어요.
                </p>
              )}
              <Button
                className="w-full"
                disabled={
                  answer.trim().length < 10 ||
                  unchangedRevision ||
                  action.busy ||
                  (retryIn > 0 && task?.status !== 'RUNNING' && task?.status !== 'READY')
                }
                onClick={() =>
                  action.run(async () => {
                    const lookup = {
                      userId: props.data.profile.id,
                      endpoint: '/essay/submit' as const,
                      payload: { essayId: essay.id, answer: answer.trim() },
                    };
                    try {
                      // jitter: none — students finish their answers at different times; the wait loop's timing is runAiTask's [site src/components/study/essay.tsx:486]
                      const response = await runAiTask<Feedback>({
                        ...lookup,
                        retryFailed: task?.status === 'FAILED' || task?.status === 'INTERRUPTED',
                        onStatus: setTask,
                      });
                      setFeedback(response);
                      await props.refresh();
                      await acknowledgeAiTask(lookup);
                      window.scrollTo({ top: 0 });
                    } catch (error) {
                      if (
                        error instanceof AiTaskFailureError ||
                        error instanceof AiTaskPendingError
                      )
                        setTask(error.task);
                      throw error;
                    }
                  })
                }
              >
                {action.busy ? (
                  <BusyText>답안을 읽고 있어요</BusyText>
                ) : task?.status === 'RUNNING' || task?.status === 'READY' ? (
                  '이전 채점 이어가기'
                ) : task?.status === 'FAILED' || task?.status === 'INTERRUPTED' ? (
                  waitingLabel('새로 채점 요청하기', retryIn)
                ) : props.data.aiAvailable ? (
                  waitingLabel('답안 제출하고 코칭 받기', retryIn)
                ) : (
                  '연습 채점 받기'
                )}
              </Button>
              {guided && (
                <Button className="w-full" variant="ghost" disabled={pending} onClick={backToHint}>
                  내 글의 순서와 예시 다시 보기
                </Button>
              )}
            </div>
          </>
        )}
        {feedback && (
          <div className="space-y-5">
            <div>
              <p className="text-[13px] font-semibold text-muted">내 문장으로 설명했어요</p>
              <h1 className="mt-2 text-[42px] font-extrabold tracking-[-.04em]">
                {feedback.score}점
              </h1>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                {feedback.score === 100
                  ? '핵심 내용을 잘 설명했어요. 이 답안의 보완을 마쳤어요.'
                  : '코칭을 참고해 답안을 고쳐 보세요. 보완할 답안은 오답노트의 서술형 탭에 모아 두었어요.'}
              </p>
            </div>
            <div className="rounded-[20px] bg-surface p-4">
              <h2 className="mb-3 text-[15px] font-bold">내가 쓴 답안</h2>
              <p className="whitespace-pre-wrap text-sm leading-[1.8] text-secondary">{answer}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-surface p-4">
                <p className="text-xs text-muted">포함한 키워드</p>
                <strong className="mt-1 block text-[25px]">
                  {feedback.matched.length}
                  <span className="text-sm font-medium text-muted"> / {essay.keywords.length}</span>
                </strong>
              </div>
              <div className="rounded-2xl bg-surface p-4">
                <p className="text-xs text-muted">답안 분량</p>
                <strong className="mt-1 block text-[25px]">
                  {answer.length}
                  <span className="text-sm font-medium text-muted"> 자</span>
                </strong>
              </div>
            </div>
            <div className="rounded-[20px] bg-ink p-5 text-white">
              <h2 className="text-[15px] font-bold">이렇게 다듬어 보세요</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-[1.8] text-white/85">
                {feedback.feedback}
              </p>
              {feedback.missing.length > 0 && (
                <p className="mt-3 text-xs text-white/70">
                  보완할 키워드 · {feedback.missing.join(', ')}
                </p>
              )}
            </div>
            <Citation
              citation={essay.citation}
              material={material}
              onOpen={() => setViewer(material ? { material, citation: essay.citation } : null)}
            />
            <CommunityAsk {...props} essay={essay} kind="ESSAY" />
            <ErrorNote error={action.error} />
            {feedback.score < 100 && (
              <Button
                className="w-full"
                onClick={() => {
                  setCoaching(feedback.feedback);
                  setFeedback(null);
                  setGuided(false);
                  setStage(4);
                  setTask(null);
                  action.setError('');
                }}
              >
                답안 고쳐 쓰기
              </Button>
            )}
            <Button
              className="w-full"
              variant={feedback.score === 100 ? 'primary' : 'secondary'}
              onClick={onBack}
            >
              다른 서술형 문제 보기
            </Button>
          </div>
        )}
        {guided && !feedback && (
          <Button className="mt-4 w-full" variant="ghost" disabled={pending} onClick={closeGuide}>
            도움 닫고 답안으로 돌아가기
          </Button>
        )}
      </div>
      <MaterialViewer
        material={viewer?.material ?? null}
        citation={viewer?.citation}
        onClose={() => setViewer(null)}
      />
    </>
  );
}
