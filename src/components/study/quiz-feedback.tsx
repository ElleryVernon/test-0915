'use client';
import { sessionFetch } from '@/lib/session-boundary';

import { useEffect, useState, type ReactNode } from 'react';
import type { Card, Material, Question, ScreenProps } from '@/lib/contracts';
import type { ExplanationDepth, LearningExplanation, MicroResult } from '@/lib/explanation-types';
import { api, apiErrorOf } from '@/lib/api';
import { validateExplanation } from '@/lib/explanation-validation';
import { useJourneyState } from '../journey';
import { Button } from '../ui';
import { Citation, ErrorNote, useAction } from './shared';
import { ExplanationDiagram } from './explanation-diagram';
import { ExplanationCardButton } from './explanation-card';
import styles from './quiz-feedback.module.css';
import layout from './study-layout.module.css';

export type AnswerResult = {
  correct: boolean;
  explanation: string;
  citation: string;
  attemptId?: string;
};
type Stage = 'VERDICT' | 'EXPLANATION' | 'CHECK';

function useExplanation(question: Question) {
  const [saved, setSaved] = useJourneyState<LearningExplanation | null>(
    `explanation.grounded-v2.${question.id}`,
    null,
  );
  const [loading, setLoading] = useState(!saved);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (saved) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let current = true;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const response = await sessionFetch(
          `/api/quiz/explanation?questionId=${encodeURIComponent(question.id)}`,
          { signal: controller.signal },
        );
        const body = await response.json();
        if (!response.ok) throw apiErrorOf(response, body, '해설을 불러오지 못했어요.');
        const explanation = validateExplanation(body.data);
        if (!explanation || explanation.questionId !== question.id)
          throw new Error('해설의 원문 근거를 확인하지 못했어요.');
        if (current) setSaved(explanation);
      } catch {
        if (current)
          setError('추가 해설을 불러오지 못했어요. 기존 해설과 원문은 확인할 수 있어요.');
      } finally {
        clearTimeout(timer);
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [question.id, retry, saved, setSaved]);
  return { explanation: saved, loading, error, retry: () => setRetry((v) => v + 1) };
}

type ExplanationProps = {
  question: Question;
  existingCard?: Card;
  explanation: LearningExplanation | null;
  material?: Material;
  selectedAnswer?: number | null;
  depth: ExplanationDepth;
  onDepth: (depth: ExplanationDepth) => void;
  onOpenSource: (citation: string) => void;
  toast: ScreenProps['toast'];
  refresh: ScreenProps['refresh'];
  microResult?: MicroResult;
  onFocus?: (id: string) => void;
};
function ExplanationContent(p: ExplanationProps) {
  const { question, explanation, depth } = p;
  const [focus, setFocus] = useState<string | undefined>(
    () =>
      explanation?.diagram?.optionNodeMap?.[String(p.selectedAnswer)] ??
      explanation?.diagram?.answerNodeId,
  );
  const [reported, setReported] = useJourneyState(`explanation.reported.${question.id}`, false);
  const report = useAction();
  const reason =
    p.selectedAnswer != null && p.selectedAnswer >= 0
      ? explanation?.optionReasons[p.selectedAnswer]
      : undefined;
  return (
    <div className={`${styles.explanation} ${layout.stack}`}>
      <div className={styles.sectionHead}>
        <h3>핵심 살펴보기</h3>
        {explanation?.diagram && (
          <div className={styles.depth} role="group" aria-label="해설 길이">
            <button aria-pressed={depth === 'SHORT'} onClick={() => p.onDepth('SHORT')}>
              핵심만
            </button>
            <button aria-pressed={depth === 'FULL'} onClick={() => p.onDepth('FULL')}>
              자세히
            </button>
          </div>
        )}
      </div>
      {reason && <p className={styles.reason}>{reason}</p>}
      <p className={styles.prose}>{question.explanation}</p>
      {explanation?.diagram && (
        <ExplanationDiagram
          explanation={explanation}
          selectedAnswer={p.selectedAnswer}
          depth={depth}
          onNodeSelect={(id) => {
            setFocus(id);
            p.onFocus?.(id);
          }}
          onOpenSource={() => p.onOpenSource(explanation.citation)}
        />
      )}
      {(!explanation?.diagram || depth === 'FULL') && (
        <Citation
          citation={explanation?.citation || question.citation}
          material={p.material}
          onOpen={() => p.onOpenSource(explanation?.citation || question.citation)}
        />
      )}
      {explanation?.diagram && (
        <ExplanationCardButton
          question={question}
          existingCard={p.existingCard}
          explanation={explanation}
          focusNodeId={focus}
          microResult={p.microResult}
          toast={p.toast}
          onCreated={() => {
            void p.refresh().catch(() => p.toast('카드는 저장했어요. 목록은 다시 열면 갱신돼요.'));
          }}
        />
      )}
      {explanation && (
        <div className={styles.report}>
          <button
            className={layout.textAction}
            disabled={reported || report.busy}
            onClick={() =>
              report.run(async () => {
                await api('/quiz/explanation/report', {
                  questionId: question.id,
                  ...(focus ? { nodeId: focus } : {}),
                  reason: 'source-mismatch',
                });
                setReported(true);
              })
            }
          >
            {reported
              ? '원문 불일치 제보가 접수됐어요'
              : report.busy
                ? '접수 중…'
                : '원문과 다른 내용 제보'}
          </button>
          <ErrorNote error={report.error} />
        </div>
      )}
    </div>
  );
}

