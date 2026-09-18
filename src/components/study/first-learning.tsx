'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Layers,
  Upload,
  X,
} from '@/components/icons';
import { Button, IconButton } from '@/components/ui';
import { api } from '@/lib/api';
import { firstLearning } from '@/lib/first-learning';
import { rememberSavedMaterial, useMaterialDetail } from '@/lib/materials';
import type { Material, ScreenProps } from '@/lib/contracts';
import { useJourneyState } from '../journey';
import styles from './first-learning.module.css';

const steps = ['자료 읽기', '문제 풀기', '카드 복습'];

export function FirstLearningWelcome({
  props,
  onAddSource,
}: {
  props: ScreenProps;
  onAddSource?: () => void;
}) {
  const { material, attempt, complete } = firstLearning(props.data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const upload = onAddSource ?? (() => props.navigate('/subjects?upload=1'));
  async function start() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ material: Material }>('/materials/sample', {});
      rememberSavedMaterial(result.material);
      await props.refresh();
      props.navigate(attempt ? '/start?step=card' : '/start');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className={styles.welcome} aria-labelledby="first-learning-title">
      <div className={styles.heading}>
        <span className={styles.eyebrow}>
          {complete ? '첫 학습 완료' : material ? '이어서 시작해요' : '처음 오셨군요'}
        </span>
        <h1 id="first-learning-title">
          {complete ? (
            <>
              이제 내 자료로
              <br />
              공부해 볼까요?
            </>
          ) : attempt ? (
            <>
              문제는 확인했어요
              <br />
              카드로 기억해 볼까요?
            </>
          ) : material ? (
            <>
              하던 학습을
              <br />
              마저 이어가요
            </>
          ) : (
            <>
              자료가 없어도,
              <br />
              지금 배워 볼 수 있어요
            </>
          )}
        </h1>
        <p>
          {complete
            ? '문제를 풀고 카드로 기억했어요. 수업 필기나 프린트로 이 흐름을 이어가 보세요.'
            : attempt
              ? '풀이 기록은 저장돼 있어요. 같은 개념을 카드로 한 번 더 떠올리면 첫 체험이 끝나요.'
              : material
                ? '예제 자료가 준비돼 있어요. 자료를 읽고, 문제와 복습 카드로 이어가 보세요.'
                : '짧은 예제로 문제를 풀고, 카드 한 장을 기억해 보세요. 약 1분이면 충분해요.'}
        </p>
      </div>
      {complete ? (
        <div className={styles.achievement}>
          <span className={styles.doneMark}>
            <Check size={24} />
          </span>
          <div>
            <strong>내 첫 학습을 마쳤어요</strong>
            <p>문제 1개 확인 · 카드 1장 복습</p>
          </div>
        </div>
      ) : (
        <div className={styles.preview}>
          <div className={styles.sourceLabel}>
            <FileText size={17} />
            <span>예제 자료 · 생명과학</span>
            <span>짧게 읽어요</span>
          </div>
          <h2>뉴런은 어떻게 신호를 전할까?</h2>
          <p>
            자극을 받으면 나트륨 이온이 세포 안으로 들어와요. 이때 막전위가 상승하는 현상을{' '}
            <mark>탈분극</mark>이라고 해요.
          </p>
          <div className={styles.previewSteps} aria-label="체험할 학습">
            <span>
              {attempt ? <Check size={16} /> : <BookOpen size={16} />}
              {attempt ? '문제 확인 완료' : '문제 1개'}
            </span>
            <ArrowRight size={14} />
            <span>
              <Layers size={16} />
              복습 카드 1장
            </span>
          </div>
        </div>
      )}
      <div className={styles.startActions}>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <Button className="w-full" onClick={complete ? upload : start} disabled={busy}>
          {busy
            ? '예제 준비 중…'
            : complete
              ? '내 자료 추가하기'
              : material
                ? '예제 학습 이어하기'
                : '예제로 1분 학습하기'}
          <ArrowRight size={18} />
        </Button>
        <Button
          variant="secondary"
          className="w-full"
          onClick={complete ? () => props.navigate('/study?methods=1') : upload}
          disabled={busy}
        >
          {complete ? <BookOpen size={18} /> : <Upload size={18} />}
          {complete ? '학습 방법 둘러보기' : '내 자료로 시작하기'}
        </Button>
        <p className={styles.footnote}>
          {complete
            ? '예제 자료와 복습 카드는 내 과목·자료에 남아 있어요.'
            : material
              ? '예제 자료와 저장한 풀이 기록은 내 공간에 남아 있어요.'
              : '체험을 시작하면 예제 자료가 내 공간에 저장돼요.'}
        </p>
      </div>
      <div className={styles.howItWorks}>
        <h2>내 자료로도 이렇게 공부해요</h2>
        <ol>
          <li>
            <span>
              <FileText size={18} />
            </span>
            <div>
              <strong>자료를 담고</strong>
              <p>필기·PDF·사진에서 배울 내용을 골라요</p>
            </div>
          </li>
          <li>
            <span>
              <BookOpen size={18} />
            </span>
            <div>
              <strong>이해를 확인하고</strong>
              <p>문제와 서술형으로 내 생각을 정리해요</p>
            </div>
          </li>
          <li>
            <span>
              <Layers size={18} />
            </span>
            <div>
              <strong>오래 기억해요</strong>
              <p>복습할 때가 된 카드를 다시 꺼내 봐요</p>
            </div>
          </li>
        </ol>
      </div>
    </section>
  );
}

