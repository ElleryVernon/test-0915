'use client';
import { useMemo, useState } from 'react';
import { ArrowRight, Check, ChevronRight, BookOpen, RotateCcw, Sparkles } from '@/components/icons';
import type { Material, Question, ScreenProps } from '@/lib/contracts';
import { Button, EmptyState, ScreenHeader, SectionTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { remainingMaterialQuestions } from '@/lib/home';
import { latestAttempts, wrongEssays, wrongQuestions } from './logic';
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

type AnswerResult = { correct: boolean; explanation: string; citation: string };
export function Quiz(props: ScreenProps) {
  const query = params(props.path);
  const [subject, setSubject] = useState(query.get('subject') || '');
  const [priority, setPriority] = useState('new');
  const [limit, setLimit] = useState(10);
  const [generate, setGenerate] = useState(false);
  const [session, setSession] = useState<Question[] | null>(() =>
    query.get('question')
      ? props.data.questions.filter((q) => q.id === query.get('question'))
      : query.get('resume') === '1' && query.get('material')
        ? remainingMaterialQuestions(props.data, query.get('material')!)
        : null,
  );
  const [index, setIndex] = useState(0);
  const [selection, setSelection] = useState<number | null>(null);
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [answered, setAnswered] = useState<{ id: string; correct: boolean }[]>([]);
  const [viewer, setViewer] = useState<Material | null>(null);
  const [finished, setFinished] = useState(false);
  const action = useAction();
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
    const response = await api<AnswerResult>('/quiz/answer', {
      questionId: question.id,
      answer: value,
    });
    setSelection(value);
    setResult(response);
    setAnswered((current) => [...current, { id: question.id, correct: response.correct }]);
    await props.refresh();
  }
  if (finished && session)
    return (
      <QuizResult
        props={props}
        questions={session}
        answers={answered}
        onAgain={() => {
          setSession(null);
          setIndex(0);
          setSelection(null);
          setResult(null);
          setAnswered([]);
          setFinished(false);
        }}
      />
    );
  if (!session || !question)
    return (
      <>
        <ScreenHeader title="문제 풀기" back={() => props.navigate('/study')} />
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
              onClick={() => setSession(pool.slice(0, limit))}
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
        back={() => {
          setSession(null);
          setIndex(0);
          setSelection(null);
          setResult(null);
          setAnswered([]);
          setFinished(false);
        }}
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
            <div className="mt-6 space-y-2" role="radiogroup" aria-label="답안 선택">
              {question.options.map((option, i) => (
                <button
                  key={i}
                  role="radio"
                  aria-checked={selection === i}
                  onClick={() => setSelection(i)}
                  disabled={action.busy}
                  className="answer-option"
                >
                  <span className="answer-number">{i + 1}</span>
                  <span className="text-[16px] font-semibold leading-relaxed">{option}</span>
                </button>
              ))}
            </div>
            <div className="exercise-actions mt-6 space-y-2">
              <ErrorNote error={action.error} />
              <Button
                className="w-full"
                variant="ghost"
                disabled={action.busy}
                onClick={() => action.run(() => answer(-1))}
              >
                잘 모르겠어요
              </Button>
              <Button
                className="w-full"
                disabled={selection === null || action.busy}
                onClick={() => action.run(() => answer(selection!))}
              >
                {action.busy ? <BusyText>확인하고 있어요</BusyText> : '정답 확인'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="mt-7">
              <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-surface">
                {result.correct ? <Check size={25} /> : <RotateCcw size={23} />}
              </span>
              <h2 className="text-[26px] font-extrabold tracking-[-.035em]">
                {result.correct ? '정확히 알고 있어요' : '다시 생각하면 더 오래 남아요'}
              </h2>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">
                정답은{' '}
                <strong className="text-ink">
                  {question.answer + 1}번 · {question.options[question.answer]}
                </strong>
                {!result.correct && (
                  <>
                    <br />
                    오답노트에 넣어 두었어요.
                  </>
                )}
              </p>
            </div>
            <p className="my-5 whitespace-pre-wrap text-[15px] leading-[1.8] text-secondary">
              {result.explanation}
            </p>
            <Citation
              citation={result.citation}
              material={material}
              onOpen={() => setViewer(material || null)}
            />
            <section className="mt-7">
              <h3 className="mb-3 text-[16px] font-bold">개념은 이렇게 이어져요</h3>
              <div className="grid grid-cols-3 gap-2">
                {[
                  ['배운 것', question.past],
                  ['지금', question.prompt],
                  ['다음', question.future],
                ].map(([label, text], i) => (
                  <div
                    key={label}
                    className={`min-w-0 rounded-2xl p-3 ${i === 1 ? 'bg-ink text-white' : 'bg-surface'}`}
                  >
                    <p
                      className={`mb-2 text-[11px] font-semibold ${i === 1 ? 'text-white/65' : 'text-muted'}`}
                    >
                      {label}
                    </p>
                    <p className="line-clamp-4 text-[12px] font-semibold leading-relaxed">
                      {text || '자료 속 개념'}
                    </p>
                  </div>
                ))}
              </div>
              <button
                onClick={() => props.navigate('/completed-subjects')}
                className="mt-2 min-h-11 text-xs font-semibold text-muted"
              >
                배운 과목 설정하기 <ChevronRight className="inline" size={14} />
              </button>
            </section>
            <ErrorNote error={action.error} />
            <Button
              className="mt-5 w-full"
              onClick={() => {
                if (index + 1 === session.length) setFinished(true);
                else {
                  setIndex(index + 1);
                  setSelection(null);
                  setResult(null);
                  action.setError('');
                  window.scrollTo({ top: 0 });
                }
              }}
            >
              {index + 1 === session.length ? '학습 결과 보기' : '다음 문제'}
              <ArrowRight size={18} />
            </Button>
          </>
        )}
      </div>
      <MaterialViewer material={viewer} onClose={() => setViewer(null)} />
    </>
  );
}
function QuizResult({
  props,
  questions,
  answers,
  onAgain,
}: {
  props: ScreenProps;
  questions: Question[];
  answers: { id: string; correct: boolean }[];
  onAgain: () => void;
}) {
  const wrong = questions.filter((q) => answers.some((a) => a.id === q.id && !a.correct));
  const [selected, setSelected] = useState(wrong.map((q) => q.id));
  const action = useAction();
  const correct = answers.filter((a) => a.correct).length;
  return (
    <>
      <ScreenHeader title="학습 결과" back={() => props.navigate('/study')} />
      <div className="page-inset pb-8">
        <div className="py-5">
          <span className="eyebrow">오늘도 한 걸음 쌓았어요</span>
          <h1 className="mt-3 text-[48px] font-extrabold tracking-[-.045em]">
            {correct}
            <span className="ml-2 text-[25px] text-disabled">/ {questions.length}</span>
          </h1>
          <p className="mt-2 text-[15px] text-muted">
            {wrong.length
              ? '틀린 개념은 복습 카드로 오래 기억해요.'
              : '모든 문제를 맞혔어요. 배운 내용을 잘 알고 있어요.'}
          </p>
        </div>
        {wrong.length > 0 && (
          <>
            <SectionTitle
              title={`틀린 개념 ${wrong.length}개`}
              action={<span className="text-xs text-muted">오답노트에 저장됨</span>}
            />
            <p className="mb-3 text-[13px] text-muted">복습 카드로 만들 개념을 골라 주세요.</p>
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
          <Button className="w-full" variant="ghost" onClick={() => props.navigate('/study')}>
            학습으로 돌아가기
          </Button>
        </div>
      </div>
    </>
  );
}
export function WrongNotes(props: ScreenProps) {
  const [tab, setTab] = useState('객관식');
  const [subject, setSubject] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [opened, setOpened] = useState<string | null>(null);
  const [viewer, setViewer] = useState<Material | null>(null);
  const action = useAction();
  const questions = wrongQuestions(props.data).filter((q) => !subject || q.subjectId === subject);
  const essays = wrongEssays(props.data).filter((e) => !subject || e.subjectId === subject);
  const selectedVisible = selected.filter((id) => questions.some((q) => q.id === id));
  return (
    <>
      <ScreenHeader title="오답노트" back={() => props.navigate('/study')} />
      <div className="page-inset pb-8">
        <p className="mt-1 text-[14px] text-muted">틀린 순간이 기억의 시작이 돼요.</p>
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
              <div className="my-4 flex items-center justify-between">
                <span className="text-xs text-muted">복습 카드로 보낼 문제 선택</span>
                <button
                  className="min-h-11 text-sm font-semibold"
                  onClick={() =>
                    setSelected(
                      selectedVisible.length === questions.length ? [] : questions.map((q) => q.id),
                    )
                  }
                >
                  {selectedVisible.length === questions.length ? '선택 해제' : '전체 선택'}
                </button>
              </div>
              <div className="space-y-3">
                {questions.map((q) => (
                  <article key={q.id} className="rounded-[20px] bg-surface p-4">
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        aria-label={`${q.prompt} 선택`}
                        checked={selected.includes(q.id)}
                        onChange={(e) =>
                          setSelected((ids) =>
                            e.target.checked ? [...ids, q.id] : ids.filter((id) => id !== q.id),
                          )
                        }
                        className="mt-1 h-5 w-5 shrink-0 accent-ink"
                      />
                      <button
                        className="flex-1 text-left"
                        onClick={() => setOpened(opened === q.id ? null : q.id)}
                      >
                        <span className="mb-2 block text-xs text-muted">
                          {props.data.subjects.find((s) => s.id === q.subjectId)?.name}
                        </span>
                        <span className="text-[15px] font-bold leading-relaxed">{q.prompt}</span>
                      </button>
                    </div>
                    {opened === q.id && (
                      <div className="mt-4 space-y-3">
                        <p className="text-[14px] font-bold">정답 · {q.options[q.answer]}</p>
                        <p className="text-sm leading-relaxed text-secondary">{q.explanation}</p>
                        <Citation
                          citation={q.citation}
                          material={props.data.materials.find((m) => m.id === q.materialId)}
                          onOpen={() =>
                            setViewer(
                              props.data.materials.find((m) => m.id === q.materialId) || null,
                            )
                          }
                        />
                        <Button
                          className="w-full"
                          onClick={() => props.navigate(`/quiz?question=${q.id}`)}
                        >
                          다시 풀기
                        </Button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
              <ErrorNote error={action.error} />
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
                  onClick={() => props.navigate(`/essay?essay=${e.id}`)}
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
      <MaterialViewer material={viewer} onClose={() => setViewer(null)} />
    </>
  );
}