export function QuestionExplanation(
  p: Omit<ExplanationProps, 'explanation' | 'depth' | 'onDepth'> & {
    defaultDepth?: ExplanationDepth;
  },
) {
  const loaded = useExplanation(p.question);
  const [depth, setDepth] = useJourneyState<ExplanationDepth>(
    `explanation.depth.${p.question.id}`,
    p.defaultDepth ?? 'SHORT',
  );
  return (
    <>
      <ExplanationContent
        {...p}
        explanation={loaded.explanation}
        depth={depth}
        onDepth={setDepth}
      />
      <LoadStatus {...loaded} />
    </>
  );
}
function LoadStatus(p: { loading: boolean; error: string; retry: () => void }) {
  return p.loading ? (
    <p className={styles.notice} role="status">
      원문에 맞는 추가 해설을 불러오고 있어요.
    </p>
  ) : p.error ? (
    <div className={styles.notice} role="status">
      {p.error}
      <button onClick={p.retry}>다시 불러오기</button>
    </div>
  ) : null;
}

export function QuizFeedback(p: {
  question: Question;
  result: AnswerResult;
  existingCard?: Card;
  selected: number | null;
  material?: Material;
  nextLabel: string;
  onNext: () => void;
  onOpenSource: (citation: string) => void;
  toast: ScreenProps['toast'];
  refresh: ScreenProps['refresh'];
  defaultDepth?: ExplanationDepth;
  onCheck: (result: MicroResult) => void;
  afterExplanation?: ReactNode;
}) {
  const loaded = useExplanation(p.question);
  const explanation = loaded.explanation;
  const key = `${p.question.id}.${p.result.attemptId ?? 'legacy'}`;
  const [stage, setStage] = useJourneyState<Stage>(`feedback.stage.${key}`, 'VERDICT');
  const [depth, setDepth] = useJourneyState<ExplanationDepth>(
    `feedback.depth.${key}`,
    p.defaultDepth ?? 'SHORT',
  );
  const [selected, setSelected] = useJourneyState<number | null>(
    `feedback.checkAnswer.${key}`,
    null,
  );
  const [microResult, setMicroResult] = useJourneyState<MicroResult | null>(
    `feedback.checkResult.${key}`,
    null,
  );
  const [focus, setFocus] = useState<string>();
  const action = useAction();
  const mappedNode =
    explanation?.diagram?.optionNodeMap?.[String(p.selected)] ?? explanation?.diagram?.answerNodeId;
  const micro =
    explanation?.microChecks.find((item) => item.nodeId === mappedNode) ??
    explanation?.microChecks[0];
  const canCheck = !!micro && !!p.result.attemptId && !p.result.correct;
  async function reflect(next: Stage, options?: { answer?: number; skipped?: boolean }) {
    if (!p.result.attemptId) return;
    const response = await api<{ microResult?: MicroResult }>('/quiz/reflection', {
      questionId: p.question.id,
      attemptId: p.result.attemptId,
      stage: next,
      depth,
      ...(next === 'CHECK' && micro ? { microCheckId: micro.id } : {}),
      ...options,
    });
    if (response.microResult) {
      setMicroResult(response.microResult);
      p.onCheck(response.microResult);
      void p.refresh().catch(() => p.toast('확인 결과는 저장했어요. 목록은 다시 열면 갱신돼요.'));
    }
  }
  const openExplanation = () => {
    setStage('EXPLANATION');
    void action.run(() => reflect('EXPLANATION'));
  };
  const next = () => {
    p.onNext();
  };
  return (
    <section className={styles.feedback} aria-label="풀이 피드백">
      <ol className={styles.steps} aria-label="해설 단계">
        {(
          [
            ['VERDICT', '정답 확인'],
            ['EXPLANATION', '이유 이해'],
            ...(canCheck ? [['CHECK', '이해 확인']] : []),
          ] as [Stage, string][]
        ).map(([id, label], i) => (
          <li key={id} aria-current={stage === id ? 'step' : undefined}>
            <span>{i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <h2 className={styles.title}>
        {stage === 'VERDICT'
          ? p.result.correct
            ? '맞았어요'
            : p.selected === -1
              ? '함께 답을 살펴볼까요?'
              : '이 부분을 다시 살펴봐요'
          : stage === 'EXPLANATION'
            ? p.result.correct || p.selected === -1
              ? '답의 근거를 살펴봐요'
              : '어디에서 답이 달라졌을까요?'
            : '이해했는지 한 번 확인해요'}
      </h2>
      <p className={styles.prompt}>{p.question.prompt}</p>
      {stage === 'VERDICT' ? (
        <>
          <div className={styles.answerSummary}>
            {!p.result.correct && (
              <div>
                <span>내 선택</span>
                <p>
                  {p.selected != null && p.selected >= 0
                    ? `${p.selected + 1}번 · ${p.question.options[p.selected]}`
                    : '잘 모르겠어요'}
                </p>
              </div>
            )}
            <div>
              <span>정답</span>
              <p>
                {p.question.answer + 1}번 · {p.question.options[p.question.answer]}
              </p>
            </div>
          </div>
          {!p.result.correct && (
            <p className={styles.notice}>오답노트에 저장했어요. 해설을 보고 다시 풀 수 있어요.</p>
          )}
          <div className={styles.actions}>
            <Button className="w-full" onClick={p.result.correct ? next : openExplanation}>
              {p.result.correct ? p.nextLabel : '이유 살펴보기'}
            </Button>
            <Button
              className="w-full"
              variant="ghost"
              onClick={p.result.correct ? openExplanation : next}
            >
              {p.result.correct ? '해설 살펴보기' : `${p.nextLabel} · 해설 건너뛰기`}
            </Button>
          </div>
        </>
      ) : stage === 'EXPLANATION' ? (
        <>
          <ExplanationContent
            question={p.question}
            existingCard={p.existingCard}
            explanation={explanation}
            material={p.material}
            selectedAnswer={p.result.correct ? null : p.selected}
            depth={depth}
            onDepth={setDepth}
            onOpenSource={p.onOpenSource}
            toast={p.toast}
            refresh={p.refresh}
            microResult={microResult ?? undefined}
            onFocus={setFocus}
          />
          <LoadStatus {...loaded} />
          {p.afterExplanation}
          <div className={styles.actions}>
            <Button
              className="w-full"
              onClick={canCheck && !microResult ? () => setStage('CHECK') : next}
            >
              {canCheck && !microResult ? '짧게 확인해 보기' : p.nextLabel}
            </Button>
            {canCheck && !microResult && (
              <Button
                className="w-full"
                variant="ghost"
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await reflect('CHECK', { skipped: true });
                    next();
                  })
                }
              >
                확인 건너뛰고 {p.nextLabel}
              </Button>
            )}
            <button className={styles.textButton} onClick={() => setStage('VERDICT')}>
              정답 확인으로
            </button>
          </div>
        </>
      ) : micro ? (
        <>
          <p className={styles.notice}>연습용 확인이에요. 처음 푼 문제의 점수는 바뀌지 않아요.</p>
          <h3 className={styles.checkPrompt}>{micro.prompt}</h3>
          <div className={styles.options} role="group" aria-label="이해 확인 선택지">
            {micro.options.map((option, i) => (
              <button
                key={i}
                disabled={!!microResult || action.busy}
                aria-pressed={selected === i}
                onClick={() => setSelected(i)}
              >
                <span>{i + 1}</span>
                {option}
              </button>
            ))}
          </div>
          {microResult && (
            <div className={styles.checkFeedback} role="status">
              <strong>
                {microResult === 'PASS'
                  ? '확인 문제를 맞혔어요'
                  : microResult === 'SKIP'
                    ? '확인을 건너뛰었어요'
                    : '근거를 다시 연결해 봐요'}
              </strong>
              <p>{micro.explanation}</p>
            </div>
          )}
          {microResult && explanation?.diagram && (
            <ExplanationCardButton
              question={p.question}
              existingCard={p.existingCard}
              explanation={explanation}
              focusNodeId={focus ?? micro.nodeId}
              microResult={microResult}
              toast={p.toast}
              onCreated={() => {
                void p.refresh().catch(() => {});
              }}
            />
          )}
          <div className={styles.actions}>
            <Button
              className="w-full"
              disabled={!microResult && (selected === null || action.busy)}
              onClick={() =>
                microResult ? next() : action.run(() => reflect('CHECK', { answer: selected! }))
              }
            >
              {action.busy ? '확인 중…' : microResult ? p.nextLabel : '확인하기'}
            </Button>
            {!microResult && (
              <Button
                className="w-full"
                variant="ghost"
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await reflect('CHECK', { skipped: true });
                    next();
                  })
                }
              >
                건너뛰기
              </Button>
            )}
            <button className={styles.textButton} onClick={() => setStage('EXPLANATION')}>
              해설 다시 보기
            </button>
          </div>
        </>
      ) : (
        <Button onClick={() => setStage('EXPLANATION')}>해설로 돌아가기</Button>
      )}
      <ErrorNote error={action.error} />
      {action.error && (
        <Button variant="ghost" className="w-full" onClick={next}>
          저장하지 않고 {p.nextLabel}
        </Button>
      )}
    </section>
  );
}
