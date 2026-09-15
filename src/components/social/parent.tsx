'use client';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Heart,
  Link2,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Sparkles,
  Unlink,
} from '@/components/icons';
import { api } from '@/lib/api';
import type { Profile, ScreenProps } from '@/lib/contracts';
import { Button, EmptyState, IconButton, ScreenHeader, SectionTitle, Sheet } from '@/components/ui';
import { dateKey, relativeTime, shiftDate, subjectAccuracy, weekDates } from './helpers';

export default function Parent(props: ScreenProps) {
  const { data, navigate } = props;
  const [links, setLinks] = useState(false);
  const [parentStats, setParentStats] = useState<{
    subjectStats: ReturnType<typeof subjectAccuracy>;
    masteredCards: number;
    weeklyQuestions: number;
    studyDays: number;
  } | null>(null);
  const [statsError, setStatsError] = useState('');
  useEffect(() => {
    let active = true;
    if (data.profile.role !== 'PARENT' || !data.child) return;
    setParentStats(null);
    setStatsError('');
    api<{
      subjectStats: ReturnType<typeof subjectAccuracy>;
      masteredCards: number;
      weeklyQuestions: number;
      studyDays: number;
    }>('/parent-stats')
      .then((r) => {
        if (active) setParentStats(r);
      })
      .catch((e) => {
        if (active) setStatsError(e.message);
      });
    return () => {
      active = false;
    };
  }, [data]);
  const aggregates = parentStats?.subjectStats ?? [];
  if (data.profile.role !== 'PARENT')
    return (
      <>
        <ScreenHeader title="자녀 현황" />
        <EmptyState
          title="학부모님을 위한 공간이에요"
          description="내 학습 정보의 공개 범위는 설정에서 바꿀 수 있어요."
          action={<Button onClick={() => navigate('/settings')}>공개 범위 설정</Button>}
        />
      </>
    );
  const child = data.child;
  const week = weekDates(dateKey());
  const historyDates = Array.from({ length: 7 }, (_, index) => shiftDate(dateKey(), index - 6));
  const recent = data.attempts.filter(
    (a) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(a.createdAt)) >=
      week[0],
  );
  const activeDays = parentStats?.studyDays ?? data.stats.weekly.filter((n) => n > 0).length;
  return (
    <>
      <ScreenHeader
        title="자녀 현황"
        action={
          <IconButton label="자녀 연결 관리" onClick={() => setLinks(true)}>
            <Plus size={23} />
          </IconButton>
        }
      />
      {!child ? (
        <EmptyState
          title="아이의 작은 성장을 함께해요"
          description="자녀가 마이페이지에서 만든 연결 코드를 입력해 주세요. 아이가 허용한 정보만 보여드려요."
          action={
            <Button onClick={() => setLinks(true)}>
              <Link2 size={18} />
              자녀 연결하기
            </Button>
          }
        />
      ) : (
        <div className="page-inset pb-8">
          <button
            onClick={() => setLinks(true)}
            className="inline-flex items-center gap-2 rounded-full bg-surface p-1 pr-3 mt-1"
          >
            <span className="bg-white text-secondary flex size-8 items-center justify-center rounded-full text-sm font-bold">
              {child.name.slice(0, 1)}
            </span>
            <span className="font-bold text-[14px]">
              {child.name} · {child.grade}
            </span>
            <ChevronDown size={16} />
          </button>
          <div className="mt-6">
            <p className="text-[13px] text-subtle font-medium">
              이번 주 · {Number(week[0].slice(5, 7))}월 {Number(week[0].slice(-2))}일 –{' '}
              {Number(week[6].slice(-2))}일
            </p>
            <h1 className="text-[26px] font-bold tracking-[-0.035em] leading-[1.35] mt-2">
              {child.name}의 오늘이
              <br />
              {activeDays > 0 ? '조금씩 쌓이고 있어요' : '가능성으로 가득해요'}
            </h1>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-6">
            {[
              {
                label: '외운 카드',
                value: parentStats ? `${parentStats.masteredCards}` : '–',
                unit: '개 · 누적',
                private: false,
              },
              {
                label: '이번 주 푼 문제',
                value: parentStats ? `${parentStats.weeklyQuestions}` : '–',
                unit: '문제',
                private: false,
              },
              {
                label: '평균 정답률',
                value: `${data.stats.accuracy}`,
                unit: '%',
                private: !child.privacy.accuracy,
              },
            ].map((stat, i) => (
              <div
                key={stat.label}
                className={`rounded-[18px] p-3.5 min-h-[112px] flex flex-col ${i === 0 ? 'bg-ink text-white' : 'bg-surface'}`}
              >
                <span
                  className={`text-[12px] font-medium ${i === 0 ? 'text-white/70' : 'text-muted'}`}
                >
                  {stat.label}
                </span>
                {stat.private ? (
                  <span className="flex flex-col gap-1 mt-4 text-subtle">
                    <LockKeyhole size={20} />
                    <span className="text-[11px]">비공개</span>
                  </span>
                ) : (
                  <>
                    <span className="mt-4 text-[26px] leading-none font-bold tracking-tight">
                      {stat.value}
                    </span>
                    <span
                      className={`mt-2 text-[10px] ${i === 0 ? 'text-white/60' : 'text-subtle'}`}
                    >
                      {stat.unit}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
          {statsError && (
            <div className="mt-3 rounded-2xl bg-surface p-4">
              <p role="alert" className="text-sm text-muted">
                {statsError}
              </p>
              <Button
                variant="ghost"
                onClick={() => props.refresh().catch((e) => props.toast(e.message))}
              >
                학습 현황 다시 불러오기
              </Button>
            </div>
          )}
          <section className="mt-8">
            <SectionTitle
              title="최근 7일의 공부 흐름"
              action={
                <span className="text-[12px] text-subtle">
                  {child.privacy.time
                    ? `${data.stats.weekly.filter((n) => n > 0).length}일 함께했어요`
                    : ''}
                </span>
              }
            />
            {!child.privacy.time ? (
              <PrivateNotice title="학습 시간은 아이만 보고 있어요" />
            ) : (
              <>
                <div
                  className="h-36 flex gap-3 items-end pt-4"
                  role="img"
                  aria-label={`최근 7일 일별 학습량: ${data.stats.weekly.join(', ')}`}
                >
                  {historyDates.map((date, i) => (
                    <div
                      key={date}
                      className="flex flex-1 flex-col items-center justify-end h-full gap-2"
                    >
                      <span className="text-[10px] text-subtle tabular-nums">
                        {data.stats.weekly[i] || 0}
                      </span>
                      <div
                        className={`w-full rounded-t-[7px] min-h-[4px] ${date === dateKey() ? 'primary-surface' : 'bg-line-strong'}`}
                        style={{
                          height: `${Math.max(4, ((data.stats.weekly[i] || 0) / Math.max(...data.stats.weekly, 1)) * 84)}px`,
                        }}
                      />
                      <span className="text-[11px] text-subtle">
                        {new Intl.DateTimeFormat('ko-KR', { weekday: 'short' }).format(
                          new Date(`${date}T12:00:00`),
                        )}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-[12px] text-subtle mt-4">
                  막대는 학습한 문제·카드 수예요 · 오늘 학습 시간 {data.stats.studyMinutes}분
                </p>
              </>
            )}
          </section>
          <section className="mt-8">
            <SectionTitle title="과목별 이해도" />
            {!child.privacy.accuracy ? (
              <PrivateNotice title="정답률은 아이만 보고 있어요" />
            ) : !parentStats ? (
              <p
                role={statsError ? undefined : 'status'}
                className="text-[14px] text-subtle py-4 leading-6"
              >
                {statsError
                  ? '연결이 되면 과목별 이해도를 확인할 수 있어요.'
                  : '과목별 이해도를 가져오고 있어요…'}
              </p>
            ) : aggregates.some((s) => s.count > 0) ? (
              <div className="flex flex-col gap-5 mt-5">
                {aggregates
                  .filter((s) => s.count > 0)
                  .map((s) => (
                    <div key={s.id}>
                      <div className="flex items-center justify-between text-[14px]">
                        <span className="font-semibold">{s.name}</span>
                        <span className="font-bold tabular-nums">
                          {s.accuracy}%
                          <span className="ml-2 text-[11px] font-normal text-subtle">
                            {s.count}문제
                          </span>
                        </span>
                      </div>
                      <div className="h-2 mt-2 rounded-full bg-surface overflow-hidden">
                        <div
                          className="h-full primary-surface rounded-full"
                          style={{ width: `${Math.min(100, Math.max(0, s.accuracy ?? 0))}%` }}
                        />
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-[14px] text-subtle py-4 leading-6">
                문제를 풀면 과목별 이해도가 쌓여요.
                <br />
                아이의 속도를 기다려 주세요.
              </p>
            )}
          </section>
          <div className="mt-7 primary-surface p-5 rounded-[22px]">
            <span className="flex items-center gap-2 text-[12px] font-bold">
              <Sparkles size={16} />
              작은 응원이 큰 힘이 돼요
            </span>
            <p className="text-[16px] font-semibold leading-6 mt-3">
              결과보다 꾸준한 마음을
              <br />
              칭찬해 주면 어떨까요?
            </p>
            <button
              onClick={() => navigate('/cheer')}
              className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-[13px] font-bold text-ink"
            >
              응원 보내기
              <ChevronRight size={16} />
            </button>
          </div>
          <section className="mt-7">
            <SectionTitle title="오답노트" />
            {!child.privacy.wrongNotes || !child.privacy.accuracy ? (
              <PrivateNotice title="오답노트는 아이만 보고 있어요" />
            ) : (
              <div>
                <p className="text-[14px] text-muted mb-3">
                  이번 주 다시 배우고 있는 문제 {recent.filter((a) => !a.correct).length}개
                </p>
                {recent
                  .filter((a) => !a.correct)
                  .slice(0, 5)
                  .map((a) => (
                    <p
                      key={a.id}
                      className="rounded-xl bg-surface px-4 py-3 text-[14px] leading-6 mb-2"
                    >
                      {data.questions.find((q) => q.id === a.questionId)?.prompt ??
                        '서술형 답안을 다시 학습하고 있어요'}
                    </p>
                  ))}
              </div>
            )}
          </section>
          <p className="flex gap-2 items-start text-[12px] text-subtle leading-5 mt-6">
            <ShieldCheck size={17} className="shrink-0 mt-0.5" />
            아이의 커뮤니티 활동은 항상 비공개예요. 공개 범위는 자녀가 직접 정해요.
          </p>
        </div>
      )}
      <Sheet open={links} onClose={() => setLinks(false)} title="함께할 자녀를 선택해 주세요">
        <ChildLinks {...props} />
      </Sheet>
    </>
  );
}
function PrivateNotice({ title }: { title: string }) {
  return (
    <div className="rounded-2xl bg-surface p-4 flex gap-3">
      <LockKeyhole size={20} className="text-subtle shrink-0 mt-0.5" />
      <div>
        <p className="text-[14px] font-semibold">{title}</p>
        <p className="text-[12px] text-subtle leading-5 mt-1">
          공개할 준비가 되면 아이가 직접 바꿀 수 있어요.
        </p>
      </div>
    </div>
  );
}

export function ChildLinks({ data, refresh, toast }: ScreenProps) {
  const [children, setChildren] = useState<(Profile & { selected: boolean })[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<Profile | null>(null);
  useEffect(() => {
    let active = true;
    api<(Profile & { selected: boolean })[]>('/children')
      .then((c) => {
        if (active) setChildren(c);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function reload() {
    setChildren(await api('/children'));
    await refresh();
  }
  async function link(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('6자리 숫자를 입력해 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/link', { code });
      await reload();
      setCode('');
      toast('자녀와 연결됐어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function select(child: Profile) {
    setBusy(true);
    setError('');
    try {
      await api('/children/select', { childId: child.id });
      await reload();
      toast(`${child.name}의 학습 현황을 보여드려요`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function unlink() {
    if (!removing) return;
    setBusy(true);
    setError('');
    try {
      await api(`/children/${removing.id}`, {}, 'DELETE');
      await reload();
      setRemoving(null);
      toast('자녀 연결을 해제했어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {children.map((child) => (
        <div key={child.id} className="flex gap-2 items-center rounded-2xl bg-surface mb-3">
          <button
            disabled={busy}
            className="flex-1 p-4 text-left flex items-center gap-3"
            onClick={() => select(child)}
          >
            <span className="size-10 bg-white text-secondary rounded-full flex items-center justify-center font-bold">
              {child.name.slice(0, 1)}
            </span>
            <span className="flex-1">
              <span className="font-semibold text-[15px]">{child.name}</span>
              <span className="block text-[12px] text-subtle mt-1">
                {child.grade} · {child.school}
              </span>
            </span>
            {child.id === data.child?.id && <Check size={19} />}
          </button>
          <IconButton label={`${child.name} 연결 해제`} onClick={() => setRemoving(child)}>
            <Unlink size={16} />
          </IconButton>
        </div>
      ))}
      {removing ? (
        <div className="rounded-2xl bg-surface p-4 my-4">
          <p className="font-semibold text-[15px]">{removing.name}와 연결을 해제할까요?</p>
          <p className="text-sm text-muted mt-2">
            학습 기록은 그대로 남고, 부모님께 공유되지 않아요.
          </p>
          <div className="flex gap-2 mt-4">
            <Button variant="secondary" className="flex-1" onClick={() => setRemoving(null)}>
              취소
            </Button>
            <Button className="flex-1" onClick={unlink} disabled={busy}>
              연결 해제
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={link} className="mt-6">
          <p className="text-[16px] font-bold">새 자녀 연결하기</p>
          <p className="text-[13px] text-muted leading-6 mt-2 mb-4">
            자녀의 마이페이지에서 만든
            <br />
            6자리 연결 코드를 입력해 주세요.
          </p>
          <input
            aria-label="자녀 연결 코드"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            className="field text-center !text-[28px] tracking-[0.24em] font-bold tabular-nums"
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <Button className="w-full mt-4" type="submit" disabled={busy || code.length !== 6}>
            {busy ? '연결하고 있어요…' : '자녀 연결하기'}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger mt-4">
          {error}
        </p>
      )}
    </div>
  );
}

export function CheerScreen(props: ScreenProps) {
  const { data, refresh, navigate, toast } = props;
  const parent = data.profile.role === 'PARENT';
  const [message, setMessage] = useState('');
  const [points, setPoints] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!message.trim()) {
      setError('응원 메시지를 적어 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/cheers', { message: message.trim(), points });
      await refresh();
      setMessage('');
      setPoints(0);
      toast('따뜻한 마음을 전했어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function thank(id: string) {
    setBusy(true);
    try {
      await api(`/cheers/${id}`, { thanked: true }, 'PATCH');
      await refresh();
      toast('고마운 마음을 전했어요');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ScreenHeader title="응원" />
      <div className="page-inset pb-8">
        {parent ? (
          !data.child ? (
            <EmptyState
              title="마음을 전할 자녀를 연결해요"
              description="자녀가 만든 6자리 코드로 연결하면 응원을 보낼 수 있어요."
              action={<Button onClick={() => navigate('/parent')}>자녀 연결하러 가기</Button>}
            />
          ) : (
            <>
              <h1 className="text-[26px] font-bold tracking-[-0.035em] leading-[1.35] mt-4">
                {data.child.name}에게
                <br />
                힘이 되는 한마디
              </h1>
              <p className="text-[14px] text-muted mt-3 leading-6">
                열심히 하는 마음을 알아주는 것만으로도
                <br />
                아이에겐 큰 힘이 돼요.
              </p>
              <form onSubmit={send} className="mt-6">
                <label className="sr-only" htmlFor="cheer-message">
                  응원 메시지
                </label>
                <textarea
                  id="cheer-message"
                  required
                  maxLength={500}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="오늘도 네 속도로 잘하고 있어. 언제나 응원해!"
                  className="field resize-none min-h-[148px] !p-5 !leading-7"
                />
                <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
                  {['네가 자랑스러워 💛', '오늘도 수고했어!', '늘 네 편이야'].map((text) => (
                    <button
                      key={text}
                      type="button"
                      onClick={() => setMessage(text)}
                      className="whitespace-nowrap rounded-full bg-surface px-3.5 py-2 text-[12px] font-medium text-muted"
                    >
                      {text}
                    </button>
                  ))}
                </div>
                <section className="mt-6">
                  <SectionTitle
                    title="포인트도 함께 보낼까요?"
                    action={
                      <span className="text-[12px] text-muted">
                        잔액 {data.profile.points.toLocaleString()}P
                      </span>
                    }
                  />
                  <div className="grid grid-cols-4 gap-2 mt-3">
                    {[0, 100, 300, 500].map((p) => (
                      <button
                        type="button"
                        key={p}
                        onClick={() => setPoints(p)}
                        disabled={p > data.profile.points}
                        aria-pressed={points === p}
                        className={`rounded-xl py-3 text-[13px] font-bold disabled:opacity-30 ${points === p ? 'bg-ink text-white' : 'bg-surface'}`}
                      >
                        {p ? `${p}P` : '마음만'}
                      </button>
                    ))}
                  </div>
                  <label className="mt-3 flex items-center gap-3 text-[13px] text-muted">
                    직접 입력
                    <input
                      type="number"
                      aria-label="보낼 포인트"
                      min={0}
                      max={data.profile.points}
                      step={1}
                      value={points}
                      onChange={(e) => setPoints(Math.max(0, Math.floor(Number(e.target.value))))}
                      className="field !w-28 !py-2 !min-h-0 !text-sm text-right"
                    />
                    P
                  </label>
                </section>
                {error && (
                  <p role="alert" className="mt-3 text-sm text-danger">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  disabled={busy || points > data.profile.points}
                  className="w-full mt-6"
                >
                  <Heart size={19} />
                  {busy ? '마음을 전하고 있어요…' : '응원 보내기'}
                </Button>
              </form>
            </>
          )
        ) : (
          <div className="primary-surface rounded-[24px] p-6 mt-4">
            <Heart size={30} />
            <p className="text-[23px] font-bold tracking-tight leading-[1.4] mt-4">
              너를 응원하는 마음이
              <br />
              이만큼 모였어요
            </p>
            <p className="text-[34px] font-bold mt-5">
              {data.profile.points.toLocaleString()}
              <span className="text-[20px] ml-1">P</span>
            </p>
          </div>
        )}
        <section className="mt-8">
          <SectionTitle title={parent ? '전한 마음' : '도착한 마음'} />
          {!data.cheers.length ? (
            <p className="py-5 text-[14px] leading-6 text-subtle">
              {parent ? '보낸 응원이 여기에 남아요.' : '응원이 도착하면 여기서 확인할 수 있어요.'}
            </p>
          ) : (
            <div className="flex flex-col gap-3 mt-3">
              {data.cheers.map((cheer) => (
                <div key={cheer.id} className="rounded-[20px] bg-surface p-5">
                  <div className="flex items-center gap-2 text-[12px] text-subtle">
                    <Heart size={15} />
                    {relativeTime(cheer.createdAt)}
                    {cheer.points > 0 && (
                      <span className="ml-auto font-bold text-brand-text">
                        +{cheer.points.toLocaleString()}P
                      </span>
                    )}
                  </div>
                  <p className="mt-3 text-[15px] font-medium leading-7 whitespace-pre-wrap break-words">
                    {cheer.message}
                  </p>
                  {!parent ? (
                    <button
                      disabled={busy || cheer.thanked}
                      onClick={() => thank(cheer.id)}
                      className={`mt-4 inline-flex items-center gap-1.5 text-[13px] font-bold ${cheer.thanked ? 'text-subtle' : 'text-ink'}`}
                    >
                      {cheer.thanked ? (
                        <>
                          <Check size={15} />
                          고마운 마음을 전했어요
                        </>
                      ) : (
                        <>
                          <Heart size={15} />
                          고마워요 보내기
                        </>
                      )}
                    </button>
                  ) : (
                    cheer.thanked && (
                      <p className="text-[12px] text-muted mt-3 flex gap-1 items-center">
                        <Check size={14} />
                        고마운 마음이 도착했어요
                      </p>
                    )
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
