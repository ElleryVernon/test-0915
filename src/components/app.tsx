'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { JourneyHistory, mainTab, readJourney } from '@/lib/navigation';
import { JourneyContext, JourneyUserContext, useJourneyState } from './journey';
import { RefreshBoundary, useLiveRefresh } from './refresh';
import { refreshPolicy } from '@/lib/live-refresh';
import dynamic from 'next/dynamic';
import {
  Home,
  BookOpen,
  CalendarDays,
  MessagesSquare,
  UserRound,
  Search,
  Bell,
  ChevronRight,
  ArrowRight,
  Layers,
  FileText,
  NotebookPen,
  ListChecks,
  Clock,
  Heart,
  Check,
  Sparkles,
  Camera,
  LogOut,
  Shield,
  WifiOff,
} from '@/components/icons';
import { openDB } from 'idb';
import { api, retryTransient } from '@/lib/api';
import { installKeyboardInset, isTextField } from '@/lib/keyboard-inset';
import { loginBusyRetryAt } from '@/lib/retry-countdown';
import {
  sessionBoundary,
  beginSession,
  hasEndedSession,
  markSessionEnded,
  SESSION_ENDED_KEY,
} from '@/lib/session-boundary';
import { sessionHint } from '@/lib/session-hint';
import Onboarding from './onboarding';
import AuthEntry from './auth-entry';
import LearningSettings from './learning-settings';
import { isDue } from '@/lib/srs';
import {
  homeAgenda,
  homeWeek,
  homeContinuations,
  homeStart,
  recentMaterials,
  materialHref,
  materialMeta,
} from '@/lib/home';
import { readEssayDrafts, type EssayDraft } from '@/lib/study-drafts';
import { formatMinutes, relativeTime } from './social/helpers';
import { wrongQuestions, wrongEssays } from './study/logic';
import { communityUnreadCount } from '@/lib/community-nudges';
import { cachedCards, clearStudyCache, pendingReviews, syncReviews } from '@/lib/offline';
import { forgetMaterialDetails, rememberSavedMaterial } from '@/lib/materials';
import ActivityNotifications from '@/components/social/activity-notifications';
import { FirstLearningWelcome } from './study/first-learning';
import { firstLearning } from '@/lib/first-learning';
import { studyOnboarding } from '@/lib/study-onboarding';
import { StudyOnboarding } from './study/study-onboarding';
import { GenerationSheet } from './study/shared';
import type { GenerationMode } from './study/logic';
import type { AppData, Material, Role, ScreenProps, ToastAction } from '@/lib/contracts';
import { Button, IconButton, Sheet, EmptyState, ScreenHeader, SectionTitle, ListRow } from './ui';
const StudyScreens = dynamic(() => import('./study'), { loading: () => <ScreenLoading /> });
const SocialScreens = dynamic(() => import('./social'), { loading: () => <ScreenLoading /> });
const shellDB = () =>
  openDB('memoryz-shell', 1, {
    upgrade(db) {
      db.createObjectStore('session');
    },
  });
