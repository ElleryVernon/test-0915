'use client';
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
import { cacheCards, cachedCards, pendingReviews, queueReview, syncReviews } from '@/lib/offline';
import { BUCKETS, intervalLabel, localReview, reviewLabel, TYPES } from './logic';
import { previewIntervals } from '@/lib/srs';
import { BusyText, ErrorNote, errorMessage, GenerationSheet, params, useAction } from './shared';
import { StudyHeader } from './study-header';
import {
  bucketDistribution,
  completedReviewSessions,
  libraryGroups,
  MASTERY_HINT_SESSIONS,
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

const bucketLabel = (bucket: Bucket) => BUCKETS.find((b) => b.id === bucket)?.label ?? '';
const reviewable = (card: Card) => !card.deleted && !(card.bucket === 'MASTERED' && !card.fsrs);

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
  // A session walks the cards in the order the library lists them: the longest overdue first.
  const [reviewIds, setReviewIds] = useState<string[] | null>(() =>
    query.get('card')
      ? initial.filter((c) => c.id === query.get('card')).map((c) => c.id)
      : query.get('review') === '1'
        ? libraryGroups(initial).today.map((c) => c.id)
        : null,
  );
  const [ratings, setRatings] = useState<SessionRating[]>([]);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [hintSessions, setHintSessions] = useState(() =>
    completedReviewSessions(props.data.profile.id),
  );
  const recorded = useRef(false);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
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
  const current = reviewIds
    ? cards.find((c) => c.id === reviewIds[index] && !c.deleted)
    : undefined;
  const finished = !!reviewIds && !current;
  useEffect(() => {
    if (!finished || recorded.current || !ratings.length) return;
    recorded.current = true;
    setFinishedAt(Date.now());
    recordReviewSession(userId);
  }, [finished, ratings.length, userId]);
  function start(ids: string[]) {
    setReviewIds(ids);
    setIndex(0);
    setFlipped(false);
    setExpanded(false);
    setRatings([]);
    setStartedAt(Date.now());
    setFinishedAt(null);
    setHintSessions(completedReviewSessions(userId));
    setPreview(null);
    recorded.current = false;
  }
  function exitReview() {
    setReviewIds(null);
    setRatings([]);
  }
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
    const next = nextReviewDay(cards, now);
    const streak = streakThroughToday(props.data, result.total, now);
    const again = result.againIds
      .map((id) => cards.find((c) => c.id === id))
      .filter((c): c is Card => !!c && !c.deleted);
    return (
      <>
        <StudyHeader close={exitReview} />
        <div className="page-inset recall-done">
          {result.total ? (
            <>
              <span className="recall-done-check">
                <Check size={24} />
              </span>
              <h1>
                {result.total}장 복습 끝
                <br />
                {next ? `다음 복습은 ${next.when} ${next.count}장이에요` : '예정된 다음 복습이 없어요'}
              </h1>
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
                  aria-label={`이번 평가 ${result.counts.map((c) => `${c.label} ${c.count}장`).join(', ')}`}
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
                        {c.label}
                      </small>
                    </span>
                  ))}
                </div>
              </div>
              {again.length > 0 && (
                <div className="recall-again">
                  {again.map((card) => (
                    <div key={card.id} className="recall-list-row">
                      <span className="recall-row-type">{TYPES[card.type][0]}</span>
                      <span className="recall-row-front">{card.front}</span>
                      <span className="recall-row-when">다시 · {whenLabel(card).text}</span>
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
                &quot;다시&quot; {again.length}장 한 번 더 보기
              </Button>
              <button className="recall-done-back" onClick={() => props.navigate('/study')}>
                학습으로 돌아가기
              </button>
            </>
          ) : (
            <Button className="w-full" onClick={() => props.navigate('/study')}>
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
          {TYPES[current.type][0]} · {TYPES[current.type][1]}
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
          close={exitReview}
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
          ) : (
            <button className="recall-card" onClick={() => setFlipped(true)} aria-label="정답 보기">
              {meta}
              {image(true)}
              {current.type !== 'BLIND' && <h2 className="recall-question">{current.front}</h2>}
              <p className="recall-hint">답이 떠오르면 카드를 탭하세요</p>
            </button>
          )}
          <div className="recall-actions">
            <ErrorNote error={action.error} />
            {flipped ? (
              <>
                <p className="recall-rate-prompt">얼마나 쉽게 떠올렸나요?</p>
                <div className="recall-ratings">
                  {BUCKETS.slice(0, 4).map((b) => (
                    <button
                      key={b.id}
                      disabled={ratingBusy}
                      onClick={() => void rate(b.id as Rating)}
                      className="recall-rating"
                    >
                      <span>{b.label}</span>
                      <small>
                        {intervalLabel(intervals.find((i) => i.rating === b.id)!.due, previewNow)} 뒤
                      </small>
                    </button>
                  ))}
                </div>
                {hintSessions < MASTERY_HINT_SESSIONS && (
                  <p className="recall-mastery-hint">
                    {mode === 'FSRS'
                      ? '쉬움 2번이면 암기완료로 옮겨져요. 오래 기억하도록 이후 복습도 이어가요.'
                      : '쉬움을 2번 연속 고르면 암기완료 상자로 옮겨져요.'}
                  </p>
                )}
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
        <span className="recall-row-type">{TYPES[card.type][0]}</span>
        <span className="recall-row-front">{card.front}</span>
        <span className={`recall-row-when${when.strong ? ' is-strong' : ''}`}>{when.text}</span>
      </button>
    );
  };
  return (
    <>
      <StudyHeader
        title={trash ? '카드 휴지통' : '복습 카드'}
        back={() => (trash ? setTrash(false) : props.navigate('/study'))}
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
        <ErrorNote error={syncError && pending > 0 ? `${pending}개 기록은 기기에 저장되어 있어요. ${syncError}` : ''} />
        <div className="recall-filters">
          <button className="study-chip" aria-haspopup="dialog" onClick={() => setSubjectSheet(true)}>
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
                <span className="recall-row-type">{TYPES[card.type][0]}</span>
                <span className="recall-row-front">{card.front}</span>
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
                  <Button className="recall-summary-start" onClick={() => start(due.map((c) => c.id))}>
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
        title={preview ? `${TYPES[preview.type][0]} 카드` : '카드'}
      >
        {preview && (
          <div className="space-y-2">
            <p className="text-[13px] text-muted">
              {bucketLabel(preview.bucket)} 상자 · {reviewLabel(preview)}
            </p>
            <p className="recall-preview-front">{preview.front}</p>
            <Button className="w-full" onClick={() => start([preview.id])}>
              이 카드 복습하기
            </Button>
            <Button variant="secondary" className="w-full" onClick={() => setEdit(true)}>
              카드 내용 수정
            </Button>
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
