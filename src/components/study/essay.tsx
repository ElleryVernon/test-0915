'use client';
import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Eye,
  GripVertical,
  LockKeyhole,
  PencilLine,
  RotateCcw,
} from '@/components/icons';
import type { Essay, Material, ScreenProps } from '@/lib/contracts';
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
import { exactKeywords, exactOrder, latestAttempts, mix } from './logic';
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
  const [subject, setSubject] = useState(query.get('subject') || '');
  const [selected, setSelected] = useState<Essay | null>(
    props.data.essays.find((e) => e.id === query.get('essay')) || null,
  );
  const [generate, setGenerate] = useState(false);
  if (selected)
    return (
      <EssayExercise
        key={selected.id}
        essay={selected}
        props={props}
        onBack={() => {
          setSelected(null);
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
      <ScreenHeader title="서술형 코칭" back={() => props.navigate('/study')} />
      <div className="page-inset pb-8">
        <h2 className="mt-3 text-[26px] font-extrabold leading-[1.3] tracking-[-.035em]">
          아는 것을
          <br />내 문장으로 꺼내는 연습
        </h2>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          키워드를 고르고, 순서를 연결하면
          <br />빈 답안도 차근차근 채워져요.
        </p>
        <div className="my-6 grid grid-cols-4 gap-2">
          {['키워드', '순서', '도식 힌트', '실전 서술'].map((label, i) => (
            <div key={label} className="rounded-2xl bg-surface px-1 py-3 text-center">
              <span className="text-[20px] font-extrabold">{i + 1}</span>
              <span className="mt-1 block text-[11px] font-semibold text-muted">{label}</span>
            </div>
          ))}
        </div>
        <SubjectSelect data={props.data} value={subject} onChange={setSubject} />
        <div className="mt-4">
          {essays.map((e) => (
            <button
              key={e.id}
              className="flex min-h-[100px] w-full items-center gap-3 py-4 text-left"
              onClick={() => setSelected(e)}
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
  const [stage, setStage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
  const [order, setOrder] = useState(mix(essay.keywords));
  const [hint, setHint] = useState(false);
  const [answer, setAnswer] = useState(previous?.answer || '');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [viewer, setViewer] = useState<Material | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const [task, setTask] = useState<AiTaskRecord | null>(null);
  const action = useAction();
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
  const labels = ['키워드 고르기', '순서 연결하기', '도식 힌트', '실전 서술'];
  const keywords = mix([...essay.keywords, ...essay.distractors]);
  const material = props.data.materials.find((m) => m.id === essay.materialId);
  function move(from: number, to: number) {
    if (to < 0 || to >= order.length) return;
    setOrder((current) => {
      const next = [...current];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  }
  const allKeywords = exactKeywords(selected, essay.keywords);
  const ordered = exactOrder(order, essay.keywords);
  return (
    <>
      <ScreenHeader title="서술형 코칭" back={onBack} />
      <div className="page-inset pb-8">
        <div className="essay-steps" aria-label="서술형 4단계">
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
        {!feedback && (
          <>
            <span className="text-[13px] font-semibold text-muted">
              {stage}단계 · {labels[stage - 1]}
            </span>
            <h1 className="mt-2 whitespace-pre-line text-[25px] font-extrabold leading-[1.35] tracking-[-.035em]">
              {stage === 1
                ? '설명에 필요한 키워드를\n모두 골라 주세요'
                : stage === 2
                  ? '이야기의 흐름대로\n순서를 연결해요'
                  : stage === 3
                    ? '머릿속에 흐름을\n그려 볼까요?'
                    : '이제 내 문장으로\n설명해 주세요'}
            </h1>
            <p className="essay-prompt">{essay.prompt}</p>
          </>
        )}
        {stage === 1 && (
          <>
            <p className="mt-5 text-[13px] text-muted">
              관련 키워드 {essay.keywords.length}개와 관계없는 키워드가 섞여 있어요.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {keywords.map((word) => (
                <button
                  key={word}
                  aria-pressed={selected.includes(word)}
                  onClick={() => {
                    setChecked(false);
                    setSelected((current) =>
                      current.includes(word)
                        ? current.filter((k) => k !== word)
                        : [...current, word],
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
                    ? '설명과 관계없는 키워드가 있어요. 각 단어가 질문과 어떻게 연결되는지 생각해 보세요.'
                    : `필요한 키워드가 더 있어요. ${essay.keywords.length}개를 모두 골라 주세요.`}
                </p>
              )}
              <p className="flex items-center justify-center gap-1.5 text-[12px] text-muted">
                <LockKeyhole size={14} />
                키워드를 모두 맞히면 다음 단계가 열려요
              </p>
              <Button
                className="w-full"
                disabled={!selected.length}
                onClick={() => {
                  setChecked(true);
                  if (allKeywords) {
                    setStage(2);
                    window.scrollTo({ top: 0 });
                  }
                }}
              >
                키워드 확인하기
              </Button>
            </div>
          </>
        )}
        {stage === 2 && (
          <>
            <p className="my-5 text-[13px] leading-relaxed text-muted">
              위아래 화살표나 드래그로 옮겨 주세요.
              <br />
              흐름이 맞는 위치는 진하게 표시돼요.
            </p>
            <div className="space-y-2">
              {order.map((word, i) => (
                <div
                  key={word}
                  draggable
                  onDragStart={() => setDragged(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragged !== null) move(dragged, i);
                    setDragged(null);
                  }}
                  className={`flex min-h-16 items-center gap-3 rounded-2xl px-3 py-2 ${word === essay.keywords[i] ? 'bg-ink text-white' : 'bg-surface'}`}
                >
                  <GripVertical size={18} className="shrink-0 opacity-50" />
                  <span className="text-[13px] font-bold opacity-60">{i + 1}</span>
                  <span className="min-w-0 flex-1 text-[15px] font-semibold">{word}</span>
                  <div className="flex">
                    <IconButton
                      label={`${word} 위로`}
                      disabled={i === 0}
                      onClick={() => move(i, i - 1)}
                    >
                      <ArrowUp size={17} />
                    </IconButton>
                    <IconButton
                      label={`${word} 아래로`}
                      disabled={i === order.length - 1}
                      onClick={() => move(i, i + 1)}
                    >
                      <ArrowDown size={17} />
                    </IconButton>
                  </div>
                </div>
              ))}
            </div>
            <p className="my-5 text-center text-sm text-muted">
              {ordered
                ? '흐름이 자연스럽게 연결되었어요'
                : '원인에서 결과로, 순서를 한 번 더 생각해 봐요'}
            </p>
            <Button
              className="w-full"
              disabled={!ordered}
              onClick={() => {
                setStage(3);
                window.scrollTo({ top: 0 });
              }}
            >
              이 흐름으로 이어가기
            </Button>
          </>
        )}
        {stage === 3 && (
          <>
            <div className="mt-6 rounded-[24px] bg-surface p-5">
              {hint ? (
                <div className="space-y-1" aria-label="개념의 인과 순서">
                  {essay.keywords.map((word, i) => (
                    <div key={word}>
                      <div className="flex min-h-14 items-center justify-center rounded-2xl bg-white px-4 text-center text-[16px] font-bold">
                        {word}
                      </div>
                      {i < essay.keywords.length - 1 && (
                        <div className="flex h-8 items-center justify-center">
                          <ArrowDown size={22} className="text-muted" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex min-h-44 flex-col items-center justify-center gap-4">
                  <Eye size={30} />
                  <p className="text-center text-sm leading-relaxed text-muted">
                    연결한 키워드를 도식으로 볼 수 있어요.
                    <br />
                    힌트를 봐도 점수는 줄어들지 않아요.
                  </p>
                  <Button variant="secondary" onClick={() => setHint(true)}>
                    도식 힌트 보기
                  </Button>
                </div>
              )}
            </div>
            <Button
              className="mt-6 w-full"
              onClick={() => {
                setStage(4);
                window.scrollTo({ top: 0 });
              }}
            >
              {hint ? '이제 직접 서술하기' : '힌트 없이 서술하기'}
            </Button>
          </>
        )}
        {stage === 4 && !feedback && (
          <>
            <div className="mt-5 flex flex-wrap gap-2">
              {essay.keywords.map((k) => (
                <span
                  key={k}
                  className="rounded-lg bg-surface px-2.5 py-1.5 text-xs font-semibold text-muted"
                >
                  {k}
                </span>
              ))}
            </div>
            <label className="mt-5 block">
              <span className="sr-only">서술형 답안</span>
              <textarea
                autoFocus
                className="field min-h-60 resize-y !bg-canvas text-[16px] leading-[1.8]"
                maxLength={5000}
                value={answer}
                disabled={action.busy || task?.status === 'RUNNING' || task?.status === 'READY'}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="키워드를 연결해 원인부터 결과까지 설명해 주세요."
              />
            </label>
            <p className="mt-2 text-right text-xs text-muted">{answer.length} / 5,000자</p>
            <div className="mt-5 space-y-3">
              {!props.data.aiAvailable && (
                <p className="rounded-2xl bg-surface p-4 text-sm leading-relaxed text-secondary">
                  키워드·순서·분량 기준으로 연습 채점해요. AI 의미 평가는 연결 준비가 끝나면 이용할
                  수 있어요.
                </p>
              )}
              {task && (task.status === 'RUNNING' || task.status === 'READY') && !action.busy && (
                <p className="rounded-2xl bg-surface p-4 text-sm leading-relaxed">
                  이전 답안과 채점 요청을 보관하고 있어요. 같은 요청 번호로 이어서 확인해 중복
                  채점을 막아요.
                </p>
              )}
              {task && (task.status === 'FAILED' || task.status === 'INTERRUPTED') && (
                <p className="rounded-2xl bg-surface p-4 text-sm leading-relaxed">
                  {task.error || '이전 채점을 마치지 못했어요.'} 새로 채점 요청하기를 누르면 다시
                  시작해요.
                </p>
              )}
              <ErrorNote error={action.error} />
              <Button
                className="w-full"
                disabled={answer.trim().length < 10 || action.busy}
                onClick={() =>
                  action.run(async () => {
                    const lookup = {
                      userId: props.data.profile.id,
                      endpoint: '/essay/submit' as const,
                      payload: { essayId: essay.id, answer: answer.trim() },
                    };
                    try {
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
                  '새로 채점 요청하기'
                ) : props.data.aiAvailable ? (
                  '답안 제출하고 코칭 받기'
                ) : (
                  '연습 채점 받기'
                )}
              </Button>
              <Button className="w-full" variant="ghost" onClick={() => setStage(3)}>
                도식 힌트 다시 보기
              </Button>
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
                  ? '완벽하게 설명했어요. 서술형 오답노트에서도 빠졌어요.'
                  : '조금만 보완하면 더 명확한 설명이 돼요. 답안은 오답노트에 저장했어요.'}
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
              onOpen={() => setViewer(material || null)}
            />
            <ErrorNote error={action.error} />
            {feedback.score < 100 && (
              <Button
                className="w-full"
                onClick={() => {
                  setFeedback(null);
                  action.setError('');
                }}
              >
                한 문장 더 쓰기
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
      </div>
      <MaterialViewer material={viewer} onClose={() => setViewer(null)} />
    </>
  );
}
