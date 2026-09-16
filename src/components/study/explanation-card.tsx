'use client';

import { useRef, useState } from 'react';
import type { Card, Question } from '@/lib/contracts';
import type { LearningExplanation, MicroResult } from '@/lib/explanation-types';
import { api } from '@/lib/api';
import { Check, ChevronRight, Layers } from '@/components/icons';
import { Button, Sheet } from '@/components/ui';
import { useJourneyState } from '@/components/journey';
import { BusyText, ErrorNote, errorMessage } from './shared';
import { ExplanationDiagram } from './explanation-diagram';
import styles from './explanation-card.module.css';

type CreationProps = {
  question: Question;
  explanation: LearningExplanation;
  focusNodeId?: string;
  microResult?: MicroResult;
  existingCard?: Card;
  onCreated?: (card: Card) => void;
  toast: (message: string) => void;
};

/** A new question owns a new selection and receipt; returning restores that question's draft. */
export function ExplanationCardButton(props: CreationProps) {
  if (props.explanation.status !== 'READY' || !props.explanation.diagram?.nodes.length) return null;
  return <CardCreator key={`${props.question.id}:${props.explanation.diagram.id}`} {...props} />;
}

function CardCreator({
  question,
  explanation,
  focusNodeId,
  microResult,
  existingCard,
  onCreated,
  toast,
}: CreationProps) {
  const diagram = explanation.diagram!;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useJourneyState<string[]>(
    `explanation.cardMasks.${question.id}`,
    () => {
      const initial = [focusNodeId, diagram.answerNodeId, diagram.nodes[0].id].find((id) =>
        diagram.nodes.some((node) => node.id === id),
      );
      return initial ? [initial] : [];
    },
  );
  const matchingExisting =
    existingCard?.diagram && !existingCard.deleted && existingCard.sourceQuestionId === question.id
      ? existingCard
      : null;
  const [receipt, setSaved] = useJourneyState<Card | null>(
    `explanation.cardReceipt.${question.id}`,
    matchingExisting,
  );
  // Bootstrap can arrive after this component mounts or contain a newer review schedule.
  // Prefer that exact card over a journey receipt; opening it must never post another create.
  const saved = matchingExisting ?? receipt;
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const masks = selected.filter((id) => diagram.nodes.some((node) => node.id === id));

  async function create() {
    if (lock.current || saved || !masks.length) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      // The endpoint is idempotent per user and source question, including an uncertain retry.
      const card = await api<Card>('/quiz/explanation-card', {
        questionId: question.id,
        nodeIds: masks,
        ...(microResult ? { microResult } : {}),
      });
      setSaved(card);
      setRevealed(false);
      toast(card.diagram ? '가림 카드를 저장했어요' : '이 문제로 만든 복습 카드가 이미 있어요');
      onCreated?.(card);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="compact"
        className={styles.entry}
        onClick={() => setOpen(true)}
      >
        {busy ? (
          <BusyText>카드 저장 중</BusyText>
        ) : saved ? (
          <>
            <Check size={16} />
            {saved.diagram ? '저장한 가림 카드 보기' : '저장한 카드 보기'}
          </>
        ) : (
          <>
            <Layers size={16} />
            가림 카드로 복습하기
          </>
        )}
        <ChevronRight size={16} />
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={
          saved
            ? saved.diagram
              ? '저장한 가림 카드'
              : '이미 만든 복습 카드예요'
            : '가림 카드 만들기'
        }
      >
        <div className={styles.creator}>
          {saved ? (
            <>
              <p className={styles.description} role="status">
                {formatDue(saved.nextReviewAt)} · 복습 카드에서 다시 볼 수 있어요.
              </p>
              {saved.diagram ? (
                <DiagramCardContent card={saved} revealed={revealed} />
              ) : (
                <div className={styles.savedText}>
                  <strong>{saved.front}</strong>
                  {revealed && <p>{saved.back}</p>}
                </div>
              )}
              <button
                className={styles.previewToggle}
                onClick={() => setRevealed((value) => !value)}
              >
                {revealed ? '앞면 보기' : '정답 확인하기'}
              </button>
              {saved.diagram && (
                <p className={styles.note}>같은 문제의 가림 카드는 한 장만 저장해요.</p>
              )}
              {!saved.diagram && (
                <p className={styles.note}>기존 카드의 내용과 복습 일정은 그대로 유지했어요.</p>
              )}
              <Button className="w-full" onClick={() => setOpen(false)}>
                학습 계속하기
              </Button>
            </>
          ) : (
            <>
              <p className={styles.description}>
                다시 떠올리고 싶은 부분을 골라 가려 보세요. 한 곳 이상 선택할 수 있어요.
              </p>
              <fieldset className={styles.selection} disabled={busy}>
                <legend>
                  가릴 부분 <span>{masks.length}곳 선택</span>
                </legend>
                {diagram.nodes.map((node, index) => (
                  <button
                    key={node.id}
                    type="button"
                    aria-pressed={masks.includes(node.id)}
                    className={styles.node}
                    onClick={() => {
                      setSelected((ids) =>
                        ids.includes(node.id)
                          ? ids.filter((id) => id !== node.id)
                          : [...ids, node.id],
                      );
                      setRevealed(false);
                    }}
                  >
                    <span className={styles.number}>{index + 1}</span>
                    <span>{node.label}</span>
                    <span className={styles.check} aria-hidden="true">
                      {masks.includes(node.id) && <Check size={14} />}
                    </span>
                  </button>
                ))}
              </fieldset>
              <section className={styles.preview} aria-label="카드 미리보기">
                <div className={styles.previewHeading}>
                  <strong>미리보기 · {revealed ? '뒷면' : '앞면'}</strong>
                  <button
                    className={styles.previewToggle}
                    onClick={() => setRevealed((value) => !value)}
                  >
                    {revealed ? '앞면 보기' : '정답 보기'}
                  </button>
                </div>
                <ExplanationDiagram
                  explanation={explanation}
                  maskedNodeIds={masks}
                  revealed={revealed}
                  interactive={false}
                  depth="FULL"
                />
              </section>
              {!masks.length && (
                <p className={styles.note} role="status">
                  가릴 부분을 한 곳 이상 골라 주세요.
                </p>
              )}
              <ErrorNote error={error} />
              <Button
                className="w-full"
                disabled={busy || !masks.length}
                onClick={() => void create()}
              >
                {busy ? (
                  <BusyText>카드 저장 중</BusyText>
                ) : error ? (
                  '카드 저장 다시 시도'
                ) : (
                  `${masks.length}곳 가린 카드 저장`
                )}
              </Button>
              <p className={styles.note}>저장 버튼을 눌러야 복습 카드에 추가돼요.</p>
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}

function formatDue(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '복습 예정일은 카드 보관함에서 확인해 주세요'
    : `${new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(date)} 복습 예정`;
}

/** Card diagrams are validated and persisted by the server. Source interactions stay in quiz. */
export function DiagramCardContent({ card, revealed = false }: { card: Card; revealed?: boolean }) {
  if (!card.diagram) return null;
  const explanation: LearningExplanation = {
    version: 1,
    status: 'READY',
    questionId: card.sourceQuestionId ?? card.id,
    citation: '',
    optionReasons: [],
    microChecks: [],
    source: 'rule',
    diagram: card.diagram,
  };
  return (
    <div className={styles.cardDiagram}>
      <ExplanationDiagram
        explanation={explanation}
        maskedNodeIds={card.maskedNodeIds ?? []}
        revealed={revealed}
        interactive={false}
        depth="FULL"
      />
    </div>
  );
}
