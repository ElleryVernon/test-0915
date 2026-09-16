'use client';
import { CommunityAsk } from '../social/community-ask';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CloudOff,
  MoreHorizontal,
  Plus,
  Sparkles,
  WifiOff,
} from '@/components/icons';
import type { Bucket, Card, ScreenProps } from '@/lib/contracts';
import { Button, EmptyState, IconButton, Sheet } from '@/components/ui';
import { api } from '@/lib/api';
import {
  cacheCards,
  cachedCards,
  cancelSync,
  pendingReviews,
  queueReview,
  syncNow,
  syncReviews,
  syncSoon,
} from '@/lib/offline';
import { BUCKETS, intervalLabel, localReview, reviewLabel, TYPES } from './logic';
import { previewIntervals } from '@/lib/srs';
import { BusyText, ErrorNote, errorMessage, GenerationSheet, params, useAction } from './shared';
import { useJourneyLayer, useJourneyState } from '../journey';
import { StudyHeader } from './study-header';
import { DiagramCardContent } from './explanation-card';
import {
  bucketDistribution,
  libraryGroups,
  nextReviewDay,
  recordReviewSession,
  reviewMinutes,
  reviewOrdinal,
  sessionDuration,
  sessionResult,
  splitBack,
  streakThroughToday,
  whenLabel,
  type Rating,
  type SessionRating,
} from './insights';

const recallLabel: Record<string, string> = {
  AGAIN: '못 떠올림',
  HARD: '어렵게',
  GOOD: '떠올림',
  EASY: '바로',
};
const bucketLabel = (bucket: Bucket) => BUCKETS.find((b) => b.id === bucket)?.label ?? '';
const reviewable = (card: Card) => !card.deleted && !(card.bucket === 'MASTERED' && !card.fsrs);
const cardTypeLabel = (card: Card) => (card.diagram ? '다이어그램' : TYPES[card.type][0]);

