'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { loginBusyRetryAt, retryAtOf, useRetryCountdown, waitingLabel } from '@/lib/retry-countdown';
import { sessionHint } from '@/lib/session-hint';
import Onboarding from './onboarding';
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
import { cachedCards, clearStudyCache, pendingReviews, syncReviews } from '@/lib/offline';
import type { AppData, Role, ScreenProps } from '@/lib/contracts';
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
// A refused sign-in (the demo login's 429, or an OAuth start the server sent back with
// loginError=busy&retryAfter=<s>) keeps every sign-in button waiting for the drawn time, so a class
// told "try again" together comes back spread over the refusal's window.
// jitter: cooldown on sign-in refusals: rest of the window + U[0,15 s) from the server, + U[0,1 s) here [site src/components/app.tsx:679]
function Login({
  onLogin,
  retryAt: initialRetryAt = null,
}: {
  onLogin: (role: Role) => Promise<void>;
  retryAt?: number | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryAt, setRetryAt] = useState<number | null>(initialRetryAt);
  useEffect(() => {
    if (initialRetryAt) setRetryAt(initialRetryAt);
  }, [initialRetryAt]);
  const retryIn = useRetryCountdown(retryAt);
  const waiting = retryIn > 0;
  const [demo, setDemo] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);
  const [loginRole, setLoginRole] = useState<Role>('STUDENT');
  useEffect(() => {
    api<{ demo: boolean; providers: string[] }>('/config')
      .then((c) => {
        setDemo(c.demo);
        setProviders(c.providers);
      })
      .catch(() => setError('서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.'));
  }, []);
  async function start(role: Role) {
    setBusy(true);
    setError('');
    try {
      await onLogin(role);
    } catch (e) {
      setError((e as Error).message);
      setRetryAt(retryAtOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-screen primary-surface">
      <div className="login-brand flex items-center justify-between">
        <span className="text-sm font-medium">기억이 남는 공부</span>
        <Sparkles size={19} />
      </div>
      <div className="login-story">
        <div className="brand">memoryz.</div>
        <h1>
          배운 순간을,
          <br />
          오래 남는 기억으로.
        </h1>
        <p>
          내 자료 하나로 문제, 서술형,
          <br />
          복습 카드까지 이어지는 공부
        </p>
      </div>
      <div className="login-actions">
        <h2 className="text-xl font-bold mb-2">오늘의 작은 공부를 시작해요</h2>
        <p>학생과 학부모가 함께 쓰는 학습 공간</p>
        {providers.length > 0 && (
          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-2 mb-2">
              {(['STUDENT', 'PARENT'] as Role[]).map((r) => (
                <button
                  key={r}
                  className="pill justify-center"
                  aria-pressed={r === loginRole}
                  onClick={() => setLoginRole(r)}
                >
                  {r === 'STUDENT' ? '학생' : '학부모'}
                </button>
              ))}
            </div>
            {providers.map((p) => {
              const name = (
                { kakao: '카카오', naver: '네이버', google: 'Google', apple: 'Apple' } as Record<string, string>
              )[p];
              // A link cannot be disabled, so while waiting it renders as a disabled button.
              return waiting ? (
                <button key={p} className="btn btn-secondary w-full" disabled>
                  {waitingLabel(`${name}로 시작하기`, retryIn)}
                </button>
              ) : (
                <a key={p} className="btn btn-secondary w-full" href={`/api/auth/${p}?role=${loginRole}`}>
                  {name}로 시작하기
                </a>
              );
            })}
          </div>
        )}
        {demo && (
          <>
            <div className="demo-divider">샘플 자료로 먼저 만나보세요</div>
            <Button disabled={busy || waiting} className="w-full" onClick={() => start('STUDENT')}>
              {busy ? '학습 공간을 여는 중…' : waitingLabel('학생으로 체험하기', retryIn)}
              <ArrowRight size={18} />
            </Button>
            <Button
              disabled={busy || waiting}
              variant="ghost"
              className="w-full mt-1 text-sm"
              onClick={() => start('PARENT')}
            >
              {waitingLabel('학부모로 둘러보기', retryIn)}
            </Button>
          </>
        )}
        {!demo && providers.length === 0 && (
          <p className="error-banner">로그인 서비스 연결을 준비하고 있어요.</p>
        )}
        {waiting ? (
          <p role="status" className="error-banner mt-3">
            로그인 요청이 많아요. {retryIn}초 후 다시 시도해 주세요.
          </p>
        ) : (
          error && (
            <p role="alert" className="error-banner mt-3">
              {error}
            </p>
          )
        )}
        <p className="!mb-0 !mt-4 text-center !text-[11px]">
          {demo
            ? '체험 계정의 샘플 자료와 학습 기록이 저장됩니다.'
            : '안전하게 로그인하고 나만의 학습을 시작하세요.'}
        </p>
      </div>
    </div>
  );
}
export function HomeScreen({ data, navigate, toast, refresh }: ScreenProps) {
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
  const due = data.cards.filter((c) => isDue(c));
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
  return (
    <div className="home-screen">
      <header className="main-header home-header">
        <button className="brand" onClick={() => navigate('/')}>
          memoryz.
        </button>
        <div className="home-header-actions">
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
          <IconButton label="내 프로필" onClick={() => navigate('/profile')}>
            <span className="avatar">{data.profile.name.slice(-2, -1) || '나'}</span>
          </IconButton>
        </div>
      </header>
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
      <section className="home-review" aria-label="오늘 복습할 카드">
        <div className="home-review-head">
          <span>오늘 복습할 카드</span>
          <small>
            {due.length
              ? `약 ${Math.max(1, Math.ceil(due.length / 2))}분`
              : data.cards.some((c) => !c.deleted)
                ? '복습 완료'
                : '첫 카드를 만들어 보세요'}
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
          onClick={() =>
            navigate(
              due.length
                ? '/flashcards?review=1'
                : data.cards.some((c) => !c.deleted)
                  ? '/flashcards'
                  : '/create-card',
            )
          }
        >
          {due.length
            ? '복습 시작'
            : data.cards.some((c) => !c.deleted)
              ? '복습 카드 살펴보기'
              : '첫 복습 카드 만들기'}
          <ArrowRight size={18} />
        </button>
      </section>
      <div className="home-body">
        <button className="home-agenda" onClick={() => navigate('/planner')}>
          <CalendarDays size={22} />
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
                <button className="home-start-ink" onClick={() => navigate('/study?upload=camera')}>
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
                      await api('/materials/sample', {});
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
                <button onClick={() => navigate('/study')}>
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
  );
}
function SearchScreen({ data, navigate }: ScreenProps) {
  const [q, setQ] = useState('');
  const term = q.toLowerCase().trim();
  const materials = data.materials.filter((m) => m.title.toLowerCase().includes(term));
  const cards = data.cards.filter(
    (c) => !c.deleted && (c.front + c.back).toLowerCase().includes(term),
  );
  return (
    <>
      <ScreenHeader title="찾고 싶은 공부" back={() => navigate('/')} />
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
          <>
            <SectionTitle title={`자료 ${materials.length}`} />
            {materials.map((m) => (
              <ListRow
                key={m.id}
                icon={<FileText size={20} />}
                title={m.title}
                onClick={() => navigate(`/subjects/${m.subjectId}`)}
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
function NotificationsScreen({ data, navigate, refresh, toast }: ScreenProps) {
  return (
    <>
      <ScreenHeader
        title="알림"
        back={() => navigate('/')}
        action={
          <button
            className="text-sm text-muted"
            onClick={async () => {
              try {
                await api('/notifications', { read: true }, 'PATCH');
                await refresh();
                toast('모두 읽음으로 표시했어요');
              } catch (e) {
                toast((e as Error).message);
              }
            }}
          >
            모두 읽음
          </button>
        }
      />
      <div className="page-inset">
        {data.notifications.map((n) => (
          <ListRow
            key={n.id}
            icon={<Bell size={21} />}
            title={n.title}
            description={n.body}
            extra={!n.read ? <span className="w-1.5 h-1.5 bg-accent rounded-full" /> : undefined}
            onClick={() => navigate(n.href)}
          />
        ))}
        {!data.notifications.length && (
          <EmptyState
            title="모두 확인했어요"
            description="복습할 시간과 새로운 소식을 알려드릴게요."
          />
        )}
      </div>
    </>
  );
}
export default function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState('/');
  // The key the current screen is mounted under: it follows path, except for a keepScreen
  // navigation that only tidies the address.
  const [screen, setScreen] = useState('/');
  const [message, setMessage] = useState('');
  const [offline, setOffline] = useState(false);
  const [roleSheet, setRoleSheet] = useState(false);
  const [error, setError] = useState('');
  const [loginRetryAt, setLoginRetryAt] = useState<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((m: string) => {
    setMessage(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    // jitter: none — a 3.5 s toast auto-clear for one person; sends nothing [site src/components/app.tsx:637]
    toastTimer.current = setTimeout(() => setMessage(''), 3500);
  }, []);
  const navigate = useCallback((to: string, options?: { replace?: boolean; keepScreen?: boolean }) => {
    if (!to.startsWith('/') || to.startsWith('//')) return;
    if (options?.replace) window.history.replaceState({}, '', to);
    else window.history.pushState({}, '', to);
    setPath(to);
    if (options?.keepScreen) return;
    setScreen(to);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);
  const refresh = useCallback(async () => {
    const result = await api<AppData>('/bootstrap');
    setData(result);
    setError('');
    const db = await shellDB();
    await db.put('session', result, 'data');
  }, []);
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    // The sign-in result is read once; a reload must not restart its countdown.
    if (search.has('loginError')) window.history.replaceState({}, '', window.location.pathname);
    setPath(window.location.pathname + window.location.search);
    setScreen(window.location.pathname + window.location.search);
    // The OAuth start was refused: a top-level navigation cannot read JSON, so the wait rides in the
    // URL (clamped to what the server can send, so a crafted link cannot lock sign-in).
    if (search.get('loginError') === 'busy') setLoginRetryAt(loginBusyRetryAt(search.get('retryAfter')));
    else if (search.has('loginError')) setError('로그인을 완료하지 못했어요. 다시 시작해 주세요.');
    const booting = new AbortController();
    const pop = () => {
      setPath(window.location.pathname + window.location.search);
      setScreen(window.location.pathname + window.location.search);
      window.scrollTo(0, 0);
    };
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('popstate', pop);
    // jitter: none — 'offline'/'online' only toggle the offline banner; they send no request [site src/components/app.tsx:663]
    window.addEventListener('offline', update);
    window.addEventListener('online', update);
    const restoreCached = async () => {
      const db = await shellDB();
      const cached: AppData | undefined = await db.get('session', 'data');
      if (cached) {
        const cards = await cachedCards(cached.profile.id);
        setData(cards.length ? { ...cached, cards } : cached);
        setLoading(false);
      }
      return Boolean(cached);
    };
    void (async () => {
      const cached = await restoreCached().catch(() => false);
      // Without the signed-in flag and without a session this device saved, bootstrap can only
      // answer 401: show the sign-in screen without asking.
      if (!cached && !sessionHint(document.cookie)) {
        setLoading(false);
        return;
      }
      try {
        // A deploy or restart at the bell answers 502/503/504 for a moment: bootstrap (idempotent) is
        // retried up to 3 times with full jitter, never before Retry-After, while the cached shell
        // stays on screen. A client timeout is not retried (no server answered at all).
        // jitter: backoff bootstrap retry U[0,4 s), U[0,8 s), U[0,16 s), floored by Retry-After + U[0,1 s) [site src/components/app.tsx:684]
        await retryTransient(refresh, { retries: 3, baseMs: 2000, capMs: 16000, signal: booting.signal });
      } catch (e) {
        if (booting.signal.aborted) return;
        if (!navigator.onLine || e instanceof TypeError || (e as Error).name === 'TimeoutError') {
          setOffline(true);
          if (!(await restoreCached().catch(() => false)))
            setError('처음 한 번은 인터넷에 연결해 주세요.');
        } else if ((e as Error).message.includes('로그인')) {
          setData(null);
          const db = await shellDB();
          await db.clear('session');
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
      window.removeEventListener('popstate', pop);
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
      setData(null);
      navigate('/');
      setRoleSheet(false);
    } catch (e) {
      toast((e as Error).message);
    }
  }
  if (loading)
    return (
      <div className="app-shell loading-screen">
        <span className="brand">memoryz.</span>
        <div className="loading-bar" />
        <span className="text-xs text-muted">오늘의 기억을 준비하고 있어요</span>
      </div>
    );
  if (!data)
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
        <Login onLogin={login} retryAt={loginRetryAt} />
      </div>
    );
  const base = path.split('?')[0];
  const isParent = data.profile.role === 'PARENT';
  const protectedStudent =
    /^\/(study|subjects|quiz|essay|flashcards|wrong-notes|create-card|completed-subjects|community|boards|planner)/.test(
      base,
    );
  const protectedParent = /^\/(parent|parent-boards)(\/|$)/.test(base);
  const denied =
    (isParent && protectedStudent) ||
    (!isParent && protectedParent) ||
    (base === '/admin' && data.profile.role !== 'ADMIN');
  const props: ScreenProps = { data, refresh, navigate, toast, path };
  const study =
    /^\/(study|subjects|quiz|essay|flashcards|wrong-notes|create-card|completed-subjects)/.test(
      base,
    );
  const social =
    /^\/(planner|community|boards|parent-boards|profile|parent|cheer|settings|admin|messages|followers|following)/.test(
      base,
    );
  const focusMode = [
    '/quiz',
    '/essay',
    '/flashcards',
    '/create-card',
    '/completed-subjects',
    '/onboarding',
  ].includes(base);
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
  return (
    <div className="app-shell">
      {offline && (
        <div className="offline-banner">
          <WifiOff size={13} className="inline mr-1" />
          오프라인이에요 · 저장한 카드로 복습할 수 있어요
        </div>
      )}
      <main className={`app-main${focusMode ? ' app-main-focus' : ''}`} id="main-content">
        {base === '/settings/learning' ? (
          <LearningSettings {...props} />
        ) : base === '/onboarding' ? (
          <Onboarding {...props} />
        ) : denied ? (
          <>
            <ScreenHeader
              title="접근할 수 없는 공간"
              back={() => navigate(isParent ? '/parent' : '/')}
            />
            <EmptyState
              title="이 계정에서 볼 수 없는 화면이에요"
              description="학생과 학부모의 학습 공간을 안전하게 구분하고 있어요."
              action={
                <Button onClick={() => navigate(isParent ? '/parent' : '/')}>내 홈으로</Button>
              }
            />
          </>
        ) : base === '/search' ? (
          <SearchScreen {...props} />
        ) : base === '/notifications' ? (
          <NotificationsScreen {...props} />
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
      {!focusMode && (
        <nav className="bottom-nav" aria-label="메인 메뉴">
          {nav.map((n) => {
            const active =
              n.href === '/study'
                ? study
                : (n.href === '/parent' && base === '/') ||
                  base === n.href ||
                  (n.href !== '/' && base.startsWith(`${n.href}/`));
            return (
              <button
                key={n.href}
                className={`nav-item ${active ? 'active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => navigate(n.href)}
              >
                <n.icon />
                <span>{n.label}</span>
              </button>
            );
          })}
        </nav>
      )}
      {message && (
        <div className="toast" role="status">
          {message}
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
              variant="secondary"
              onClick={() => login(isParent ? 'STUDENT' : 'PARENT').catch((e) => toast(e.message))}
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
  );
}
