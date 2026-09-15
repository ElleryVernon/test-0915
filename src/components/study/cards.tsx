'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronRight,
  CloudCheck,
  CloudOff,
  Layers,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Trash2,
  WifiOff,
} from '@/components/icons';
import type { Bucket, Card, ScreenProps } from '@/lib/contracts';
import { Button, EmptyState, IconButton, ScreenHeader, Sheet } from '@/components/ui';
import { api } from '@/lib/api';
import { cacheCards, cachedCards, pendingReviews, queueReview, syncReviews } from '@/lib/offline';
import { BUCKETS, dueCards, intervalLabel, localReview, reviewLabel, TYPES } from './logic';
import { previewIntervals } from '@/lib/srs';
import {
  BusyText,
  Chip,
  ErrorNote,
  errorMessage,
  GenerationSheet,
  params,
  Progress,
  SubjectSelect,
  useAction,
} from './shared';

export function Flashcards(props: ScreenProps) {
  const query = params(props.path);
  const [cards, setCards] = useState(props.data.cards);
  const [subject, setSubject] = useState(query.get('subject') || '');
  const [bucket, setBucket] = useState<Bucket | null>(null);
  const [dueOnly, setDueOnly] = useState(false);
  const [trash, setTrash] = useState(query.get('trash') === '1');
  const [generation, setGeneration] = useState(false);
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [stored, setStored] = useState(false);
  const [cacheError, setCacheError] = useState('');
  const [syncError, setSyncError] = useState('');
  const initial = props.data.cards.filter(
    (c) => !c.deleted && (!subject || c.subjectId === subject),
  );
  const [reviewIds, setReviewIds] = useState<string[] | null>(() =>
    query.get('card')
      ? initial.filter((c) => c.id === query.get('card')).map((c) => c.id)
      : query.get('review') === '1'
        ? dueCards(initial).map((c) => c.id)
        : null,
  );
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [menu, setMenu] = useState(false);
  const [edit, setEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [ratingBusy, setRatingBusy] = useState(false);
  const ratingLock = useRef(false);
  const action = useAction();
  const userId = props.data.profile.id;
  const mode = props.data.profile.srsMode ?? 'FIXED';
  const retention = props.data.profile.desiredRetention ?? 0.9;
  const sync = useCallback(async () => {
    if (!navigator.onLine) return;
    try {
      const count = await syncReviews(userId, (item) =>
        api<Card>('/cards/review', {
          cardId: item.cardId,
          rating: item.rating,
          reviewId: item.reviewId,
          reviewedAt: item.reviewedAt,
          mode: item.mode,
          retention: item.retention,
        }),
      );
      setPending((await pendingReviews(userId)).length);
      setSyncError('');
      if (count) {
        setCards(await cachedCards(userId));
        await props.refresh();
      }
    } catch (error) {
      setSyncError(errorMessage(error));
    }
  }, [userId, props.refresh]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await cacheCards(userId, props.data.cards);
        const local = await cachedCards(userId);
        const queue = await pendingReviews(userId);
        if (!cancelled) {
          setCards(local);
          setPending(queue.length);
          setStored(true);
          setCacheError('');
        }
      } catch {
        if (!cancelled) {
          setStored(false);
          setCacheError(
            '이 브라우저에서는 오프라인 저장을 사용할 수 없어요. 연결된 상태에서 복습해 주세요.',
          );
          setCards(props.data.cards);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, props.data.cards]);
  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void sync();
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [sync]);
  const filtered = cards.filter(
    (c) => c.deleted === trash && (!subject || c.subjectId === subject),
  );
  const live = filtered.filter((c) => !c.deleted);
  const due = dueCards(live);
  const shown = filtered.filter(
    (c) => (!bucket || c.bucket === bucket) && (!dueOnly || due.some((d) => d.id === c.id)),
  );
  const current = reviewIds
    ? cards.find((c) => c.id === reviewIds[index] && !c.deleted)
    : undefined;
  function start(ids: string[]) {
    setReviewIds(ids);
    setIndex(0);
    setFlipped(false);
    setReviewed([]);
  }
  function advance() {
    setIndex((i) => i + 1);
    setFlipped(false);
    setMenu(false);
    setDeleting(false);
    setEdit(false);
  }
  async function rate(rating: Exclude<Bucket, 'MASTERED'>) {
    if (!current || !flipped || ratingLock.current) return;
    ratingLock.current = true;
    setRatingBusy(true);
    action.setError('');
    const before = current;
    const reviewedAt = Date.now();
    const reviewId = crypto.randomUUID();
    try {
      const optimistic = localReview(before, rating, reviewedAt, mode, retention);
      setCards((currentCards) => currentCards.map((c) => (c.id === before.id ? optimistic : c)));
      if (stored) {
        const saved = await queueReview(
          userId,
          before,
          rating,
          reviewId,
          mode,
          retention,
          reviewedAt,
        );
        setCards((currentCards) => currentCards.map((c) => (c.id === before.id ? saved : c)));
        setPending((await pendingReviews(userId)).length);
        void sync();
      } else {
        if (!navigator.onLine)
          throw new Error('오프라인 저장이 꺼져 있어요. 인터넷 연결 후 다시 평가해 주세요.');
        const saved = await api<Card>('/cards/review', {
          cardId: before.id,
          rating,
          reviewId,
          reviewedAt,
          mode,
          retention,
        });
        setCards((currentCards) => currentCards.map((c) => (c.id === before.id ? saved : c)));
        void props.refresh();
      }
      setReviewed((ids) => [...ids, before.id]);
      advance();
    } catch (error) {
      setCards((currentCards) => currentCards.map((c) => (c.id === before.id ? before : c)));
      action.setError(errorMessage(error));
    } finally {
      ratingLock.current = false;
      setRatingBusy(false);
    }
  }
  const backParagraphs = current?.back.trim().split(/\n\s*\n/) ?? [];
  const backTitle = backParagraphs[0] ?? '';
  const backExplanation = backParagraphs.slice(1).join('\n\n');
  const previewNow = Date.now();
  const intervals = current ? previewIntervals(current, mode, retention, previewNow) : [];
  const status = (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted">
      {!online ? (
        <WifiOff size={14} />
      ) : pending ? (
        <CloudOff size={14} />
      ) : (
        <CloudCheck size={14} />
      )}{' '}
      {!online
        ? '오프라인'
        : pending
          ? `${pending}개 저장 대기`
          : stored
            ? '오프라인 저장됨'
            : '온라인 학습'}
    </span>
  );
  if (reviewIds && !current)
    return (
      <>
        <ScreenHeader title="복습 완료" back={() => setReviewIds(null)} />
        <div className="page-inset py-6">
          <div className="primary-surface relative flex min-h-64 flex-col justify-between overflow-hidden rounded-[28px] p-7">
            <span className="relative">
              <Check size={32} />
            </span>
            <div className="relative">
              <p className="text-sm font-semibold on-primary">작은 반복이 오래 남아요</p>
              <h1 className="mt-2 text-[31px] font-extrabold leading-tight tracking-[-.035em]">
                {reviewed.length}장 더<br />
                기억에 가까워졌어요
              </h1>
            </div>
          </div>
          <p className="my-5 text-[14px] leading-relaxed text-muted">
            {pending
              ? `복습 기록 ${pending}개가 기기에 저장되었어요. 연결되면 복습 기록이 반영돼요.`
              : reviewed.length
                ? '평가한 카드의 다음 복습 날짜를 정해 두었어요.'
                : '이 범위에서 복습할 카드가 없어요. 다른 상자를 확인해 보세요.'}
          </p>
          <ErrorNote error={syncError} />
          <Button
            className="mt-5 w-full"
            onClick={() => {
              setReviewIds(null);
              setReviewed([]);
            }}
          >
            카드 보관함으로
          </Button>
          <Button variant="ghost" className="mt-2 w-full" onClick={() => props.navigate('/study')}>
            오늘의 학습으로
          </Button>
        </div>
      </>
    );
  if (reviewIds && current)
    return (
      <div className="min-h-dvh bg-surface">
        <ScreenHeader
          title={`${index + 1} / ${reviewIds.length}`}
          back={() => setReviewIds(null)}
          action={
            <IconButton label="카드 메뉴" onClick={() => setMenu(true)}>
              <MoreHorizontal size={23} />
            </IconButton>
          }
        />
        <div className="page-inset pb-6">
          <div className="mb-3 flex items-center justify-between">
            {status}
            <span className="text-[11px] text-muted">
              {props.data.subjects.find((s) => s.id === current.subjectId)?.name}
            </span>
          </div>
          <Progress value={index} total={reviewIds.length} />
          <button
            aria-label={flipped ? '질문 다시 보기' : '정답 보기'}
            onClick={() => setFlipped((v) => !v)}
            className={`relative mt-5 flex min-h-[min(440px,52dvh)] w-full flex-col overflow-hidden rounded-[28px] p-6 text-left transition-transform duration-200 active:scale-[.99] ${flipped ? 'primary-surface' : 'bg-white text-ink'}`}
          >
            <div className="relative flex w-full items-center justify-between gap-3 text-[12px] font-semibold">
              <span>{TYPES[current.type][0]} 카드</span>
              <span className={flipped ? 'on-primary' : 'text-muted'}>
                {BUCKETS.find((b) => b.id === current.bucket)?.label} 상자
              </span>
            </div>
            {flipped && (
              <p className="relative mt-6 text-[14px] leading-relaxed on-primary">
                {current.front}
              </p>
            )}
            {current.type === 'BLIND' && current.image ? (
              <div className="relative my-6 w-full overflow-hidden rounded-2xl">
                <img
                  src={current.image}
                  alt={current.front}
                  draggable={false}
                  className="block w-full"
                />
                {!flipped &&
                  current.masks?.map((mask, i) => (
                    <span
                      key={i}
                      className="absolute flex items-center justify-center rounded bg-brand text-white"
                      style={{
                        left: `${mask.x}%`,
                        top: `${mask.y}%`,
                        width: `${mask.width}%`,
                        height: `${mask.height}%`,
                      }}
                    >
                      <span className="text-xs font-bold">?</span>
                    </span>
                  ))}
              </div>
            ) : null}
            {(flipped || current.type !== 'BLIND') && (
              <div className="relative my-auto w-full py-7">
                <h2
                  className={`whitespace-pre-wrap break-words tracking-[-.035em] ${flipped && backTitle.length > 140 ? 'text-[20px] font-semibold leading-[1.65]' : flipped && backTitle.length > 70 ? 'text-[24px] font-bold leading-[1.45]' : 'text-[28px] font-extrabold leading-[1.35]'}`}
                >
                  {flipped ? backTitle : current.front}
                </h2>
                {flipped && backExplanation && (
                  <p className="mt-5 whitespace-pre-wrap break-words text-[17px] font-medium leading-[1.7] on-primary">
                    {backExplanation}
                  </p>
                )}
              </div>
            )}
            <p
              className={`relative mt-auto pt-5 text-[13px] font-semibold ${flipped ? 'on-primary' : 'text-muted'}`}
            >
              {flipped ? '얼마나 쉽게 떠올렸나요?' : '답이 떠오르면 눌러서 확인'}
            </p>
          </button>
          <div className="mt-5">
            <ErrorNote error={action.error} />
            {flipped ? (
              <div className="recall-ratings">
                {BUCKETS.slice(0, 4).map((b) => (
                  <button
                    key={b.id}
                    disabled={ratingBusy}
                    onClick={() => void rate(b.id as Exclude<Bucket, 'MASTERED'>)}
                    className="recall-rating"
                  >
                    <span className="block text-[14px] font-bold">{b.label}</span>
                    <span className="mt-1 block text-[11px] text-muted">
                      {intervalLabel(intervals.find((i) => i.rating === b.id)!.due, previewNow)} 뒤
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <Button className="w-full" onClick={() => setFlipped(true)}>
                정답 보기
              </Button>
            )}
            <p className="mt-3 text-center text-[11px] leading-relaxed text-muted">
              {mode === 'FSRS'
                ? '쉬움 2번이면 암기완료로 옮겨져요. 오래 기억하도록 이후 복습도 이어가요.'
                : '쉬움을 2번 연속 고르면 암기완료 상자로 옮겨져요.'}
            </p>
            {syncError && pending > 0 && (
              <button
                className="mt-3 min-h-11 w-full text-xs font-semibold"
                onClick={() => void sync()}
              >
                저장된 기록 {pending}개 동기화 다시 시도
              </button>
            )}
          </div>
        </div>
        <Sheet
          open={menu && !edit}
          onClose={() => {
            setMenu(false);
            setDeleting(false);
          }}
          title="이 카드"
        >
          <div className="space-y-2">
            <p className="mb-4 text-sm text-muted">
              {TYPES[current.type][0]} 카드 · {reviewLabel(current)}
            </p>
            <Button variant="secondary" className="w-full" onClick={() => setEdit(true)}>
              카드 내용 수정
            </Button>
            <Button variant="secondary" className="w-full" onClick={advance}>
              이번 복습에서는 건너뛰기
            </Button>
            {!deleting ? (
              <Button variant="ghost" className="w-full" onClick={() => setDeleting(true)}>
                카드 삭제
              </Button>
            ) : (
              <div className="rounded-2xl bg-surface p-4">
                <p className="mb-3 text-sm leading-relaxed">
                  휴지통으로 옮길까요? 카드 보관함에서 다시 복원할 수 있어요.
                </p>
                <Button
                  className="w-full"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await api(`/cards/${current.id}`, { deleted: true }, 'PATCH');
                      await props.refresh();
                      advance();
                      props.toast('카드를 휴지통으로 옮겼어요');
                    })
                  }
                >
                  휴지통으로 옮기기
                </Button>
              </div>
            )}
            <ErrorNote error={action.error} />
          </div>
        </Sheet>
        {edit && <EditCard props={props} card={current} onClose={() => setEdit(false)} />}
      </div>
    );
  return (
    <>
      <ScreenHeader
        title={trash ? '카드 휴지통' : '복습 카드'}
        back={() => props.navigate('/study')}
        action={
          <IconButton
            label={trash ? '카드 보관함' : '카드 휴지통'}
            onClick={() => {
              setTrash((v) => !v);
              setBucket(null);
              setDueOnly(false);
            }}
          >
            {trash ? <Layers size={21} /> : <Trash2 size={20} />}
          </IconButton>
        }
      />
      <div className={`page-inset pb-8 ${!trash ? 'recall-library' : ''}`}>
        <div className="mb-4 flex items-center justify-between">
          <p className="text-[13px] text-muted">
            {trash ? '삭제한 카드를 다시 꺼낼 수 있어요' : '짧게 떠올리고, 오래 기억해요'}
          </p>
          {status}
        </div>
        <SubjectSelect data={props.data} value={subject} onChange={setSubject} />
        {!trash && (
          <button
            onClick={() => props.navigate('/settings/learning')}
            className="mt-2 flex min-h-11 w-full items-center justify-between gap-2 text-left text-[12px] text-muted"
          >
            <span>복습 방식 · {mode === 'FSRS' ? '기억에 맞춘 간격' : '정해진 간격'}</span>
            <span className="inline-flex items-center gap-1 font-semibold">
              설정
              <ChevronRight size={14} />
            </span>
          </button>
        )}
        {!trash && (
          <>
            <div className="recall-buckets">
              {BUCKETS.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setBucket(bucket === b.id ? null : b.id)}
                  aria-pressed={bucket === b.id}
                  className="recall-bucket"
                >
                  <strong className="block text-[22px] leading-tight">
                    {live.filter((c) => c.bucket === b.id).length}
                  </strong>
                  <span className="mt-1 block text-[11px] font-semibold whitespace-nowrap">
                    {b.label}
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-5 flex items-center justify-between">
              <h2 className="text-[17px] font-bold">
                {bucket ? BUCKETS.find((b) => b.id === bucket)?.label : '모든 카드'}{' '}
                <span className="ml-1 text-disabled">{shown.length}</span>
              </h2>
              <label className="flex min-h-11 items-center gap-2 text-[12px] font-semibold text-muted">
                <input
                  type="checkbox"
                  checked={dueOnly}
                  onChange={(e) => setDueOnly(e.target.checked)}
                  className="h-4 w-4 accent-ink"
                />
                오늘 복습만
              </label>
            </div>
          </>
        )}
        <ErrorNote error={cacheError} />
        {syncError && pending > 0 && (
          <div className="mt-3 space-y-2">
            <ErrorNote error={`${pending}개 기록은 기기에 저장되어 있어요. ${syncError}`} />
            <Button variant="secondary" className="w-full" onClick={() => void sync()}>
              동기화 다시 시도
            </Button>
          </div>
        )}
        <div className="mt-2">
          {shown.map((card) => (
            <div key={card.id} className="recall-list-row">
              <span className="shrink-0 rounded-lg bg-surface px-2 py-1.5 text-[11px] font-semibold text-muted">
                {TYPES[card.type][0]}
              </span>
              <button
                onClick={() => start([card.id])}
                disabled={trash}
                className="min-w-0 flex-1 text-left"
              >
                <span className="line-clamp-2 text-[14px] font-semibold leading-relaxed">
                  {card.front}
                </span>
                {!trash && (
                  <span className="mt-1 block text-[11px] text-muted">{reviewLabel(card)}</span>
                )}
              </button>
              {trash ? (
                <button
                  className="min-h-11 px-2 text-xs font-semibold"
                  onClick={() =>
                    action.run(async () => {
                      await api(`/cards/${card.id}`, { deleted: false }, 'PATCH');
                      await props.refresh();
                      props.toast('카드를 복원했어요');
                    })
                  }
                >
                  복원
                </button>
              ) : (
                <ChevronRight size={16} className="shrink-0 text-disabled" />
              )}
            </div>
          ))}
        </div>
        {!shown.length && (
          <EmptyState
            title={
              trash
                ? '휴지통이 비어 있어요'
                : dueOnly
                  ? '오늘 복습을 모두 마쳤어요'
                  : bucket
                    ? '이 상자는 아직 비어 있어요'
                    : '첫 복습 카드를 만들어 볼까요?'
            }
            description={
              trash
                ? '삭제한 카드가 여기 보관돼요.'
                : dueOnly
                  ? '내일 다시 꺼내 볼 카드들이 기다리고 있어요.'
                  : '직접 만들거나 내 자료로 AI 카드를 만들 수 있어요.'
            }
          />
        )}
        <ErrorNote error={action.error} />
        {!trash && (
          <div className="recall-library-actions">
            {shown.length > 0 && (
              <Button
                className="w-full"
                onClick={() =>
                  start((bucket || dueOnly ? shown : due.length ? due : shown).map((c) => c.id))
                }
              >
                {bucket
                  ? `${BUCKETS.find((b) => b.id === bucket)?.label} ${shown.length}장`
                  : due.length && !dueOnly
                    ? `오늘 복습 ${due.length}장`
                    : `${shown.length}장`}{' '}
                복습하기
                <ArrowRight size={18} />
              </Button>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  props.navigate(`/create-card${subject ? `?subject=${subject}` : ''}`)
                }
              >
                <Plus size={17} />
                직접 만들기
              </Button>
              <Button variant="secondary" onClick={() => setGeneration(true)}>
                AI 카드 만들기
              </Button>
            </div>
          </div>
        )}
      </div>
      <GenerationSheet
        open={generation}
        onClose={() => setGeneration(false)}
        props={props}
        mode="cards"
      />
    </>
  );
}
function EditCard({
  card,
  props,
  onClose,
}: {
  card: Card;
  props: ScreenProps;
  onClose: () => void;
}) {
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  const action = useAction();
  return (
    <Sheet open onClose={onClose} title="카드 내용 수정">
      <div className="space-y-4">
        <label className="block text-sm font-semibold">
          앞면
          <textarea
            className="field mt-2 min-h-28"
            value={front}
            onChange={(e) => setFront(e.target.value)}
            maxLength={2000}
          />
        </label>
        <label className="block text-sm font-semibold">
          뒷면
          <textarea
            className="field mt-2 min-h-36"
            value={back}
            onChange={(e) => setBack(e.target.value)}
            maxLength={4000}
          />
        </label>
        <ErrorNote error={action.error} />
        <Button
          className="w-full"
          disabled={!front.trim() || !back.trim() || action.busy}
          onClick={() =>
            action.run(async () => {
              await api(`/cards/${card.id}`, { front: front.trim(), back: back.trim() }, 'PATCH');
              await props.refresh();
              onClose();
              props.toast('카드를 수정했어요');
            })
          }
        >
          {action.busy ? <BusyText>저장 중</BusyText> : '변경 사항 저장'}
        </Button>
      </div>
    </Sheet>
  );
}
