'use client';
import { StudyLibraryAction } from './subjects';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Plus, Check, ChevronRight, ChevronDown } from '@/components/icons';
import type { Material, Question, ScreenProps } from '@/lib/contracts';
import { useJourneyLayer, useJourneyState } from '../journey';
import { Button, EmptyState, ScreenHeader, SectionTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { remainingMaterialQuestions } from '@/lib/home';
import { latestAttempts, wrongEssays, wrongQuestions } from './logic';
import {
  BusyText,
  Chip,
  CommunityAnswersRow,
  ErrorNote,
  GenerationSheet,
  MaterialViewer,
  params,
  Progress,
  SubjectSelect,
  useAction,
} from './shared';
import layout from './study-layout.module.css';
import setup from './quiz-setup.module.css';
import { quizScope, quizPool, quizQuantity } from '@/lib/quiz-setup';
import {
  readStudySessions,
  resumableStudySessions,
  saveStudySession,
  removeStudySession,
  studySessionRevision,
} from '@/lib/study-sessions';
import { Checkbox, OptionField } from '@/components/ui-choice';

import { QuizFeedback, QuestionExplanation, type AnswerResult } from './quiz-feedback';
import { CommunityAsk } from '../social/community-ask';
import { readExplanationDepth } from '@/lib/learning-preferences';
import { LearningFolders } from './learning-folders';
import { ConceptConnections } from './concept-connections';
import {
  folderUploadPath,
  newQuizSession,
  quizSessionRevisions,
  resolveQuizSession,
} from '@/lib/quiz-session';
import { inLearningFolder } from '@/lib/learning-folders';
import {
  recordQuizAnswer,
  recordQuizCheck,
  quizSummary,
  type QuizAnswer,
} from '@/lib/quiz-learning';
export function Quiz(props: ScreenProps) {
  const query = params(props.path);
  const [savedSession] = useState(() =>
    resumableStudySessions(props.data, readStudySessions(props.data.profile.id)).find(
      (s) => s.kind === 'quiz' && s.id === query.get('checkpoint'),
    ),
  );
  const resumed = savedSession?.kind === 'quiz' ? savedSession : undefined;
  const [checkpointId, setCheckpointId] = useJourneyState(
    'quiz.checkpointId',
    () => resumed?.id || crypto.randomUUID(),
  );
  const [subject, setSubject] = useJourneyState('quiz.subject', query.get('subject') || '');
  const [priority, setPriority] = useJourneyState('quiz.priority', 'new');
  const [limit, setLimit] = useJourneyState('quiz.limit', 10);
  const [generate, setGenerate] = useState(false);
  const [sessionIds, setSessionIds] = useJourneyState<string[] | null>('quiz.session', () =>
    resumed
      ? resumed.ids
      : query.get('question')
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
  const [sessionRevisions, setSessionRevisions] = useJourneyState<Record<string, string>>(
    'quiz.revisions',
    () =>
      resumed?.revisions ??
      quizSessionRevisions(props.data.questions.filter((q) => sessionIds?.includes(q.id))),
  );
  const resolved = useMemo(
    () => resolveQuizSession(sessionIds, sessionRevisions, props.data.questions),
    [sessionIds, sessionRevisions, props.data.questions],
  );
  const session = resolved.questions;
  const setSession = (questions: Question[] | null) => {
    setSessionRevisions(questions ? quizSessionRevisions(questions) : {});
    setSessionIds(questions?.map((q) => q.id) ?? null);
  };
  const [index, setIndex] = useJourneyState('quiz.index', resumed?.index ?? 0);
  const [selection, setSelection] = useJourneyState<number | null>(
    'quiz.selection',
    resumed?.selection ?? null,
  );
  const [result, setResult] = useJourneyState<AnswerResult | null>(
    'quiz.result',
    resumed?.result ?? null,
  );
  const [answered, setAnswered] = useJourneyState<QuizAnswer[]>(
    'quiz.answered',
    resumed?.answers ?? [],
  );
  const [viewer, setViewer] = useState<{ material: Material; citation?: string } | null>(null);
  const [finished, setFinished] = useJourneyState('quiz.finished', false);
  const action = useAction();
  const [pending, setPending] = useJourneyState<{
    requestId: string;
    questionId: string;
    answer: number;
  } | null>('quiz.pending', resumed?.pending ?? null);
  const [startedAt, setStartedAt] = useJourneyState(
    'quiz.startedAt',
    () => resumed?.startedAt ?? Date.now(),
  );
  const [direct, setDirect] = useJourneyState(
    'quiz.direct',
    !!query.get('checkpoint') || !!query.get('question') || query.get('resume') === '1',
  );
  const liveIdentity = useRef('');
  liveIdentity.current = session?.[index]
    ? `${checkpointId}:${session[index].id}:${sessionRevisions[session[index].id]}`
    : '';
  useEffect(() => {
    if (!sessionIds?.length || resolved.invalid) return;
    setCheckpointId(checkpointId);
    if (finished) {
      removeStudySession(props.data.profile.id, checkpointId);
      return;
    }
    saveStudySession(props.data.profile.id, {
      kind: 'quiz',
      id: checkpointId,
      ids: sessionIds,
      index,
      selection,
      result,
      answers: answered,
      pending,
      startedAt,
      updatedAt: new Date().toISOString(),
      revisions: sessionRevisions,
    });
    // Only learner progress changes recency; bootstrap polling must not reorder the resume list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionIds,
    index,
    selection,
    result,
    answered,
    pending,
    finished,
    startedAt,
    checkpointId,
    sessionRevisions,
    resolved.invalid,
  ]);
  useEffect(() => {
    if (query.get('checkpoint') && !resumed)
      props.toast('학습 내용이 바뀌었거나 완료됐어요. 문제를 다시 골라 주세요.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const resetSession = () => {
    setSession(null);
    setIndex(0);
    setSelection(null);
    setResult(null);
    setAnswered([]);
    setFinished(false);
    setPending(null);
    setStartedAt(Date.now());
    setDirect(false);
  };
  const startSession = (questions: Question[]) => {
    const next = newQuizSession(questions);
    setCheckpointId(next.id);
    setSessionRevisions(next.revisions);
    setSessionIds(next.ids);
    setIndex(0);
    setSelection(null);
    setResult(null);
    setAnswered([]);
    setFinished(false);
    setPending(null);
    setStartedAt(Date.now());
    setDirect(false);
    action.setError('');
  };
  useEffect(() => {
    if (!resolved.invalid) return;
    liveIdentity.current = '';
    removeStudySession(props.data.profile.id, checkpointId);
    resetSession();
    props.toast('문제가 바뀌었거나 삭제됐어요. 학습 범위를 다시 골라 주세요.');
    // The boolean changes only when a session becomes invalid; never replace its question by position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved.invalid, checkpointId]);
  const materialId = query.get('material') || '';
  // Parent folder layer is registered before its exercise layer.
  const closeFolder = useJourneyLayer(!!subject && !materialId && !direct, () => setSubject(''));
  const closeSession = useJourneyLayer(!!session && !direct, resetSession);
  const latest = latestAttempts(props.data.attempts, 'questionId');
  const scopedMaterial = props.data.materials.find((m) => m.id === materialId);
  const hasGenerationSources = props.data.materials.some(
    (m) =>
      m.contentLength >= 20 &&
      (materialId
        ? m.id === materialId
        : !subject || inLearningFolder(m.subjectId, subject, props.data.subjects)),
  );
  const openGeneration = () => {
    if (!hasGenerationSources) {
      props.navigate(folderUploadPath(scopedMaterial?.subjectId || subject, props.data.subjects));
      return;
    }
    setGenerate(true);
  };
  const scopedQuestions = materialId
    ? quizScope(props.data.questions, '', materialId)
    : props.data.questions.filter(
        (q) => !subject || inLearningFolder(q.subjectId, subject, props.data.subjects),
      );
  const pool = quizPool(scopedQuestions, latest, priority);
  const unanswered = scopedQuestions.filter((q) => !latest.has(q.id)).length;
  const { count, options: quantities } = quizQuantity(pool.length, limit);
  const modeDescription =
    priority === 'wrong'
      ? '마지막 풀이에서 틀린 문제만 다시 풀어요.'
      : priority === 'all'
        ? '푼 문제와 아직 안 푼 문제를 함께 풀어요.'
        : unanswered
          ? count > unanswered
            ? `안 푼 ${unanswered}개부터 시작해, 풀었던 ${count - unanswered}개도 복습해요.`
            : `아직 안 푼 문제 ${unanswered}개 중에서 먼저 풀어요.`
          : '안 푼 문제를 모두 풀었어요. 풀었던 문제로 복습해요.';
  const question = session?.[index];
  async function answer(value: number) {
    if (!question || result) return;
    const request =
      pending?.questionId === question.id
        ? pending
        : { requestId: crypto.randomUUID(), questionId: question.id, answer: value };
    setPending(request);
    setSelection(request.answer);
    const requestIdentity = liveIdentity.current;
    const response = await api<AnswerResult>('/quiz/answer', {
      ...request,
      responseMs: Math.min(86400000, Math.max(0, Date.now() - startedAt)),
    });
    if (requestIdentity !== liveIdentity.current) {
      await props.refresh();
      return;
    }
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
          startSession(session.filter((q) => wrongIds.has(q.id)));
        }}
        onAgain={resetSession}
      />
    );
  if ((!session || !question) && !subject && !materialId)
    return (
      <>
        <ScreenHeader
          title="문제은행"
          back={() => props.back('/study')}
          action={<StudyLibraryAction props={props} />}
        />
        <div className={setup.content}>
          <div className={setup.intro}>
            <h2>어떤 과목을 공부할까요?</h2>
            <p>과목 폴더에서 문제를 고르고, 필요한 만큼 풀어요.</p>
          </div>
          <LearningFolders
            data={props.data}
            mode="quiz"
            onSelect={setSubject}
            onManage={() => props.navigate('/subjects')}
          />
        </div>
      </>
    );
  if (!session || !question)
    return (
      <>
        <ScreenHeader
          title="문제은행"
          back={() => (materialId ? props.back('/study') : closeFolder())}
          action={<StudyLibraryAction props={props} />}
        />
        <div className={setup.content} data-quiz-setup>
          <div className={setup.intro}>
            <h2>오늘의 문제를 골라요</h2>
            <p>범위와 문제 수만 정하면 바로 시작할 수 있어요.</p>
          </div>
          <section className={`${setup.section} ${setup.scope}`} aria-labelledby="quiz-scope">
            <div className={setup.heading}>
              <h3 id="quiz-scope">학습 범위</h3>
            </div>
            {materialId ? (
              <div className={setup.material}>
                <BookOpen size={20} aria-hidden="true" />
                <span>{scopedMaterial?.title || '선택한 자료'}</span>
              </div>
            ) : (
              <button className={setup.material} onClick={closeFolder}>
                <BookOpen size={20} aria-hidden="true" />
                <span>
                  {props.data.subjects.find((s) => s.id === subject)?.name || '과목 미지정'}
                </span>
                <span className="ml-auto text-xs text-muted">폴더 변경</span>
              </button>
            )}
          </section>
          <section className={setup.section} aria-labelledby="quiz-mode">
            <div className={setup.heading}>
              <h3 id="quiz-mode">어떤 문제를 풀까요?</h3>
            </div>
            <div className={setup.modes} role="group" aria-labelledby="quiz-mode">
              {[
                ['new', '안 푼 것부터'],
                ['wrong', '틀린 것만'],
                ['all', '전체 문제'],
              ].map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  className={setup.mode}
                  aria-pressed={priority === id}
                  onClick={() => setPriority(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {pool.length > 0 && <p className={setup.description}>{modeDescription}</p>}
          </section>
          {pool.length > 0 ? (
            <section className={setup.section} aria-labelledby="quiz-quantity">
              <div className={setup.heading}>
                <h3 id="quiz-quantity">이번에 풀 문제 수</h3>
                <span>선택한 범위에 {pool.length}개</span>
              </div>
              <div className={setup.quantities} role="group" aria-labelledby="quiz-quantity">
                {quantities.map((n) => (
                  <button
                    type="button"
                    key={n}
                    className={setup.quantity}
                    aria-pressed={count === n}
                    onClick={() => setLimit(n)}
                  >
                    {n === pool.length ? `전체 ${n}개` : `${n}개`}
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <div className={setup.empty} role="status">
              <h3>
                {priority === 'wrong' && scopedQuestions.length
                  ? '다시 풀 오답이 없어요'
                  : '이 범위에는 아직 문제가 없어요'}
              </h3>
              <p>
                {priority === 'wrong' && scopedQuestions.length
                  ? '마지막 풀이에서 틀린 문제가 생기면 여기에 모여요. 지금은 전체 문제로 공부해 보세요.'
                  : hasGenerationSources
                    ? '자료에서 문제를 만들면 바로 풀 수 있어요.'
                    : '먼저 학습 자료를 추가해 주세요. 자료에서 문제를 만들 수 있어요.'}
              </p>
            </div>
          )}
          {pool.length > 0 && (
            <button type="button" className={setup.create} onClick={openGeneration}>
              <Plus size={20} aria-hidden="true" />
              <span>
                <strong>새 문제 만들기</strong>
                <small>내 자료에서 문제를 더 만들어요</small>
              </span>
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className={setup.footer}>
          {pool.length > 0 ? (
            <>
              <p aria-live="polite">{count}문제를 이어서 풀어요</p>
              <Button
                className="w-full"
                onClick={() => {
                  startSession(pool.slice(0, count));
                }}
              >
                {count}문제 시작하기 <ArrowRight size={18} />
              </Button>
            </>
          ) : scopedQuestions.length > 0 ? (
            <Button className="w-full" onClick={() => setPriority('all')}>
              전체 문제에서 고르기 <ArrowRight size={18} />
            </Button>
          ) : (
            <Button className="w-full" onClick={openGeneration}>
              {hasGenerationSources
                ? '자료로 문제 만들기'
                : subject
                  ? '자료 추가하기'
                  : '학습 자료 고르기'}{' '}
              <Plus size={18} />
            </Button>
          )}
        </div>
        {generate && (
          <GenerationSheet
            open
            onClose={() => setGenerate(false)}
            props={props}
            initialMaterial={scopedMaterial?.id}
            initialFolder={subject || scopedMaterial?.subjectId}
          />
        )}
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
              afterExplanation={
                <>
                  <ConceptConnections props={props} question={question} />
                  <CommunityAsk {...props} question={question} kind="EXPLAIN" />
                </>
              }
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
  const [focusId, setFocusId] = useState(wrong[0]?.id || questions[0]?.id || '');
  const focus = questions.find((q) => q.id === focusId) || questions[0];
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
        <CommunityAnswersRow props={props} />
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
        {focus && (
          <section className="mt-6 space-y-3">
            <OptionField
              label="더 살펴볼 문제"
              title="더 살펴볼 문제"
              name="quiz-result-focus"
              value={focus.id}
              options={questions.map((q, i) => ({
                value: q.id,
                label: `${i + 1}. ${q.prompt}`,
                description: wrong.some((w) => w.id === q.id) ? '다시 살펴보기' : undefined,
              }))}
              onChange={setFocusId}
            />
            <p className="text-sm leading-relaxed text-muted">{focus.prompt}</p>
            <CommunityAsk
              key={focus.id}
              {...props}
              question={focus}
              kind="EXPLAIN"
              heading="이 문제, 원하는 방법으로 이어가요"
            />
          </section>
        )}
        <div className="mt-7 space-y-3">
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
  const [subject, setSubject] = useJourneyState(
    'wrongNotes.subject',
    params(props.path).get('subject') || '',
  );
  const [selected, setSelected] = useJourneyState<string[]>('wrongNotes.selected', []);
  const [bulk, setBulk] = useJourneyState('wrongNotes.bulk', false);
  const [opened, setOpened] = useJourneyState<string | null>('wrongNotes.opened', null);
  const [viewer, setViewer] = useState<{ material: Material; citation?: string } | null>(null);
  const action = useAction();
  const questions = wrongQuestions(props.data).filter(
    (q) => !subject || inLearningFolder(q.subjectId, subject, props.data.subjects),
  );
  const essays = wrongEssays(props.data).filter(
    (e) => !subject || inLearningFolder(e.subjectId, subject, props.data.subjects),
  );
  const recent = latestAttempts(props.data.attempts, 'questionId');
  const wrongCounts = new Map<string, number>();
  props.data.attempts.forEach((attempt) => {
    if (attempt.questionId && !attempt.correct)
      wrongCounts.set(attempt.questionId, (wrongCounts.get(attempt.questionId) ?? 0) + 1);
  });
  const closeFolder = useJourneyLayer(!!subject, () => {
    setSubject('');
    setOpened(null);
    setBulk(false);
  });
  const selectedVisible = selected.filter((id) => questions.some((q) => q.id === id));
  if (!subject)
    return (
      <>
        <ScreenHeader
          title="오답노트"
          back={() => props.back('/study')}
          action={<StudyLibraryAction props={props} />}
        />
        <div className={setup.content}>
          <div className={setup.intro}>
            <h2>헷갈린 개념을 다시 살펴요</h2>
            <p>객관식과 서술형의 취약 문제를 과목별로 모았어요.</p>
          </div>
          <LearningFolders
            data={props.data}
            mode="notes"
            onSelect={setSubject}
            onManage={() => props.navigate('/subjects')}
          />
        </div>
      </>
    );
  return (
    <>
      <ScreenHeader
        title="오답노트"
        back={closeFolder}
        action={<StudyLibraryAction props={props} />}
      />
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
        <button className={setup.material} onClick={closeFolder}>
          <BookOpen size={20} aria-hidden="true" />
          <span>{props.data.subjects.find((s) => s.id === subject)?.name || '과목 미지정'}</span>
          <span className="ml-auto text-xs text-muted">폴더 변경</span>
        </button>
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
                  const sourceTitle = props.data.materials.find(
                    (m) => m.id === q.materialId,
                  )?.title;
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
                        {sourceTitle ? `${sourceTitle} · ` : ''}
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
                            <ConceptConnections props={props} question={q} />
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