export function Flashcards(props: ScreenProps) {
  const query = params(props.path);
  // The library needs a recognizable question; masked review fronts stay source-label free.
  const questionPrompts = new Map(
    props.data.questions.map((question) => [question.id, question.prompt]),
  );
  const libraryTitle = (card: Card) =>
    card.diagram && card.sourceQuestionId
      ? questionPrompts.get(card.sourceQuestionId) || card.front
      : card.front;
  const [cards, setCards] = useState(props.data.cards);
  const [subject, setSubject] = useJourneyState('cards.subject', query.get('subject') || '');
  const [bucket, setBucket] = useJourneyState<Bucket | null>('cards.bucket', null);
  const [dueOnly, setDueOnly] = useJourneyState('cards.dueOnly', false);
  const [trash, setTrash] = useState(query.get('trash') === '1');
  // Home's "복습 카드 만들기" opens the sheet on the material it names, once: the intent is removed
  // from the address so back navigation or a reload does not open it again.
  const [generation, setGeneration] = useState(query.get('generate') === '1');
  const [generateMaterial] = useState(() => query.get('material') || undefined);
  useEffect(() => {
    if (query.get('generate') !== '1') return;
    const rest = new URLSearchParams(query);
    rest.delete('generate');
    rest.delete('material');
    const tail = rest.toString();
    // keepScreen: a plain navigate would remount this screen (screens are keyed by their path) and
    // the new instance, reading the tidied address, would close the sheet it was asked to open.
    props.navigate(`/flashcards${tail ? `?${tail}` : ''}`, { replace: true, keepScreen: true });
    // Only the first render carries the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [stored, setStored] = useState(false);
  const [cacheError, setCacheError] = useState('');
  const [syncError, setSyncError] = useState('');
  const initial = props.data.cards.filter(
    (c) => !c.deleted && (!subject || c.subjectId === subject),
  );
  // A session walks the cards in the order the library lists them: the longest overdue first.
  const [reviewIds, setReviewIds] = useJourneyState<string[] | null>('cards.reviewIds', () =>
    query.get('card')
      ? initial.filter((c) => c.id === query.get('card')).map((c) => c.id)
      : query.get('review') === '1'
        ? libraryGroups(initial).today.map((c) => c.id)
        : null,
  );
  const [ratings, setRatings] = useJourneyState<SessionRating[]>('cards.ratings', []);
  const [startedAt, setStartedAt] = useJourneyState('cards.startedAt', () => Date.now());
  const [finishedAt, setFinishedAt] = useJourneyState<number | null>('cards.finishedAt', null);
  const [recorded, setRecorded] = useJourneyState('cards.recorded', false);
  const [index, setIndex] = useJourneyState('cards.index', 0);
  const [flipped, setFlipped] = useJourneyState('cards.flipped', false);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const [libraryMenu, setLibraryMenu] = useState(false);
  const [subjectSheet, setSubjectSheet] = useState(false);
  const [bucketSheet, setBucketSheet] = useState(false);
  const [preview, setPreview] = useState<Card | null>(null);
  const [edit, setEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [ratingBusy, setRatingBusy] = useState(false);
  const ratingLock = useRef(false);
  const action = useAction();
  const userId = props.data.profile.id;
  const mode = props.data.profile.srsMode ?? 'FIXED';
  const retention = props.data.profile.desiredRetention ?? 0.9;
  // drain sends the queued reviews and rethrows, so the scheduler can decide whether to retry.
  const drain = useCallback(async () => {
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
  }, [userId, props.refresh]);
  const onSyncError = useCallback((error: unknown) => setSyncError(errorMessage(error)), []);
  // A rating or a tap on 동기화 is a person's own pace: it drains at once; a transient failure then
  // retries by the scheduler's backoff.
  // jitter: backoff only after a failure; a person's rating sends at once [site src/components/study/cards.tsx:208]
  const sync = useCallback(async () => {
    if (!navigator.onLine) return;
    await syncNow(userId, drain, { onError: onSyncError });
  }, [userId, drain, onSyncError]);
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
    // Opening the screen drains at once (people already spread their navigation); a classroom's
    // Wi-Fi coming back starts the drain somewhere in the next 10 s instead of on every device at once.
    // jitter: window 'online' → U[0,10 s), then the scheduler's backoff; 'offline' or unmount cancels [site src/components/study/cards.tsx:147]
    const back = () => {
      setOnline(true);
      syncSoon(userId, drain, { windowMs: 10_000, onError: onSyncError });
    };
    const gone = () => {
      setOnline(false);
      cancelSync(userId);
    };
    setOnline(navigator.onLine);
    if (navigator.onLine) void sync();
    // jitter: window — these listeners run back/gone above: 'online' drains within U[0,10 s), 'offline' cancels
    window.addEventListener('online', back);
    window.addEventListener('offline', gone);
    return () => {
      window.removeEventListener('online', back);
      window.removeEventListener('offline', gone);
      cancelSync(userId);
    };
  }, [userId, drain, onSyncError, sync]);
  const current = reviewIds
    ? cards.find((c) => c.id === reviewIds[index] && !c.deleted)
    : undefined;
  const finished = !!reviewIds && !current;
  useEffect(() => {
    if (!finished || recorded || !ratings.length) return;
    setRecorded(true);
    setFinishedAt(Date.now());
    recordReviewSession(userId);
  }, [finished, ratings.length, userId, recorded, setRecorded, setFinishedAt]);
  useEffect(() => {
    if (reviewIds) {
      setReviewIds(reviewIds);
      setStartedAt(startedAt);
    }
    // Freeze the initial due list before ratings change which cards are due.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function start(ids: string[]) {
    setReviewIds(ids);
    setIndex(0);
    setFlipped(false);
    setExpanded(false);
    setRatings([]);
    setStartedAt(Date.now());
    setFinishedAt(null);
    setPreview(null);
    setRecorded(false);
  }
  function exitReview() {
    setReviewIds(null);
    setRatings([]);
  }
  const directReview = !!query.get('card') || query.get('review') === '1';
  const closeReview = useJourneyLayer(reviewIds !== null && !directReview, exitReview);
  const leaveReview = () => (directReview ? props.back('/flashcards') : closeReview());
  function advance() {
    setIndex((i) => i + 1);
    setFlipped(false);
    setExpanded(false);
    setMenu(false);
    setDeleting(false);
    setEdit(false);
  }
  async function rate(rating: Rating) {
    if (!current || !flipped || ratingLock.current) return;
    ratingLock.current = true;
    setRatingBusy(true);
    action.setError('');
    const before = current;
    const reviewedAt = Date.now();
    const reviewId = crypto.randomUUID();
    // The server count arrives with the next bootstrap; count this review locally meanwhile.
    const counted = (card: Card): Card =>
      before.reviewCount === undefined ? card : { ...card, reviewCount: before.reviewCount + 1 };
    try {
      const optimistic = counted(localReview(before, rating, reviewedAt, mode, retention));
      setCards((currentCards) => currentCards.map((c) => (c.id === before.id ? optimistic : c)));
      if (stored) {
        const saved = counted(
          await queueReview(userId, before, rating, reviewId, mode, retention, reviewedAt),
        );
        setCards((currentCards) => currentCards.map((c) => (c.id === before.id ? saved : c)));
        setPending((await pendingReviews(userId)).length);
        void sync();
      } else {
        if (!navigator.onLine)
          throw new Error('오프라인 저장이 꺼져 있어요. 인터넷 연결 후 다시 평가해 주세요.');
        const saved = counted(
          await api<Card>('/cards/review', {
            cardId: before.id,
            rating,
            reviewId,
            reviewedAt,
            mode,
            retention,
          }),
        );
        setCards((currentCards) => currentCards.map((c) => (c.id === before.id ? saved : c)));
        void props.refresh();
      }
      setRatings((list) => [...list, { cardId: before.id, rating }]);
      advance();
    } catch (error) {
      setCards((currentCards) => currentCards.map((c) => (c.id === before.id ? before : c)));
      action.setError(errorMessage(error));
    } finally {
      ratingLock.current = false;
      setRatingBusy(false);
    }
  }
  const statusText = !online
    ? '오프라인'
    : pending
      ? `${pending}개 저장 대기`
      : stored
        ? '오프라인 저장됨'
        : '온라인 학습';
  const banner =
    !online || pending > 0 || cacheError ? (
      <div className="recall-banner" role="status">
        {!online ? <WifiOff size={16} /> : <CloudOff size={16} />}
        <span>
          {!online
            ? stored
              ? '오프라인이에요 · 복습 기록은 기기에 저장돼요'
              : '오프라인이에요 · 연결되면 다시 복습해 주세요'
            : pending
              ? `복습 기록 ${pending}개가 동기화를 기다려요`
              : cacheError}
        </span>
        {online && pending > 0 && <button onClick={() => void sync()}>동기화</button>}
      </div>
    ) : null;

  if (finished) {
    const now = new Date();
    const result = sessionResult(ratings);
    const reviewedIds = new Set(ratings.map((rating) => rating.cardId));
    const next = nextReviewDay(
      cards.filter((card) => reviewedIds.has(card.id)),
      now,
    );
    const streak = streakThroughToday(props.data, result.total, now);
    const again = result.againIds
      .map((id) => cards.find((c) => c.id === id))
      .filter((c): c is Card => !!c && !c.deleted);
    return (
      <>
        <StudyHeader close={leaveReview} />
        <div className="page-inset recall-done">
          {result.total ? (
            <>
              <span className="recall-done-check">
                <Check size={24} />
              </span>
              <h1>
                {result.total}장 복습 끝
                <br />
                {next
                  ? `다음 복습은 ${next.when} ${next.count}장이에요`
                  : '예정된 다음 복습이 없어요'}
              </h1>
              <p className="recall-done-note">이번에 복습한 카드의 다음 일정이에요.</p>
              <p className="recall-done-meta">
                {[
                  sessionDuration((finishedAt ?? now.getTime()) - startedAt),
                  streak > 0 ? `오늘까지 ${streak}일 연속` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <div className="recall-result">
                <div
                  className="recall-dist"
                  role="img"
                  aria-label={`이번 평가 ${result.counts.map((c) => `${recallLabel[c.id]} ${c.count}장`).join(', ')}`}
                >
                  {result.counts
                    .filter((c) => c.count)
                    .map((c) => (
                      <span key={c.id} data-bucket={c.id} style={{ flexGrow: c.count }} />
                    ))}
                </div>
                <div className="recall-result-counts" aria-hidden="true">
                  {result.counts.map((c) => (
                    <span key={c.id}>
                      <strong>{c.count}</strong>
                      <small>
                        <i data-bucket={c.id} />
                        {recallLabel[c.id]}
                      </small>
                    </span>
                  ))}
                </div>
              </div>
              {again.length > 0 && (
                <div className="recall-again">
                  {again.map((card) => (
                    <div key={card.id} className="recall-list-row">
                      <span className="recall-row-type" title={cardTypeLabel(card)}>
                        {card.diagram ? '도식' : TYPES[card.type][0]}
                      </span>
                      <span className="recall-row-front">{libraryTitle(card)}</span>
                      <span className="recall-row-when">못 떠올림 · {whenLabel(card).text}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <EmptyState
              title="이번에 평가한 카드가 없어요"
              description="건너뛴 카드는 다음 복습 때 다시 나와요."
            />
          )}
          {pending > 0 && (
            <p className="recall-done-note">
              복습 기록 {pending}개가 기기에 저장되었어요. 연결되면 반영돼요.
            </p>
          )}
          <ErrorNote error={syncError} />
        </div>
        <div className="study-fixed-cta">
          {again.length > 0 ? (
            <>
              <Button className="w-full" onClick={() => start(again.map((c) => c.id))}>
                못 떠올린 {again.length}장 한 번 더 보기
              </Button>
              <button
                className="recall-done-back"
                onClick={() => props.navigate('/study', { replace: true })}
              >
                학습으로 돌아가기
              </button>
            </>
          ) : (
            <Button className="w-full" onClick={() => props.navigate('/study', { replace: true })}>
              학습으로 돌아가기
            </Button>
          )}
        </div>
      </>
    );
  }

  if (reviewIds && current) {
    const subjectName = props.data.subjects.find((s) => s.id === current.subjectId)?.name;
    const { answer, explanation, collapsed } = splitBack(current.back);
    const ordinal = reviewOrdinal(current);
    const previewNow = Date.now();
    const intervals = previewIntervals(current, mode, retention, previewNow);
    const meta = (
      <div className="recall-card-meta">
        <span className="recall-type-chip">
          {current.diagram
            ? '다이어그램 · 가림 카드'
            : `${TYPES[current.type][0]} · ${TYPES[current.type][1]}`}
        </span>
        <span>
          {bucketLabel(current.bucket)} 상자{ordinal ? ` · ${ordinal}` : ''}
        </span>
      </div>
    );
    const image = (masked: boolean) =>
      current.type === 'BLIND' && current.image ? (
        <div className="recall-image">
          <img src={current.image} alt={current.front} draggable={false} />
          {masked &&
            current.masks?.map((mask, i) => (
              <span
                key={i}
                className="recall-mask"
                style={{
                  left: `${mask.x}%`,
                  top: `${mask.y}%`,
                  width: `${mask.width}%`,
                  height: `${mask.height}%`,
                }}
              >
                ?
              </span>
            ))}
        </div>
      ) : null;
    return (
      <div className="recall-screen">
        <StudyHeader
          close={leaveReview}
          title={`${index + 1} / ${reviewIds.length}`}
          subtitle={[`약 ${reviewMinutes(reviewIds.length - index)}분 남음`, subjectName]
            .filter(Boolean)
            .join(' · ')}
          action={
            <IconButton label="카드 메뉴" onClick={() => setMenu(true)}>
              <MoreHorizontal size={24} />
            </IconButton>
          }
        />
        <div className="page-inset recall-body">
          <div
            className="recall-progress"
            role="progressbar"
            aria-label="복습 진행률"
            aria-valuemin={0}
            aria-valuemax={reviewIds.length}
            aria-valuenow={index}
          >
            <span style={{ width: `${(index / reviewIds.length) * 100}%` }} />
          </div>
          {banner}
          {flipped ? (
            <section className="recall-card is-back" aria-label="정답">
              {meta}
              <p className="recall-back-question">{current.front}</p>
              <DiagramCardContent card={current} revealed />
              {image(false)}
              <hr />
              <span className="recall-answer-label">정답</span>
              <h2 className="recall-answer">{answer}</h2>
              {explanation &&
                (collapsed && !expanded ? (
                  <button className="recall-more" onClick={() => setExpanded(true)}>
                    설명 더 보기
                    <ChevronDown size={14} />
                  </button>
                ) : (
                  <p className="recall-explanation">{explanation}</p>
                ))}
            </section>
          ) : current.diagram ? (
            <section className="recall-card" aria-label="가림 카드 앞면">
              {meta}
              <DiagramCardContent card={current} />
              <p className="recall-hint">가려진 부분을 떠올린 뒤 정답을 확인해 보세요</p>
            </section>
          ) : (
            <button className="recall-card" onClick={() => setFlipped(true)} aria-label="정답 보기">
              {meta}
              {image(true)}
              {current.type !== 'BLIND' && <h2 className="recall-question">{current.front}</h2>}
              <p className="recall-hint">먼저 답을 떠올린 뒤 확인해 보세요</p>
            </button>
          )}
          <div className="recall-actions">
            <ErrorNote error={action.error} />
            {flipped ? (
              <>
                <p className="recall-rate-prompt">정답을 보기 전에 얼마나 떠올렸나요?</p>
                <div className="recall-ratings">
                  {BUCKETS.slice(0, 4).map((b) => (
                    <button
                      key={b.id}
                      disabled={ratingBusy}
                      onClick={() => void rate(b.id as Rating)}
                      className="recall-rating"
                    >
                      <span>{recallLabel[b.id]}</span>
                      <small>
                        {intervalLabel(intervals.find((i) => i.rating === b.id)!.due, previewNow)}{' '}
                        뒤
                      </small>
                    </button>
                  ))}
                </div>
                <p className="recall-mastery-hint">
                  누르면 평가가 저장되고 다음 카드로 넘어가요. 버튼의 시간은 다음 복습 예정이에요.
                </p>
                <CommunityAsk {...props} card={current} kind="CARD" />
              </>
            ) : (
              <Button className="w-full" onClick={() => setFlipped(true)}>
                정답 보기
              </Button>
            )}
            {syncError && pending > 0 && (
              <button className="recall-sync-retry" onClick={() => void sync()}>
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
              {cardTypeLabel(current)} 카드 · {reviewLabel(current)}
            </p>
            {!current.diagram && (
              <Button variant="secondary" className="w-full" onClick={() => setEdit(true)}>
                카드 내용 수정
              </Button>
            )}
            {current.diagram && (
              <p className="text-sm text-muted">
                이 카드의 다이어그램은 문제의 자료 원문을 기준으로 만들었어요.
              </p>
            )}
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
  }

  const nowMs = Date.now();
  const scoped = cards.filter((c) => !subject || c.subjectId === subject);
  const live = scoped.filter((c) => !c.deleted);
  const deleted = scoped.filter((c) => c.deleted);
  const dist = bucketDistribution(live);
  const groups = libraryGroups(live, nowMs);
  const due = groups.today;
  const lists = bucket
    ? [
        {
          key: 'bucket',
          label: `${bucketLabel(bucket)} 상자`,
          cards: [...groups.today, ...groups.later].filter((c) => c.bucket === bucket),
        },
      ]
    : [
        { key: 'today', label: '오늘', cards: groups.today },
        ...(dueOnly ? [] : [{ key: 'later', label: '이후', cards: groups.later }]),
      ];
  const subjectName = props.data.subjects.find((s) => s.id === subject)?.name;
  const cardRow = (card: Card) => {
    const when = whenLabel(card, nowMs);
    return (
      <button key={card.id} className="recall-list-row" onClick={() => setPreview(card)}>
        <span className="recall-row-type" title={cardTypeLabel(card)}>
          {card.diagram ? '도식' : TYPES[card.type][0]}
        </span>
        <span className="recall-row-front">{libraryTitle(card)}</span>
        <span className={`recall-row-when${when.strong ? ' is-strong' : ''}`}>{when.text}</span>
      </button>
    );
  };
  return (
    <>
      <StudyHeader
        title={trash ? '카드 휴지통' : '복습 카드'}
        back={() => (trash ? setTrash(false) : props.back('/study'))}
        action={
          !trash && (
            <IconButton label="카드 보관함 메뉴" onClick={() => setLibraryMenu(true)}>
              <MoreHorizontal size={24} />
            </IconButton>
          )
        }
      />
      <div className={`page-inset recall-library${trash ? ' is-trash' : ''}`}>
        {banner}
        <ErrorNote
          error={
            syncError && pending > 0
              ? `${pending}개 기록은 기기에 저장되어 있어요. ${syncError}`
              : ''
          }
        />
        <div className="recall-filters">
          <button
            className="study-chip"
            aria-haspopup="dialog"
            onClick={() => setSubjectSheet(true)}
          >
            {subjectName ?? '모든 과목'}
            <ChevronDown size={12} />
          </button>
          {!trash && (
            <button
              className="study-chip"
              aria-pressed={dueOnly}
              onClick={() => {
                setDueOnly((v) => !v);
                setBucket(null);
              }}
            >
              오늘 복습만
            </button>
          )}
        </div>
        {trash ? (
          <div className="recall-groups">
            {deleted.map((card) => (
              <div key={card.id} className="recall-list-row">
                <span className="recall-row-type" title={cardTypeLabel(card)}>
                  {card.diagram ? '도식' : TYPES[card.type][0]}
                </span>
                <span className="recall-row-front">{libraryTitle(card)}</span>
                <button
                  className="recall-restore"
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
              </div>
            ))}
            {!deleted.length && (
              <EmptyState title="휴지통이 비어 있어요" description="삭제한 카드가 여기 보관돼요." />
            )}
          </div>
        ) : live.length ? (
          <>
            <section className="recall-summary" aria-label="오늘 복습할 카드">
              <div className="recall-summary-head">
                <div className="recall-summary-copy">
                  <span>오늘 복습할 카드</span>
                  <p>
                    <strong>{due.length}</strong>
                    <b>장</b>
                    {due.length > 0 && <small>약 {reviewMinutes(due.length)}분</small>}
                  </p>
                </div>
                {due.length > 0 ? (
                  <Button
                    className="recall-summary-start"
                    onClick={() => start(due.map((c) => c.id))}
                  >
                    복습 시작
                    <ArrowRight size={16} />
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    className="recall-summary-start"
                    disabled={!live.some(reviewable)}
                    onClick={() => start(groups.later.filter(reviewable).map((c) => c.id))}
                  >
                    미리 복습
                  </Button>
                )}
              </div>
              <div
                className="recall-dist"
                role="img"
                aria-label={`상자별 카드 ${dist.map((d) => `${d.label} ${d.count}장`).join(', ')}`}
              >
                {dist
                  .filter((d) => d.count)
                  .map((d) => (
                    <span key={d.id} data-bucket={d.id} style={{ flexGrow: d.count }} />
                  ))}
              </div>
              <div className="recall-legend" aria-hidden="true">
                {dist.map((d) => (
                  <span key={d.id}>
                    <i data-bucket={d.id} />
                    {d.label} {d.count}
                  </span>
                ))}
              </div>
            </section>
            <div className="recall-groups">
              {lists.map((list, i) => (
                <div key={list.key} className="recall-group">
                  <div className="recall-group-head">
                    <h2>
                      {list.label} <span>{list.cards.length}</span>
                    </h2>
                    {i === 0 && (
                      <button
                        className="study-chip is-compact"
                        aria-haspopup="dialog"
                        onClick={() => setBucketSheet(true)}
                      >
                        {bucket ? '상자 바꾸기' : '상자별 보기'}
                        <ChevronDown size={12} />
                      </button>
                    )}
                  </div>
                  {list.cards.map(cardRow)}
                  {!list.cards.length && (
                    <p className="recall-group-empty">
                      {list.key === 'today'
                        ? '오늘 복습할 카드를 모두 마쳤어요.'
                        : list.key === 'later'
                          ? '예정된 카드가 없어요.'
                          : '이 상자는 비어 있어요.'}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <EmptyState
            title="첫 복습 카드를 만들어 볼까요?"
            description="직접 만들거나 올린 자료로 카드를 만들 수 있어요."
          />
        )}
        <ErrorNote error={action.error} />
      </div>
      {!trash && (
        <div className="recall-library-actions">
          <Button
            variant="secondary"
            onClick={() => props.navigate(`/create-card${subject ? `?subject=${subject}` : ''}`)}
          >
            <Plus size={16} />
            직접 만들기
          </Button>
          <Button variant="secondary" onClick={() => setGeneration(true)}>
            <Sparkles size={16} className="recall-sparkle" />
            자료로 만들기
          </Button>
        </div>
      )}
      <Sheet open={libraryMenu} onClose={() => setLibraryMenu(false)} title="카드 보관함">
        <div className="study-options">
          <button
            onClick={() => {
              setLibraryMenu(false);
              setTrash(true);
              setBucket(null);
              setDueOnly(false);
            }}
          >
            <span>휴지통</span>
            <small>{deleted.length}장</small>
            <ChevronRight size={18} className="text-disabled" />
          </button>
          <button onClick={() => props.navigate('/settings/learning')}>
            <span>복습 방식</span>
            <small>{mode === 'FSRS' ? '기억에 맞춘 간격' : '정해진 간격'}</small>
            <ChevronRight size={18} className="text-disabled" />
          </button>
          <button disabled={!online} onClick={() => void sync()}>
            <span>기록 동기화</span>
            <small>{statusText}</small>
          </button>
        </div>
      </Sheet>
      <Sheet open={subjectSheet} onClose={() => setSubjectSheet(false)} title="과목 선택">
        <div className="study-options">
          {[{ id: '', name: '모든 과목' }, ...props.data.subjects].map((s) => (
            <button
              key={s.id || 'all'}
              aria-pressed={subject === s.id}
              onClick={() => {
                setSubject(s.id);
                setSubjectSheet(false);
              }}
            >
              <span>{s.name}</span>
              {subject === s.id && <Check size={20} />}
            </button>
          ))}
        </div>
      </Sheet>
      <Sheet open={bucketSheet} onClose={() => setBucketSheet(false)} title="상자별 보기">
        <div className="study-options">
          {[{ id: null, label: '모든 상자', count: live.length }, ...dist].map((d) => (
            <button
              key={d.id ?? 'all'}
              aria-pressed={bucket === d.id}
              onClick={() => {
                setBucket(d.id);
                setDueOnly(false);
                setBucketSheet(false);
              }}
            >
              <span>{d.label}</span>
              <small>{d.count}장</small>
              {bucket === d.id && <Check size={20} />}
            </button>
          ))}
        </div>
      </Sheet>
      <Sheet
        open={!!preview && !edit}
        onClose={() => {
          setPreview(null);
          setDeleting(false);
        }}
        title={preview ? `${cardTypeLabel(preview)} 카드` : '카드'}
      >
        {preview && (
          <div className="space-y-2">
            <p className="text-[13px] text-muted">
              {bucketLabel(preview.bucket)} 상자 · {reviewLabel(preview)}
            </p>
            {preview.diagram ? (
              <DiagramCardContent card={preview} />
            ) : (
              <p className="recall-preview-front">{preview.front}</p>
            )}
            <Button className="w-full" onClick={() => start([preview.id])}>
              이 카드 복습하기
            </Button>
            {!preview.diagram && (
              <Button variant="secondary" className="w-full" onClick={() => setEdit(true)}>
                카드 내용 수정
              </Button>
            )}
            {!deleting ? (
              <Button variant="ghost" className="w-full" onClick={() => setDeleting(true)}>
                휴지통으로 옮기기
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
                      await api(`/cards/${preview.id}`, { deleted: true }, 'PATCH');
                      await props.refresh();
                      setPreview(null);
                      setDeleting(false);
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
        )}
      </Sheet>
      {edit && preview && (
        <EditCard
          props={props}
          card={preview}
          onClose={() => {
            setEdit(false);
            setPreview(null);
          }}
        />
      )}
      <GenerationSheet
        open={generation}
        onClose={() => setGeneration(false)}
        props={props}
        mode="cards"
        initialMaterial={generateMaterial}
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