/** A short real lesson: the ordinary quiz/review APIs own every learning event. */
export function FirstLearningLesson(props: ScreenProps) {
  const lesson = firstLearning(props.data);
  const { question, card, attempt, complete, material } = lesson;
  const [selected, setSelected] = useJourneyState<number | null>(
    'starter.selection',
    attempt ? Number(attempt.answer) : null,
  );
  const [revealed, setRevealed] = useJourneyState('starter.revealed', false);
  const [pendingAnswer, setPendingAnswer] = useJourneyState<{
    requestId: string;
    answer: number;
  } | null>('starter.answerRequest', null);
  const [pendingReview, setPendingReview] = useJourneyState<{
    reviewId: string;
    rating: 'AGAIN' | 'GOOD';
    reviewedAt: number;
  } | null>('starter.reviewRequest', null);
  const [answerSaved, setAnswerSaved] = useJourneyState('starter.answerSaved', false);
  const [reviewSaved, setReviewSaved] = useJourneyState('starter.reviewSaved', false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);
  const requested = new URLSearchParams(props.path.split('?')[1]).get('step');
  const step =
    requested === 'complete' && complete
      ? 3
      : requested === 'card' && attempt
        ? 2
        : requested === 'question' || requested === 'card'
          ? 1
          : 0;
  const {
    detail,
    loading,
    error: sourceError,
    retry: retrySource,
  } = useMaterialDetail(step === 0 ? (material ?? null) : null);
  const answered = !!attempt || answerSaved;
  const selection = attempt ? Number(attempt.answer) : selected;
  const correct = question && selection === question.answer;
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
  }, [step]);

  async function action(run: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const go = (to: 'question' | 'card' | 'complete') => props.navigate(`/start?step=${to}`);
  function submitAnswer() {
    if (!question || selected === null) return;
    void action(async () => {
      if (!answered) {
        const request = pendingAnswer ?? { requestId: crypto.randomUUID(), answer: selected };
        setPendingAnswer(request);
        await api('/quiz/answer', { questionId: question.id, ...request });
        setAnswerSaved(true);
        setPendingAnswer(null);
      }
      await props.refresh();
    });
  }
  function review(rating: 'AGAIN' | 'GOOD') {
    if (!card) return;
    void action(async () => {
      if (!reviewSaved && !lesson.reviewed) {
        const request = pendingReview ?? {
          reviewId: crypto.randomUUID(),
          reviewedAt: Date.now(),
          rating,
        };
        setPendingReview(request);
        await api('/cards/review', { cardId: card.id, ...request });
        setReviewSaved(true);
        setPendingReview(null);
      }
      await props.refresh();
      go('complete');
    });
  }
  if (!question || !card || !material)
    return (
      <div className="page-inset">
        <FirstLearningWelcome props={props} />
      </div>
    );
  return (
    <div className={styles.lesson}>
      <header className={styles.lessonHeader}>
        <IconButton label="이전 화면" onClick={() => props.back('/')}>
          <ChevronRight size={22} className="rotate-180" />
        </IconButton>
        <strong>첫 학습 체험</strong>
        <IconButton
          label="체험 나가기, 진행 내용은 저장돼요"
          onClick={() => props.navigate('/', { replace: true })}
        >
          <X size={21} />
        </IconButton>
      </header>
      <div className={styles.lessonBody}>
        <ol className={styles.stepper} aria-label="첫 학습 순서">
          {steps.map((label, index) => (
            <li
              key={label}
              aria-current={step === index ? 'step' : undefined}
              data-done={step > index}
            >
              <span>{step > index ? <Check size={13} /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <div className={styles.heading}>
          <h1 ref={title} tabIndex={-1}>
            {
              [
                '짧게 읽어 볼까요?',
                '읽은 내용을 떠올려 보세요',
                '한 번 더 꺼내면, 오래 남아요',
                '첫 학습을 마쳤어요',
              ][step]
            }
          </h1>
          <p>
            {
              [
                '이 자료에서 문제와 복습 카드가 이어져요.',
                '하나를 고른 뒤 정답을 확인해 주세요.',
                '답을 떠올린 다음 카드를 열어 확인해 보세요.',
                '자료를 읽고, 문제를 풀고, 카드로 기억했어요.',
              ][step]
            }
          </p>
        </div>
        {step === 0 && (
          <article className={styles.reading} aria-label="예제 자료 읽기">
            <span className={styles.sourceLabel}>
              <FileText size={17} />
              예제 자료 · 생명과학
            </span>
            <h2>{material.title}</h2>
            {loading ? (
              <p role="status">자료를 불러오는 중…</p>
            ) : sourceError ? (
              <div>
                <p role="alert">{sourceError}</p>
                <Button variant="secondary" onClick={retrySource}>
                  자료 다시 불러오기
                </Button>
              </div>
            ) : (
              <p>{question.citation}</p>
            )}
            {detail && (
              <details className={styles.disclosure}>
                <summary>
                  자료 전체 읽기
                  <ChevronRight size={17} />
                </summary>
                <p>{detail.content}</p>
              </details>
            )}
          </article>
        )}
        {step === 1 && (
          <>
            <fieldset className={styles.question} disabled={busy || answered || !!pendingAnswer}>
              <legend>{question.prompt}</legend>
              <div className={styles.options}>
                {question.options.map((option, index) => (
                  <label
                    key={option}
                    data-selected={selection === index}
                    data-correct={answered && index === question.answer}
                    data-wrong={answered && selection === index && index !== question.answer}
                  >
                    <input
                      type="radio"
                      name="starter-answer"
                      checked={selection === index}
                      onChange={() => {
                        setSelected(index);
                        setPendingAnswer(null);
                      }}
                    />
                    <span className={styles.optionNumber}>
                      {answered && index === question.answer ? <Check size={16} /> : index + 1}
                    </span>
                    <span>{option}</span>
                    {answered && (index === question.answer || selection === index) && (
                      <small>{index === question.answer ? '정답' : '내 답'}</small>
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
            {answered && (
              <section className={styles.feedback} role="status">
                <strong>
                  {correct
                    ? '맞았어요. 자료에서 근거를 찾았네요'
                    : '괜찮아요. 정답과 근거를 확인해요'}
                </strong>
                <p>{question.explanation}</p>
                <span>자료에서 찾은 근거</span>
                <blockquote>{question.citation}</blockquote>
              </section>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <article className={styles.flashcard}>
              <span className={styles.sourceLabel}>
                <Layers size={17} />
                예제 복습 카드
              </span>
              <h2>{card.front}</h2>
              {revealed || lesson.reviewed ? (
                <div className={styles.cardAnswer}>
                  <span>답</span>
                  {card.back.split('\n').map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              ) : (
                <p className={styles.recallHint}>
                  바로 답을 보기 전에
                  <br />
                  머릿속으로 먼저 말해 보세요
                </p>
              )}
            </article>
            {(revealed || lesson.reviewed) && (
              <p className={styles.footnote}>기억나는 정도를 고르면 다음 복습 시간이 정해져요.</p>
            )}
          </>
        )}
        {step === 3 && (
          <>
            <div className={styles.completionMark}>
              <Check size={36} />
            </div>
            <ul className={styles.completedList}>
              <li>
                <Check size={18} />
                자료의 핵심 읽기
              </li>
              <li>
                <Check size={18} />
                문제 1개와 정답 근거 확인
              </li>
              <li>
                <Check size={18} />
                카드 1장 복습 기록 저장
              </li>
            </ul>
            <div className={styles.nextStep}>
              <Upload size={22} />
              <div>
                <strong>다음은 내 자료로 해볼까요?</strong>
                <p>
                  필기·PDF·사진 한 장에서
                  <br />
                  나에게 필요한 공부를 만들어요.
                </p>
              </div>
            </div>
          </>
        )}
      </div>
      <footer className={styles.lessonFooter}>
        {error && (
          <p className={styles.error} role="alert">
            {error}
            {answerSaved || reviewSaved ? ' 기록은 저장됐어요. 다시 눌러 이어가 주세요.' : ''}
          </p>
        )}
        {step === 0 && (
          <Button
            className="w-full"
            onClick={() => go('question')}
            disabled={loading || !!sourceError}
          >
            문제 1개 풀어보기
            <ArrowRight size={18} />
          </Button>
        )}
        {step === 1 && (
          <Button
            className="w-full"
            disabled={busy || selection === null}
            onClick={
              answered
                ? () =>
                    void action(async () => {
                      await props.refresh();
                      go('card');
                    })
                : submitAnswer
            }
          >
            {busy ? '저장하는 중…' : answered ? '복습 카드로 기억하기' : '정답 확인하기'}
            <ArrowRight size={18} />
          </Button>
        )}
        {step === 2 &&
          (lesson.reviewed || reviewSaved ? (
            <Button className="w-full" disabled={busy} onClick={() => review('GOOD')}>
              학습 마무리하기
              <ArrowRight size={18} />
            </Button>
          ) : !revealed ? (
            <Button className="w-full" onClick={() => setRevealed(true)}>
              답 확인하기
            </Button>
          ) : (
            <div className={styles.ratings}>
              <Button
                variant="secondary"
                disabled={busy || (!!pendingReview && pendingReview.rating !== 'AGAIN')}
                onClick={() => review('AGAIN')}
              >
                {pendingReview?.rating === 'AGAIN' ? '복습 기록 다시 저장' : '아직 헷갈려요'}
              </Button>
              <Button
                disabled={busy || (!!pendingReview && pendingReview.rating !== 'GOOD')}
                onClick={() => review('GOOD')}
              >
                {pendingReview?.rating === 'GOOD' ? '복습 기록 다시 저장' : '기억났어요'}
                <Check size={17} />
              </Button>
            </div>
          ))}
        {step === 3 && (
          <>
            <Button className="w-full" onClick={() => props.navigate('/subjects?upload=1')}>
              내 자료 추가하기
              <Upload size={18} />
            </Button>
            <button
              className={styles.textAction}
              onClick={() => props.navigate('/', { replace: true })}
            >
              홈으로 가기
              <ChevronRight size={16} />
            </button>
          </>
        )}
        {step < 3 && (
          <p className={styles.footnote}>체험을 나가도 저장한 풀이와 복습 기록은 남아 있어요.</p>
        )}
      </footer>
    </div>
  );
}
