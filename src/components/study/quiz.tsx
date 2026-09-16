'use client';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, ChevronRight, ChevronDown } from '@/components/icons';
import type { Material, Question, ScreenProps } from '@/lib/contracts';
import { useJourneyLayer, useJourneyState } from '../journey';
import { Button, EmptyState, ScreenHeader, SectionTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { remainingMaterialQuestions } from '@/lib/home';
import { latestAttempts, wrongEssays, wrongQuestions } from './logic';
import {
  BusyText,
  Chip,
  ErrorNote,
  GenerationSheet,
  MaterialViewer,
  params,
  Progress,
  SubjectSelect,
  useAction,
} from './shared';
import layout from './study-layout.module.css';
import { Checkbox } from '@/components/ui-choice';

import { QuizFeedback, QuestionExplanation, type AnswerResult } from './quiz-feedback';
import { CommunityAsk } from '../social/community-ask';
import { readExplanationDepth } from '@/lib/learning-preferences';
import {
  recordQuizAnswer,
  recordQuizCheck,
  quizSummary,
  type QuizAnswer,
} from '@/lib/quiz-learning';
export function Quiz(props: ScreenProps) {
  const query = params(props.path);
  const [subject, setSubject] = useJourneyState('quiz.subject', query.get('subject') || '');
  const [priority, setPriority] = useJourneyState('quiz.priority', 'new');
  const [limit, setLimit] = useJourneyState('quiz.limit', 10);
  const [generate, setGenerate] = useState(false);
  const [sessionIds, setSessionIds] = useJourneyState<string[] | null>('quiz.session', () =>
    query.get('question')
      ? props.data.questions.filter((q) => q.id === query.get('question')).map((q) => q.id)
      : query.get('resume') === '1' && query.get('material')
        ? remainingMaterialQuestions(props.data, query.get('material')!).map((q) => q.id)
        : null,
  );
  useEffect(() => {
    // Freeze a direct/resumed question list before answers change the remaining-question query.
    if (sessionIds) setSessionIds(sessionIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const session = useMemo(
    () =>
      sessionIds?.flatMap((id) => {
        const question = props.data.questions.find((q) => q.id === id);
        return question ? [question] : [];
      }) ?? null,
    [sessionIds, props.data.questions],
  );
  const setSession = (questions: Question[] | null) =>
    setSessionIds(questions?.map((q) => q.id) ?? null);
  const [index, setIndex] = useJourneyState('quiz.index', 0);
  const [selection, setSelection] = useJourneyState<number | null>('quiz.selection', null);
  const [result, setResult] = useJourneyState<AnswerResult | null>('quiz.result', null);
  const [answered, setAnswered] = useJourneyState<QuizAnswer[]>('quiz.answered', []);
  const [viewer, setViewer] = useState<{ material: Material; citation?: string } | null>(null);
  const [finished, setFinished] = useJourneyState('quiz.finished', false);
  const action = useAction();
  const [pending, setPending] = useJourneyState<{
    requestId: string;
    questionId: string;
    answer: number;
  } | null>('quiz.pending', null);
  const [startedAt, setStartedAt] = useJourneyState('quiz.startedAt', () => Date.now());
  const direct = !!query.get('question') || query.get('resume') === '1';
  const resetSession = () => {
    setSession(null);
    setIndex(0);
    setSelection(null);
    setResult(null);
    setAnswered([]);
    setFinished(false);
    setPending(null);
    setStartedAt(Date.now());
  };
  const closeSession = useJourneyLayer(!!session && !direct, resetSession);
  const latest = latestAttempts(props.data.attempts, 'questionId');
  const pool = props.data.questions
    .filter(
      (q) =>
        (!subject || q.subjectId === subject) &&
        (!query.get('material') || q.materialId === query.get('material')),
    )
    .filter((q) => (priority === 'wrong' ? latest.has(q.id) && !latest.get(q.id)!.correct : true))
    .sort((a, b) => (priority === 'new' ? Number(latest.has(a.id)) - Number(latest.has(b.id)) : 0));
  const question = session?.[index];
  async function answer(value: number) {
    if (!question || result) return;
    const request =
      pending?.questionId === question.id
        ? pending
        : { requestId: crypto.randomUUID(), questionId: question.id, answer: value };
    setPending(request);
    setSelection(request.answer);
    const response = await api<AnswerResult>('/quiz/answer', {
      ...request,
      responseMs: Math.min(86400000, Math.max(0, Date.now() - startedAt)),
    });
    setPending(null);
    setResult(response);
    setAnswered((current) =>
      recordQuizAnswer(current, { id: question.id, correct: response.correct }),
    );
    await props.refresh();
  }
  if (finished && session)
    return (
      <QuizResult
        props={{ ...props, back: direct ? props.back : closeSession }}
        questions={session}
        answers={answered}
        onRetryWrong={() => {
          const wrongIds = new Set(answered.filter((a) => !a.correct).map((a) => a.id));
          setSession(session.filter((q) => wrongIds.has(q.id)));
          setIndex(0);
          setSelection(null);
          setResult(null);
          setAnswered([]);
          setFinished(false);
          setPending(null);
          setStartedAt(Date.now());
        }}
        onAgain={() => {
          setSession(null);
          setIndex(0);
          setSelection(null);
          setResult(null);
          setAnswered([]);
          setFinished(false);
          setPending(null);
          setStartedAt(Date.now());
        }}
      />
    );
  if (!session || !question)
    return (
      <>
        <ScreenHeader title="문제 풀기" back={() => props.back('/study')} />
        <div className="page-inset pb-8">
          <h2 className="mt-3 text-[26px] font-extrabold leading-[1.3] tracking-[-.035em]">
            오늘은 어떤 문제를
            <br />
            풀어 볼까요?
          </h2>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            내 자료에서 출제한 문제로
            <br />
            배운 개념을 차근차근 확인해요.
          </p>
          <div className="mt-7 space-y-6">
            <label className="block text-sm font-semibold">
              학습 범위
              <div className="mt-2">
                <SubjectSelect data={props.data} value={subject} onChange={setSubject} />
              </div>
            </label>
            <div>
              <h3 className="mb-2 text-sm font-semibold">어떤 문제부터</h3>
              <div className="space-y-2">
                {[
                  ['new', '안 푼 것부터', '새로운 개념을 먼저 확인해요'],
                  ['wrong', '틀린 것만', '다시 생각하면 오래 남아요'],
                  ['all', '전체 문제', '차근차근 모두 점검해요'],
                ].map(([id, label, desc]) => (
                  <button
                    key={id}
                    onClick={() => setPriority(id)}
                    aria-pressed={priority === id}
                    className="choice-row"
                  >
                    <span className="flex-1">
                      <span className="block text-[15px] font-bold">{label}</span>
                      <span className="mt-1 block text-[13px] text-muted">{desc}</span>
                    </span>
                    <span className="choice-indicator">
                      {priority === id && <Check size={14} />}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">문제 수</h3>
                <span className="text-xs text-muted">풀 수 있는 문제 {pool.length}개</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[5, 10, 20, 30].map((n) => (
                  <Chip key={n} active={limit === n} onClick={() => setLimit(n)}>
                    {n}
                  </Chip>
                ))}
              </div>
            </div>
            {!pool.length && (
              <div className="rounded-2xl bg-surface p-4 text-sm leading-relaxed">
                {priority === 'wrong'
                  ? '다시 풀 오답이 없어요. 새로운 문제에 도전해 볼까요?'
                  : '아직 만든 문제가 없어요. 학습 자료를 올려 문제를 만들어 주세요.'}
              </div>
            )}
            <Button
              className="w-full"
              disabled={!pool.length}
              onClick={() => {
                setSession(pool.slice(0, limit));
                setStartedAt(Date.now());
              }}
            >
              {Math.min(pool.length, limit)}문제 풀기
              <ArrowRight size={18} />
            </Button>
            <Button className="w-full" variant="secondary" onClick={() => setGenerate(true)}>
              자료로 새 문제 만들기
            </Button>
          </div>
        </div>
        <GenerationSheet open={generate} onClose={() => setGenerate(false)} props={props} />
      </>
    );
  const material = props.data.materials.find((m) => m.id === question.materialId);
  const subjectName = props.data.subjects.find((s) => s.id === question.subjectId)?.name;
  return (
    <>
      <ScreenHeader
        title={`${index + 1} / ${session.length}`}
        back={direct ? () => props.back('/quiz') : closeSession}
      />
      <div className="page-inset pb-8">
        <Progress value={index + (result ? 1 : 0)} total={session.length} />
        {!result ? (
          <>
            <div className="mt-7">
              <span className="inline-flex rounded-full bg-surface px-3 py-1.5 text-[12px] font-semibold">
                {subjectName || '개념 확인'}
              </span>
              <h2 className="mt-4 text-[22px] font-bold leading-[1.5] tracking-[-.025em]">
                {question.prompt}
              </h2>
            </div>
            <div className="mt-6 space-y-3" role="radiogroup" aria-label="답안 선택">
              {question.options.map((option, i) => (
                <button
                  key={i}
                  role="radio"
                  aria-checked={selection === i}
                  className="answer-option"
                  disabled={action.busy || !!pending}
                  onClick={() => setSelection(i)}
                >
                  <span className="answer-number">{i + 1}</span>
                  <span>{option}</span>
                </button>
              ))}
            </div>
            <div className="exercise-actions mt-6 space-y-2">
              <ErrorNote error={action.error} />
              {pending && !action.busy && (
                <p className="text-sm leading-relaxed text-muted">
                  선택한 답안을 보관했어요. 같은 답안으로 다시 확인하면 기록이 중복되지 않아요.
                </p>
              )}
              <Button
                className="w-full"
                variant="ghost"
                disabled={action.busy || !!pending}
                onClick={() => action.run(() => answer(-1))}
              >
                잘 모르겠어요
              </Button>
              <Button
                className="w-full"
                disabled={selection === null || action.busy}
                onClick={() => action.run(() => answer(selection!))}
              >
                {action.busy ? (
                  <BusyText>확인하고 있어요</BusyText>
                ) : pending ? (
                  '같은 답안으로 다시 확인'
                ) : (
                  '정답 확인'
                )}
              </Button>
            </div>
          </>
        ) : (
          <>
            <QuizFeedback
              key={`${question.id}:${result.attemptId ?? index}`}
              question={question}
              existingCard={props.data.cards.find(
                (card) => !card.deleted && card.diagram && card.sourceQuestionId === question.id,
              )}
              result={result}
              afterExplanation={<CommunityAsk {...props} question={question} kind="EXPLAIN" />}
              selected={selection}
              material={material}
              defaultDepth={readExplanationDepth(props.data.profile.id)}
              toast={props.toast}
              refresh={props.refresh}
              onOpenSource={(citation) => setViewer(material ? { material, citation } : null)}
              onCheck={(microResult) =>
                setAnswered((items) => recordQuizCheck(items, question.id, microResult))
              }
              nextLabel={index + 1 === session.length ? '학습 결과 보기' : '다음 문제'}
              onNext={() => {
                if (index + 1 === session.length) setFinished(true);
                else {
                  setIndex(index + 1);
                  setSelection(null);
                  setResult(null);
                  setPending(null);
                  setStartedAt(Date.now());
                  action.setError('');
                  window.scrollTo({ top: 0 });
                }
              }}
            />
          </>
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
function QuizResult({
  props,
  questions,
  answers,
  onAgain,
  onRetryWrong,
}: {
  props: ScreenProps;
  questions: Question[];
  answers: QuizAnswer[];
  onAgain: () => void;
  onRetryWrong: () => void;
}) {
  const wrong = questions.filter((q) => answers.some((a) => a.id === q.id && !a.correct));
  const [selected, setSelected] = useState<string[]>([]);
  const action = useAction();
  const summary = quizSummary(answers);
  const correct = summary.correct;
  return (
    <>
      <ScreenHeader title="학습 결과" back={() => props.back('/study')} />
      <div className="page-inset pb-8">
        <div className="py-5">
          <span className="eyebrow">오늘도 한 걸음 쌓았어요</span>
          <h1 className="mt-3 text-[48px] font-extrabold tracking-[-.045em]">
            {correct}
            <span className="ml-2 text-[25px] text-disabled">/ {questions.length}</span>
          </h1>
          <p className="mt-2 text-[15px] text-muted">
            {wrong.length
              ? '틀린 문제를 다시 풀거나 복습 카드로 남길 수 있어요.'
              : '이번 문제를 모두 맞혔어요. 필요하면 다른 문제로 더 연습해 보세요.'}
          </p>
        </div>
        {(summary.checked > 0 || summary.revisit > 0) && (
          <p className="mb-5 rounded-2xl bg-surface p-4 text-sm leading-relaxed">
            해설 뒤 확인 · {summary.checked}개 맞힘
            {summary.revisit > 0 ? ` · ${summary.revisit}개 더 살펴보기` : ''}
            <span className="mt-1 block text-xs text-muted">
              확인 결과는 위의 처음 풀이 점수에 포함하지 않아요.
            </span>
          </p>
        )}
        {wrong.length > 0 && (
          <Button className="mb-5 w-full" onClick={onRetryWrong}>
            틀린 {wrong.length}문제 다시 풀기
          </Button>
        )}
        {wrong.length > 0 && (
          <>
            <SectionTitle
              title={`틀린 개념 ${wrong.length}개`}
              action={<span className="text-xs text-muted">오답노트에 저장됨</span>}
            />
            <p className="mb-3 text-[13px] text-muted">
              카드로 남기고 싶은 문제만 선택해 주세요. 선택하지 않아도 다시 풀 수 있어요.
            </p>
            <div className="space-y-2">
              {wrong.map((q) => (
                <button
                  key={q.id}
                  aria-pressed={selected.includes(q.id)}
                  onClick={() =>
                    setSelected((ids) =>
                      ids.includes(q.id) ? ids.filter((id) => id !== q.id) : [...ids, q.id],
                    )
                  }
                  className="flex min-h-[72px] w-full items-center gap-3 rounded-2xl bg-surface p-4 text-left"
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${selected.includes(q.id) ? 'bg-ink text-white' : 'bg-white'}`}
                  >
                    {selected.includes(q.id) && <Check size={16} />}
                  </span>
                  <span className="text-[14px] font-semibold leading-relaxed">{q.prompt}</span>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="mt-7 space-y-3">
          <ErrorNote error={action.error} />
          {wrong.length > 0 && (
            <Button
              className="w-full"
              variant="secondary"
              disabled={!selected.length || action.busy}
              onClick={() =>
                action.run(async () => {
                  await api('/wrong-notes/cards', { questionIds: selected });
                  await props.refresh();
                  props.toast(`${selected.length}개 개념을 카드로 만들었어요`);
                  props.navigate('/flashcards');
                })
              }
            >
              {action.busy ? (
                <BusyText>카드로 옮기는 중</BusyText>
              ) : (
                `${selected.length}개 복습 카드로 만들기`
              )}
            </Button>
          )}
          <Button
            className="w-full"
            variant={wrong.length ? 'secondary' : 'primary'}
            onClick={onAgain}
          >
            다른 문제 풀기
          </Button>
          <Button
            className="w-full"
            variant="ghost"
            onClick={() => props.navigate('/study', { replace: true })}
          >
            학습으로 돌아가기
          </Button>
        </div>
      </div>
    </>
  );
}
export function WrongNotes(props: ScreenProps) {
  const [tab, setTab] = useJourneyState('wrongNotes.tab', '객관식');
  const [subject, setSubject] = useJourneyState('wrongNotes.subject', '');
  const [selected, setSelected] = useJourneyState<string[]>('wrongNotes.selected', []);
  const [bulk, setBulk] = useJourneyState('wrongNotes.bulk', false);
  const [opened, setOpened] = useJourneyState<string | null>('wrongNotes.opened', null);
  const [viewer, setViewer] = useState<{ material: Material; citation?: string } | null>(null);
  const action = useAction();
  const questions = wrongQuestions(props.data).filter((q) => !subject || q.subjectId === subject);
  const essays = wrongEssays(props.data).filter((e) => !subject || e.subjectId === subject);
  const recent = latestAttempts(props.data.attempts, 'questionId');
  const wrongCounts = new Map<string, number>();
  props.data.attempts.forEach((attempt) => {
    if (attempt.questionId && !attempt.correct)
      wrongCounts.set(attempt.questionId, (wrongCounts.get(attempt.questionId) ?? 0) + 1);
  });
  const selectedVisible = selected.filter((id) => questions.some((q) => q.id === id));
  return (
    <>
      <ScreenHeader title="오답노트" back={() => props.back('/study')} />
      <div className="page-inset pb-8">
        <p className="mt-1 text-[14px] text-muted">
          {tab === '객관식'
            ? '정답을 보지 않고 다시 풀어 보세요. 필요하면 해설을 펼쳐 볼 수 있어요.'
            : '이전에 쓴 답안을 가져와 빠진 내용과 설명을 보완해 보세요.'}
        </p>
        <div className="my-5 flex gap-2">
          <Chip active={tab === '객관식'} onClick={() => setTab('객관식')}>
            객관식 {questions.length}
          </Chip>
          <Chip active={tab === '서술형'} onClick={() => setTab('서술형')}>
            서술형 {essays.length}
          </Chip>
        </div>
        <SubjectSelect data={props.data} value={subject} onChange={setSubject} />
        {tab === '객관식' ? (
          questions.length ? (
            <>
              <div className={layout.noteToolbar}>
                <button
                  className={layout.action}
                  aria-pressed={bulk}
                  onClick={() => setBulk(!bulk)}
                >
                  {bulk ? '선택 마치기' : '카드로 모으기'}
                </button>
                <span className="text-xs text-muted">
                  {bulk ? '카드로 남길 문제 선택' : `${questions.length}문제 다시 살펴보기`}
                </span>
                {bulk && (
                  <button
                    className={layout.action}
                    onClick={() =>
                      setSelected(
                        selectedVisible.length === questions.length
                          ? []
                          : questions.map((q) => q.id),
                      )
                    }
                  >
                    {selectedVisible.length === questions.length ? '선택 해제' : '전체 선택'}
                  </button>
                )}
              </div>
              <div className={layout.noteList}>
                {questions.map((q) => {
                  const expanded = opened === q.id;
                  const attempt = recent.get(q.id);
                  const answer = Number(attempt?.answer ?? -1);
                  const titleId = `wrong-title-${q.id}`;
                  const panelId = `wrong-explanation-${q.id}`;
                  return (
                    <article key={q.id} className={layout.note}>
                      <header className={layout.noteHeader}>
                        {bulk && (
                          <Checkbox
                            name="wrong-note"
                            checked={selected.includes(q.id)}
                            onChange={(checked) =>
                              setSelected((ids) =>
                                checked ? [...ids, q.id] : ids.filter((id) => id !== q.id),
                              )
                            }
                            className="shrink-0"
                          >
                            <span className="sr-only">{q.prompt} 선택</span>
                          </Checkbox>
                        )}
                        <div className={layout.noteTitle}>
                          <p>{props.data.subjects.find((s) => s.id === q.subjectId)?.name}</p>
                          <h3 id={titleId}>{q.prompt}</h3>
                        </div>
                      </header>
                      <p className={layout.noteMeta}>
                        {q.savedToNotes && !wrongCounts.get(q.id)
                          ? '커뮤니티에서 담은 문제'
                          : `틀린 기록 ${wrongCounts.get(q.id) ?? 0}회`}
                        {attempt?.microResult === 'PASS'
                          ? ' · 해설 뒤 확인 완료'
                          : attempt?.microResult === 'FAIL'
                            ? ' · 확인 문제도 다시 살펴봐요'
                            : ''}
                      </p>
                      <div className={layout.noteActions}>
                        <button
                          type="button"
                          className={layout.disclosure}
                          aria-expanded={expanded}
                          aria-controls={panelId}
                          onClick={() => setOpened(expanded ? null : q.id)}
                        >
                          {expanded ? '해설 접기' : '해설 보기'}
                          <ChevronDown size={16} />
                        </button>
                        <button
                          type="button"
                          className={layout.retry}
                          onClick={() => props.navigate(`/quiz?question=${q.id}`)}
                        >
                          다시 풀기
                          <ArrowRight size={16} />
                        </button>
                      </div>
                      <div
                        id={panelId}
                        role="region"
                        aria-labelledby={titleId}
                        hidden={!expanded}
                        className={layout.notePanel}
                      >
                        {expanded && (
                          <>
                            <dl className={layout.answerRows}>
                              <div>
                                <dt>정답</dt>
                                <dd>{q.options[q.answer]}</dd>
                              </div>
                              <div>
                                <dt>내 선택</dt>
                                <dd>{answer >= 0 ? q.options[answer] : '잘 모르겠어요'}</dd>
                              </div>
                            </dl>
                            <QuestionExplanation
                              key={q.id}
                              question={q}
                              existingCard={props.data.cards.find(
                                (card) =>
                                  !card.deleted && card.diagram && card.sourceQuestionId === q.id,
                              )}
                              material={props.data.materials.find((m) => m.id === q.materialId)}
                              selectedAnswer={answer}
                              defaultDepth={readExplanationDepth(props.data.profile.id)}
                              toast={props.toast}
                              refresh={props.refresh}
                              onOpenSource={(citation) => {
                                const material = props.data.materials.find(
                                  (m) => m.id === q.materialId,
                                );
                                setViewer(material ? { material, citation } : null);
                              }}
                            />
                            <CommunityAsk {...props} question={q} kind="WRONGNOTE" />
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              <ErrorNote error={action.error} />
              {bulk && (
                <Button
                  className="mt-6 w-full"
                  disabled={!selectedVisible.length || action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await api('/wrong-notes/cards', { questionIds: selectedVisible });
                      await props.refresh();
                      props.toast('복습 카드에 담았어요');
                      props.navigate('/flashcards');
                    })
                  }
                >
                  {action.busy ? (
                    <BusyText>카드로 옮기는 중</BusyText>
                  ) : (
                    `${selectedVisible.length}개 복습 카드로 만들기`
                  )}
                </Button>
              )}
            </>
          ) : (
            <EmptyState
              title="다시 풀 오답이 없어요"
              description="문제를 풀고 틀린 개념이 생기면 여기에 모아 드릴게요."
              action={<Button onClick={() => props.navigate('/quiz')}>새 문제 풀기</Button>}
            />
          )
        ) : essays.length ? (
          <div className="mt-5 space-y-3">
            {essays.map((e) => {
              const attempt = latestAttempts(props.data.attempts, 'essayId').get(e.id);
              return (
                <button
                  key={e.id}
                  onClick={() => props.navigate(`/essay?essay=${e.id}&revise=1`)}
                  className="w-full rounded-[20px] bg-surface p-4 text-left"
                >
                  <div className="mb-2 flex items-center justify-between text-xs text-muted">
                    <span>{props.data.subjects.find((s) => s.id === e.subjectId)?.name}</span>
                    <strong>{attempt?.score}점</strong>
                  </div>
                  <p className="text-[15px] font-bold leading-relaxed">{e.prompt}</p>
                  <p className="mt-3 flex items-center gap-1 text-xs font-semibold">
                    답안 보완하기
                    <ChevronRight size={15} />
                  </p>
                </button>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="보완할 답안이 없어요"
            description="100점 미만의 서술형 답안을 모아 두고, 보완하면 다시 평가받을 수 있어요."
            action={<Button onClick={() => props.navigate('/essay')}>서술형 코칭 시작</Button>}
          />
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