function ScreenLoading() {
  return (
    <div className="p-5 space-y-5 animate-pulse">
      <div className="h-8 w-40 rounded-lg bg-surface" />
      <div className="h-48 rounded-3xl bg-surface" />
      <div className="h-20 rounded-xl bg-surface" />
    </div>
  );
}
export function HomeScreen(props: ScreenProps) {
  const { data, navigate, toast, refresh } = props;
  const [generation, setGeneration] = useState<GenerationMode | null>(null);
  const [homeNow, setHomeNow] = useState(() => new Date());
  const [drafts, setDrafts] = useState<EssayDraft[]>([]);
  const [thanking, setThanking] = useState(false);
  const [sampling, setSampling] = useState(false);
  useEffect(() => {
    const update = () => {
      setHomeNow(new Date());
      setDrafts(readEssayDrafts(data.profile.id));
    };
    update();
    // jitter: none — a local 60 s clock; 'focus'/'storage' re-read drafts from localStorage; sends no request [site src/components/app.tsx:192]
    const timer = setInterval(update, 60_000);
    window.addEventListener('focus', update);
    window.addEventListener('storage', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
      window.removeEventListener('storage', update);
    };
  }, [data.profile.id]);
  const cards = data.cards.filter((c) => !c.deleted);
  const due = cards.filter((c) => isDue(c, homeNow.getTime()));
  const welcome = firstLearning(data).showWelcome;
  const { phase, usableSources } = studyOnboarding(data);
  const createCard = () =>
    navigate(data.subjects.length ? '/create-card' : '/subjects?create=card');
  const week = homeWeek(data.stats.weekly, homeNow);
  const agenda = homeAgenda(data, homeNow);
  const continuations = homeContinuations(data, drafts);
  const wrong = [...wrongQuestions(data), ...wrongEssays(data)];
  const wrongSubjects = data.subjects
    .map((s) => ({ name: s.name, count: wrong.filter((q) => q.subjectId === s.id).length }))
    .filter((s) => s.count);
  const materials = recentMaterials(data.materials);
  const start = homeStart(data);
  const cheer = [...data.cheers].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )[0];
  const unread = data.notifications.filter((n) => !n.read).length;
  const date = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(homeNow);
  if (welcome || phase !== 'ready')
    return (
      <div className="home-screen">
        <header className="main-header home-header">
          <span className="brand">memoryz.</span>
          <div className="header-actions">
            <IconButton label="검색" onClick={() => navigate('/search')}>
              <Search size={22} />
            </IconButton>
            <IconButton
              label={unread ? `알림, 읽지 않은 알림 ${unread}개` : '알림'}
              onClick={() => navigate('/notifications')}
            >
              <Bell size={22} />
            </IconButton>
          </div>
        </header>
        <div className="page-inset">
          {welcome ? (
            <FirstLearningWelcome props={props} />
          ) : (
            <StudyOnboarding
              props={props}
              onAddSource={() => navigate('/subjects?upload=1')}
              onGenerate={setGeneration}
              onManualCard={createCard}
            />
          )}
        </div>
        {generation && (
          <GenerationSheet
            key={generation}
            open
            onClose={() => setGeneration(null)}
            props={props}
            mode={generation}
          />
        )}
      </div>
    );
  return (
    <div className="home-screen">
      <header className="main-header home-header">
        <button className="brand" onClick={() => navigate('/')}>
          memoryz.
        </button>
        <div className="header-actions">
          <IconButton label="검색" onClick={() => navigate('/search')}>
            <Search size={22} />
          </IconButton>
          <IconButton
            label={unread ? `알림, 읽지 않은 알림 ${unread}개` : '알림'}
            onClick={() => navigate('/notifications')}
          >
            <Bell size={22} />
            {unread > 0 && (
              <span className="home-unread" aria-hidden="true">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </IconButton>
        </div>
      </header>
      <div className="page-inset home-content">
        <div className="home-heading">
          <h1>
            {data.profile.name}님{data.profile.streak > 0 ? `, ${data.profile.streak}일째` : ','}
            <br />
            {data.profile.streak > 1
              ? '꾸준히 이어가고 있어요'
              : data.profile.streak === 1
                ? '오늘의 공부를 이어가요'
                : '오늘의 기억을 쌓아 볼까요?'}
          </h1>
          <div className="home-daily-summary">
            <p>{date}</p>
            <button
              className="home-week"
              onClick={() => navigate('/profile')}
              aria-label={`이번 주 ${week.filter((d) => d.done).length}일 학습, 기록 보기`}
            >
              <span className="home-week-dots" aria-hidden="true">
                {week.map((day) => (
                  <span
                    key={day.date}
                    className={`home-week-dot${day.done ? ' complete' : ''}${day.today ? ' today' : ''}${day.future ? ' future' : ''}`}
                  >
                    {day.done && <Check size={11} />}
                  </span>
                ))}
              </span>
              <span>이번 주 {week.filter((d) => d.done).length}일</span>
            </button>
          </div>
        </div>
        {!cards.length ? (
          <section className="home-review home-review-empty" aria-labelledby="home-card-start">
            <span className="home-review-symbol" aria-hidden="true">
              <Layers size={24} />
            </span>
            <h2 id="home-card-start">
              기억할 내용을
              <br />
              카드로 남겨 보세요
            </h2>
            <p>
              {usableSources && data.aiAvailable
                ? '내 자료에서 중요한 개념을 골라 카드로 만들 수 있어요. 복습할 때도 알려드릴게요.'
                : '기억하고 싶은 개념을 직접 적어 보세요. 만든 카드에 맞춰 복습할 때를 알려드릴게요.'}
            </p>
            <Button
              className="w-full"
              onClick={
                usableSources && data.aiAvailable
                  ? () => navigate('/flashcards?generate=1')
                  : createCard
              }
            >
              {usableSources && data.aiAvailable ? '자료로 첫 카드 만들기' : '첫 카드 직접 만들기'}
              <ArrowRight size={18} />
            </Button>
          </section>
        ) : !due.length ? (
          <section className="home-review home-review-empty" aria-labelledby="home-review-rest">
            <span className="home-review-symbol" aria-hidden="true">
              <Check size={24} />
            </span>
            <h2 id="home-review-rest">
              {data.stats.todayCards ? '오늘 복습을 마쳤어요' : '지금은 복습할 카드가 없어요'}
            </h2>
            <p>
              {data.stats.todayCards
                ? `오늘 카드 ${data.stats.todayCards}장을 복습했어요. `
                : '카드는 보관되어 있어요. '}
              다시 복습할 때가 되면 여기에 알려드릴게요.
            </p>
            <Button variant="secondary" className="w-full" onClick={() => navigate('/flashcards')}>
              카드 살펴보기
              <ChevronRight size={18} />
            </Button>
          </section>
        ) : (
          <section className="home-review" aria-label="오늘 복습할 카드">
            <div className="home-review-head">
              <span>오늘 복습할 카드</span>
              <small>
                {due.length ? `약 ${Math.max(1, Math.ceil(due.length / 2))}분` : '오늘 복습 완료'}
              </small>
            </div>
            <div className="home-review-body">
              <div className="home-review-count">
                <strong>{due.length}</strong>
                <span>장</span>
              </div>
              <p className="home-review-summary">
                오늘 {data.stats.todayCards}장 완료
                {data.stats.yesterdayCards !== undefined && (
                  <>
                    <br />
                    어제 {data.stats.yesterdayCards}장
                  </>
                )}
              </p>
            </div>
            <div
              className="mini-progress"
              role="progressbar"
              aria-label="오늘의 카드 복습"
              aria-valuenow={data.stats.todayCards}
              aria-valuemin={0}
              aria-valuemax={data.stats.todayCards + due.length || 1}
              aria-valuetext={`오늘 ${data.stats.todayCards}장 학습, ${due.length}장 남음`}
            >
              <span
                style={{
                  width: `${(data.stats.todayCards / (data.stats.todayCards + due.length || 1)) * 100}%`,
                }}
              />
            </div>
            <button
              className="review-start primary-surface"
              onClick={() => navigate(due.length ? '/flashcards?review=1' : '/flashcards')}
            >
              {due.length ? '복습 시작' : '복습 카드 살펴보기'}
              <ArrowRight size={18} />
            </button>
          </section>
        )}
        <div className="home-body">
          <button className="home-agenda" onClick={() => navigate('/planner')}>
            <span className="row-icon">
              <CalendarDays size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <small>{agenda.label}</small>
              <strong>
                {agenda.next ? (
                  <>
                    <span className="home-agenda-title">{agenda.next.title}</span>
                    <span className="home-agenda-duration">· {formatMinutes(agenda.duration)}</span>
                  </>
                ) : agenda.total ? (
                  agenda.done === agenda.total ? (
                    '오늘의 일정을 모두 마쳤어요'
                  ) : (
                    `미완료 일정 ${agenda.total - agenda.done}개 확인하기`
                  )
                ) : (
                  '공부 시간 정하기 · 2분'
                )}
              </strong>
            </span>
            {agenda.total > 0 && (
              <span className="home-agenda-progress">
                {agenda.done}/{agenda.total} 완료
              </span>
            )}
            <ChevronRight size={16} className="text-disabled" />
          </button>
          {continuations.length + wrong.length > 0 ? (
            <>
              <SectionTitle title="이어서 하기" />
              {continuations.map((item) => (
                <ListRow
                  key={`${item.kind}-${item.id}`}
                  icon={item.kind === 'quiz' ? <FileText size={22} /> : <NotebookPen size={22} />}
                  title={item.title}
                  description={`${item.description}${item.kind === 'quiz' ? ` · ${relativeTime(item.updatedAt, homeNow.getTime())} 학습` : ''}`}
                  extra={<span className="home-row-progress">{item.progress}</span>}
                  onClick={() => navigate(item.href)}
                />
              ))}
              {wrong.length > 0 && (
                <ListRow
                  icon={<ListChecks size={22} />}
                  title={`틀린 문제 ${wrong.length}개 다시 풀기`}
                  description={wrongSubjects.map((s) => `${s.name} ${s.count}`).join(' · ')}
                  onClick={() => navigate('/wrong-notes')}
                />
              )}
            </>
          ) : start ? (
            <>
              <SectionTitle
                title="오늘 시작하기"
                action={<span className="home-start-source">{start.material.title}</span>}
              />
              {start.actions.map((item) => (
                <ListRow
                  key={item.kind}
                  icon={
                    item.kind === 'quiz' ? (
                      <BookOpen size={22} />
                    ) : item.kind === 'essay' ? (
                      <NotebookPen size={22} />
                    ) : (
                      <Layers size={22} />
                    )
                  }
                  title={item.title}
                  description={item.description}
                  extra={<span className="home-action-chip">{item.chip}</span>}
                  chevron={false}
                  onClick={() => navigate(item.href)}
                />
              ))}
            </>
          ) : !materials.length ? (
            <>
              <SectionTitle title="첫 자료로 시작하기" />
              <div className="home-start-card">
                <p>교과서나 프린트 사진 한 장이면 문제 · 서술형 · 복습 카드가 생겨요</p>
                <div className="home-start-actions">
                  <button
                    className="home-start-ink"
                    onClick={() => navigate('/study?upload=camera')}
                  >
                    <Camera size={18} />
                    사진 찍기
                  </button>
                  <button
                    className="home-start-plain"
                    disabled={sampling}
                    onClick={async () => {
                      if (sampling) return;
                      setSampling(true);
                      try {
                        const sample = await api<{ material: Material }>('/materials/sample', {});
                        // The answer carries the chapter itself, so opening it needs no second request.
                        rememberSavedMaterial(sample.material);
                        await refresh();
                        toast('샘플 자료를 넣었어요. 바로 시작해 보세요');
                      } catch (e) {
                        toast((e as Error).message);
                      } finally {
                        setSampling(false);
                      }
                    }}
                  >
                    {sampling ? '넣는 중' : '샘플 자료로 체험'}
                  </button>
                </div>
              </div>
            </>
          ) : null}
          {cheer && (
            <>
              <SectionTitle
                title={`${cheer.senderName || '가족'}의 응원`}
                action={
                  <time dateTime={cheer.createdAt} className="home-cheer-time">
                    {relativeTime(cheer.createdAt, homeNow.getTime())}
                  </time>
                }
              />
              <div className="cheer-panel">
                <blockquote>{cheer.message}</blockquote>
                <div className="cheer-footer">
                  <span>
                    {cheer.points > 0
                      ? `응원 포인트 ${cheer.points.toLocaleString()}P 함께 도착`
                      : '마음으로 보내온 응원'}
                  </span>
                  <button
                    disabled={cheer.thanked || thanking}
                    onClick={async () => {
                      if (thanking || cheer.thanked) return;
                      setThanking(true);
                      try {
                        await api(`/cheers/${cheer.id}`, { thanked: true }, 'PATCH');
                        await refresh();
                        toast('고마운 마음을 전했어요');
                      } catch (e) {
                        toast((e as Error).message);
                      } finally {
                        setThanking(false);
                      }
                    }}
                  >
                    <Heart size={16} />
                    {cheer.thanked ? '마음 전했어요' : thanking ? '전하는 중' : '고마워요'}
                  </button>
                </div>
              </div>
            </>
          )}
          {materials.length > 0 && (
            <>
              <SectionTitle
                title="최근 자료"
                action={
                  <button onClick={() => navigate('/subjects')}>
                    전체 보기
                    <ChevronRight size={13} className="inline" />
                  </button>
                }
              />
              {materials.map((m) => (
                <ListRow
                  key={m.id}
                  icon={<FileText size={22} />}
                  title={m.title}
                  description={`${materialMeta(data, m)} · ${relativeTime(m.createdAt, homeNow.getTime())}`}
                  onClick={() => navigate(materialHref(m))}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
function SearchScreen({ data, navigate, back }: ScreenProps) {
  const [q, setQ] = useJourneyState('search.query', '');
  const term = q.toLowerCase().trim();
  const materials = data.materials.filter((m) => m.title.toLowerCase().includes(term));
  const cards = data.cards.filter(
    (c) => !c.deleted && (c.front + c.back).toLowerCase().includes(term),
  );
  return (
    <>
      <ScreenHeader title="찾고 싶은 공부" back={() => back('/study')} />
      <div className="page-inset">
        <label className="search-field">
          <Search size={20} className="text-muted" />
          <input
            autoFocus
            placeholder="자료, 개념, 복습 카드 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="학습 검색"
          />
        </label>
        {!term ? (
          data.subjects.length ? (
            <>
              <SectionTitle title="내 과목에서 찾기" />
              <div className="flex gap-2 flex-wrap">
                {data.subjects.map((s) => (
                  <button className="pill" key={s.id} onClick={() => navigate(`/subjects/${s.id}`)}>
                    {s.name}
                    <ChevronRight size={13} />
                  </button>
                ))}
              </div>
            </>
          ) : (
            <EmptyState
              title="아직 만든 과목이 없어요"
              description="과목을 만들고 자료를 올리면 여기에서 바로 검색할 수 있어요."
              action={<Button onClick={() => navigate('/subjects')}>첫 과목 만들기</Button>}
            />
          )
        ) : (
          <>
            <SectionTitle title={`자료 ${materials.length}`} />
            {materials.map((m) => (
              <ListRow
                key={m.id}
                icon={<FileText size={20} />}
                title={m.title}
                onClick={() => navigate(materialHref(m))}
              />
            ))}
            <SectionTitle title={`복습 카드 ${cards.length}`} />
            {cards.slice(0, 30).map((c) => (
              <ListRow
                key={c.id}
                icon={<Layers size={20} />}
                title={c.front}
                onClick={() => navigate(`/flashcards?card=${c.id}&review=1`)}
              />
            ))}
            {!materials.length && !cards.length && (
              <EmptyState
                title="아직 찾지 못했어요"
                description="다른 단어나 짧은 개념으로 검색해 보세요."
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
export default function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [loading, setLoading] = useState(true);
  const [endingSession, setEndingSession] = useState(false);
  const [path, setPath] = useState('/');
  // The key the current screen is mounted under: it follows path, except for a keepScreen
  // navigation that only tidies the address.
  const [screen, setScreen] = useState('/');
  const [message, setMessage] = useState<{ text: string; action?: ToastAction } | null>(null);
  // Publish the visual viewport (keyboard strip, visible height) as CSS variables for every screen.
  useEffect(() => installKeyboardInset(window), []);
  const [offline, setOffline] = useState(false);
  const [roleSheet, setRoleSheet] = useState(false);
  const [error, setError] = useState('');
  const [loginRetryAt, setLoginRetryAt] = useState<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((m: string, action?: ToastAction) => {
    setMessage({ text: m, action });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    // jitter: none — a 4 s toast auto-clear for one person; sends nothing [site src/components/app.tsx:637]
    toastTimer.current = setTimeout(() => setMessage(null), 4000);
  }, []);
  const activeUser = useRef<string | undefined>(undefined);
  activeUser.current = data?.profile.id ?? activeUser.current;
  useEffect(() => {
    let leaving = false;
    const end = () => {
      if (leaving) return;
      leaving = true;
      markSessionEnded();
      // Immediately unmount every private screen/sheet. Never wait for the network to do this.
      setData(null);
      setEndingSession(true);
      setLoading(false);
      setError('');
      setMessage(null);
      setRoleSheet(false);
      forgetMaterialDetails();
      document.cookie = 'memoryz_signed_in=; Max-Age=0; Path=/; SameSite=Lax';
      window.history.replaceState({}, '', '/');
      const cleanup = Promise.allSettled([
        shellDB().then((db) => db.clear('session')),
        activeUser.current ? clearStudyCache(activeUser.current, true) : Promise.resolve(),
        fetch('/api/logout', { method: 'POST', signal: AbortSignal.timeout(2000) }),
      ]);
      // Full replacement drops route snapshots, open dialogs and background task components.
      void Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 2200))]).then(() =>
        window.location.replace('/'),
      );
    };
    const unsubscribe = sessionBoundary.subscribe(end);
    const otherTab = (event: StorageEvent) => {
      if (event.key === SESSION_ENDED_KEY && event.newValue) sessionBoundary.end();
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setData(null);
        window.location.reload();
      }
    };
    window.addEventListener('storage', otherTab);
    window.addEventListener('pageshow', restored);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', otherTab);
      window.removeEventListener('pageshow', restored);
    };
  }, []);
  const journey = useRef<JourneyHistory | null>(null);
  const restoreScroll = useRef(0);
  const navigate = useCallback<ScreenProps['navigate']>(
    (to, options) => journey.current?.navigate(to, options),
    [],
  );
  const back = useCallback((fallback = '/study') => journey.current?.back(fallback), []);
  useEffect(() => {
    if (loading) return;
    const main = document.getElementById('main-content');
    if (!main) return;
    const target = restoreScroll.current;
    let cancelled = false;
    const restore = () => {
      if (cancelled || isTextField(document.activeElement)) return;
      window.scrollTo({ top: target, behavior: 'instant' });
    };
    const observer = new MutationObserver(restore);
    observer.observe(main, { childList: true, subtree: true });
    const frame = requestAnimationFrame(() => {
      restore();
      // Respect a screen's autofocus and an open dialog; never steal the text cursor.
      if (
        !cancelled &&
        !main.querySelector('[autofocus]') &&
        !document.querySelector('[role="dialog"]') &&
        !(document.activeElement instanceof HTMLInputElement) &&
        !(document.activeElement instanceof HTMLTextAreaElement)
      ) {
        main.focus({ preventScroll: true });
      }
    });
    const stop = window.setTimeout(() => observer.disconnect(), 500);
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      cancelAnimationFrame(frame);
      clearTimeout(stop);
      observer.disconnect();
    };
    for (const type of ['touchmove', 'wheel', 'pointerdown', 'keydown'] as const)
      window.addEventListener(type, cancel, { passive: true });
    return () => {
      cancel();
      for (const type of ['touchmove', 'wheel', 'pointerdown', 'keydown'] as const)
        window.removeEventListener(type, cancel);
    };
  }, [screen, loading]);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++refreshSequence.current;
    const revision = sessionBoundary.revision();
    const result = await api<AppData>('/bootstrap', undefined, 'GET', { signal });
    if (
      !sessionBoundary.current(revision) ||
      sequence !== refreshSequence.current ||
      signal?.aborted
    )
      return;
    setData(result);
    setError('');
    const db = await shellDB();
    if (!sessionBoundary.current(revision) || sequence !== refreshSequence.current) return;
    await db.put('session', result, 'data');
    if (!sessionBoundary.current(revision)) return;
    try {
      localStorage.removeItem(SESSION_ENDED_KEY);
    } catch {
      /* optional storage */
    }
  }, []);
  useEffect(() => {
    if (data?.profile.onboardingRequired && path.split('?')[0] !== '/onboarding')
      navigate('/onboarding', { replace: true });
    else if (data && !data.profile.onboardingRequired && path.split('?')[0] === '/onboarding')
      navigate(data.profile.role === 'PARENT' ? '/parent' : '/study', { replace: true });
  }, [data, path, navigate]);
  const refreshRules = refreshPolicy(path);
  useLiveRefresh(refresh, {
    interval: refreshRules.bootstrapInterval,
    enabled: !!data && !loading && refreshRules.bootstrapInterval > 0,
    pauseOnInput: true,
    resource: `${data?.profile.id}:${path.split('?')[0]}`,
  });
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const oauthCompleted = search.get('signedIn') === '1';
    // The sign-in result is read once; a reload must not restart its countdown.
    if (search.has('loginError') || oauthCompleted)
      window.history.replaceState({}, '', window.location.pathname);
    journey.current = new JourneyHistory({
      path: () => window.location.pathname + window.location.search,
      state: () => window.history.state,
      replace: (state, to) => window.history.replaceState(state, '', to),
      push: (state, to) => window.history.pushState(state, '', to),
      go: (delta) => window.history.go(delta),
      scroll: () => window.scrollY,
      render: (entry, keepScreen, restore) => {
        setPath(entry.path);
        if (!keepScreen) {
          restoreScroll.current = restore ? entry.scroll : 0;
          setScreen(entry.id);
        }
      },
    });
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    setPath(journey.current.entry.path);
    setScreen(journey.current.entry.id);
    restoreScroll.current = journey.current.entry.scroll;
    // The OAuth start was refused: a top-level navigation cannot read JSON, so the wait rides in the
    // URL (clamped to what the server can send, so a crafted link cannot lock sign-in).
    if (search.get('loginError') === 'busy')
      setLoginRetryAt(loginBusyRetryAt(search.get('retryAfter')));
    else if (search.has('loginError')) setError('로그인을 완료하지 못했어요. 다시 시작해 주세요.');
    const booting = new AbortController();
    const pop = (event: PopStateEvent) => {
      // This static app renders its own routes. Next must not also restore the
      // page tree captured before a reload: that can suspend the active shell.
      // Only claim our entries; unrelated browser/framework entries stay native.
      if (hasEndedSession() && !sessionHint(document.cookie)) {
        event.stopImmediatePropagation();
        window.location.replace('/');
        return;
      }
      if (readJourney(event.state)) event.stopImmediatePropagation();
      journey.current?.pop();
    };
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('popstate', pop, true);
    // jitter: none — 'offline'/'online' only toggle the offline banner; they send no request [site src/components/app.tsx:663]
    window.addEventListener('offline', update);
    window.addEventListener('online', update);
    const restoreCached = async () => {
      if (hasEndedSession()) return false;
      const revision = sessionBoundary.revision();
      const db = await shellDB();
      const cached: AppData | undefined = await db.get('session', 'data');
      if (cached && sessionBoundary.current(revision) && !hasEndedSession()) {
        activeUser.current = cached.profile.id;
        const cards = await cachedCards(cached.profile.id);
        if (!sessionBoundary.current(revision) || hasEndedSession()) return false;
        setData(cards.length ? { ...cached, cards } : cached);
        setLoading(false);
      }
      return Boolean(cached);
    };
    void (async () => {
      if (oauthCompleted) {
        // The OAuth callback may have replaced another account's cookie. Never
        // paint the previous account's offline shell while fetching this one.
        beginSession();
        forgetMaterialDetails();
        await shellDB()
          .then((db) => db.clear('session'))
          .catch(() => {});
      }
      const cached = oauthCompleted ? false : await restoreCached().catch(() => false);
      // Without the signed-in flag and without a session this device saved, bootstrap can only
      // answer 401: show the sign-in screen without asking.
      if (!cached && !sessionHint(document.cookie)) {
        const publicPath = ['/demo', '/login'].includes(window.location.pathname)
          ? window.location.pathname
          : '/';
        window.history.replaceState({}, '', publicPath);
        setPath(publicPath);
        setLoading(false);
        return;
      }
      try {
        // A deploy or restart at the bell answers 502/503/504 for a moment: bootstrap (idempotent) is
        // retried up to 3 times with full jitter, never before Retry-After, while the cached shell
        // stays on screen. A client timeout is not retried (no server answered at all).
        // jitter: backoff bootstrap retry U[0,4 s), U[0,8 s), U[0,16 s), floored by Retry-After + U[0,1 s) [site src/components/app.tsx:684]
        await retryTransient(refresh, {
          retries: 3,
          baseMs: 2000,
          capMs: 16000,
          signal: booting.signal,
        });
      } catch (e) {
        if (booting.signal.aborted) return;
        if (!navigator.onLine || e instanceof TypeError || (e as Error).name === 'TimeoutError') {
          setOffline(true);
          if (!(await restoreCached().catch(() => false)))
            setError('처음 한 번은 인터넷에 연결해 주세요.');
        } else if ((e as { status?: number }).status === 401) {
          // The session is gone (expired or ended elsewhere): drop what it let us read.
          setData(null);
          forgetMaterialDetails();
          const db = await shellDB();
          await db.clear('session');
          sessionBoundary.end();
        } else setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    if ('serviceWorker' in navigator) {
      // jitter: none — one small no-store GET of /sw.js per page load, spread by people [site src/components/app.tsx:701]
      if (process.env.NODE_ENV === 'production')
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      else {
        navigator.serviceWorker
          .getRegistrations()
          .then((items) =>
            items
              .filter((r) => r.active?.scriptURL.endsWith('/sw.js'))
              .forEach((r) => r.unregister()),
          );
        caches
          .keys()
          .then((keys) =>
            keys.filter((k) => k.startsWith('memoryz-shell-')).forEach((k) => caches.delete(k)),
          );
      }
    }
    return () => {
      booting.abort();
      window.removeEventListener('popstate', pop, true);
      window.history.scrollRestoration = previousScrollRestoration;
      window.removeEventListener('offline', update);
      window.removeEventListener('online', update);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [refresh]);
  async function login(role: Role) {
    if (data) {
      await syncReviews(data.profile.id, (item) => api('/cards/review', item));
      await clearStudyCache(data.profile.id);
    }
    await api('/session', { role });
    beginSession();
    // The session now belongs to someone else: the bodies read under the previous one go with it.
    forgetMaterialDetails();
    await refresh();
    navigate(role === 'PARENT' ? '/parent' : '/');
    setRoleSheet(false);
  }
  async function logout() {
    try {
      if (data) {
        const pending = await pendingReviews(data.profile.id);
        if (pending.length && !navigator.onLine) {
          toast('저장하지 못한 복습 기록이 있어요. 인터넷 연결 후 로그아웃해 주세요.');
          return;
        }
        await syncReviews(data.profile.id, (item) => api('/cards/review', item));
        await clearStudyCache(data.profile.id);
      }
      await api('/logout', {});
      const db = await shellDB();
      await db.clear('session');
      // Signing out keeps this page: without this the material bodies stay in memory for the next person.
      forgetMaterialDetails();
      sessionBoundary.end();
    } catch (e) {
      toast((e as Error).message);
    }
  }
  if (endingSession)
    return (
      <div className="app-shell loading-screen" role="status">
        로그인 화면으로 이동하고 있어요.
      </div>
    );
  if (loading)
    return (
      <div className="app-shell loading-screen">
        <span className="brand">memoryz.</span>
        <div className="loading-bar" />
        <span className="text-xs text-muted">오늘의 기억을 준비하고 있어요</span>
      </div>
    );
  if (!data || ['/demo', '/login'].includes(path.split('?')[0]))
    return (
      <div className="app-shell">
        {error && (
          <div className="error-banner !rounded-none" role="alert">
            {error}
            <button onClick={() => window.location.reload()} className="ml-3 underline">
              다시 시도
            </button>
          </div>
        )}
        <AuthEntry
          demoPage={path.split('?')[0] === '/demo'}
          onLogin={login}
          retryAt={loginRetryAt}
        />
      </div>
    );
  if (data.profile.onboardingRequired)
    return (
      <div className="app-shell">
        <Onboarding
          data={data}
          refresh={refresh}
          navigate={navigate}
          back={back}
          toast={toast}
          path={path}
          onExit={logout}
        />
      </div>
    );
  const base = path.split('?')[0];
  const isParent = data.profile.role === 'PARENT';
  const protectedStudent =
    /^\/(start|study|subjects|quiz|essay|flashcards|wrong-notes|create-card|completed-subjects|community|boards|planner)/.test(
      base,
    );
  const protectedParent = /^\/(parent|parent-boards)(\/|$)/.test(base);
  const denied =
    (isParent && protectedStudent) ||
    (!isParent && protectedParent) ||
    (base === '/admin' && data.profile.role !== 'ADMIN');
  const props: ScreenProps = { data, refresh, navigate, back, toast, path };
  const study =
    /^\/(start|study|subjects|quiz|essay|flashcards|wrong-notes|create-card|completed-subjects)/.test(
      base,
    );
  const social =
    /^\/(planner|community|boards|parent-boards|profile|parent|cheer|points|settings|admin|messages|followers|following)/.test(
      base,
    );
  const focusMode =
    [
      '/quiz',
      '/essay',
      '/flashcards',
      '/create-card',
      '/points',
      '/completed-subjects',
      '/onboarding',
      '/start',
    ].includes(base) ||
    (['/community', '/parent-boards', '/messages'].includes(base) &&
      !!new URLSearchParams(path.split('?')[1]).get('peer') &&
      (base === '/messages' ||
        new URLSearchParams(path.split('?')[1]).get('space') === 'messages'));
  const communityUnread = communityUnreadCount(data.notifications);
  const nav = isParent
    ? [
        { label: '자녀 현황', href: '/parent', icon: Home },
        { label: '커뮤니티', href: '/parent-boards', icon: MessagesSquare },
        { label: '응원', href: '/cheer', icon: Heart },
        { label: '마이', href: '/profile', icon: UserRound },
      ]
    : [
        { label: '홈', href: '/', icon: Home },
        { label: '학습', href: '/study', icon: BookOpen },
        { label: '시간표', href: '/planner', icon: CalendarDays },
        { label: '커뮤니티', href: '/community', icon: MessagesSquare },
        { label: '마이', href: '/profile', icon: UserRound },
      ];
  const navUnread = (href: string) =>
    href === '/community' || href === '/parent-boards' ? communityUnread : 0;
  return (
    <JourneyContext.Provider value={journey.current}>
      <JourneyUserContext.Provider value={data.profile.id}>
        <div className="app-shell">
          {offline && (
            <div className="offline-banner">
              <WifiOff size={13} className="inline mr-1" />
              오프라인이에요 · 저장한 카드로 복습할 수 있어요
            </div>
          )}
          <RefreshBoundary
            fallback={refresh}
            enabled={refreshRules.pull && !denied}
            scope={`${data.profile.id}:${screen}`}
          >
            <main
              className={`app-main${focusMode ? ' app-main-focus' : ''}`}
              id="main-content"
              tabIndex={-1}
            >
              {base === '/settings/learning' ? (
                <LearningSettings key={screen} {...props} />
              ) : base === '/onboarding' ? (
                <ScreenLoading />
              ) : denied ? (
                <>
                  <ScreenHeader
                    title="접근할 수 없는 공간"
                    back={() => back(isParent ? '/parent' : '/')}
                  />
                  <EmptyState
                    title="이 계정에서 볼 수 없는 화면이에요"
                    description="학생과 학부모의 학습 공간을 안전하게 구분하고 있어요."
                    action={
                      <Button onClick={() => navigate(isParent ? '/parent' : '/')}>
                        내 홈으로
                      </Button>
                    }
                  />
                </>
              ) : base === '/search' ? (
                <SearchScreen key={screen} {...props} />
              ) : base === '/notifications' ? (
                <ActivityNotifications key={screen} {...props} />
              ) : study ? (
                <StudyScreens key={screen} {...props} />
              ) : social ? (
                <SocialScreens key={screen} {...props} />
              ) : base === '/' ? (
                isParent ? (
                  <SocialScreens {...props} path="/parent" />
                ) : (
                  <HomeScreen {...props} />
                )
              ) : (
                <EmptyState
                  title="페이지를 찾을 수 없어요"
                  description="주소가 바뀌었거나 없는 화면이에요."
                  action={<Button onClick={() => navigate('/')}>홈으로</Button>}
                />
              )}
              {base === '/profile' && (
                <div className="page-inset pt-5">
                  {!isParent && (
                    <Button
                      className="w-full mb-3"
                      variant="secondary"
                      onClick={() => navigate('/settings/learning')}
                    >
                      나에게 맞는 복습 · {data.profile.srsMode === 'FSRS' ? '맞춤' : '고정 간격'}
                    </Button>
                  )}
                  <Button className="w-full" variant="secondary" onClick={() => setRoleSheet(true)}>
                    {data.demo ? '체험 계정 관리' : '계정 관리'}
                  </Button>
                </div>
              )}
              {!focusMode && data.demo && (
                <div className="demo-note">
                  <Shield size={12} />
                  샘플 자료로 사용하는 체험 공간
                </div>
              )}
            </main>
          </RefreshBoundary>
          {!focusMode && (
            <nav className="bottom-nav" aria-label="메인 메뉴">
              {nav.map((n) => {
                const active = mainTab(path, isParent) === n.href;
                const unread = navUnread(n.href);
                return (
                  <button
                    key={n.href}
                    className={`nav-item ${active ? 'active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    aria-label={
                      unread ? `${n.label}, 읽지 않은 알림 ${unread}개` : undefined
                    }
                    onClick={() => navigate(n.href, { restore: true })}
                  >
                    <n.icon />
                    {unread > 0 && <span className="nav-dot" aria-hidden="true" />}
                    <span>{n.label}</span>
                  </button>
                );
              })}
            </nav>
          )}
          {message && (
            <div className="toast" role="status">
              <span>{message.text}</span>
              {message.action && (
                <button
                  className="toast-action"
                  onClick={() => {
                    const action = message.action;
                    setMessage(null);
                    action?.onClick();
                  }}
                >
                  {message.action.label}
                </button>
              )}
            </div>
          )}
          <Sheet open={roleSheet} onClose={() => setRoleSheet(false)} title="계정 관리">
            <p className="text-sm text-muted mb-5">
              {data.profile.name} · {isParent ? '학부모' : '학생'}
              {data.demo ? ' 체험 계정' : ''}
            </p>
            <div className="stack">
              {data.demo && (
                <Button
                  onClick={() => {
                    setRoleSheet(false);
                    navigate('/login');
                  }}
                >
                  내 계정으로 로그인하기
                </Button>
              )}
              {data.demo && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    login(isParent ? 'STUDENT' : 'PARENT').catch((e) => toast(e.message))
                  }
                >
                  {isParent ? '학생' : '학부모'} 화면으로 전환
                </Button>
              )}
              <Button variant="ghost" onClick={logout}>
                <LogOut size={17} />
                로그아웃
              </Button>
            </div>
          </Sheet>
        </div>
      </JourneyUserContext.Provider>
    </JourneyContext.Provider>
  );
}
