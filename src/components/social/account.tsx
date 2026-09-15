'use client';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Award,
  Bell,
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  Flame,
  Heart,
  Link2,
  LockKeyhole,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
} from '@/components/icons';
import { api } from '@/lib/api';
import { wrongQuestions, wrongEssays } from '@/components/study/logic';
import type { Profile, ScreenProps } from '@/lib/contracts';
import { Button, IconButton, ListRow, ScreenHeader, SectionTitle, Sheet } from '@/components/ui';
import SocialHub, { type SocialData } from './social-hub';
import { ChildLinks } from './parent';

export default function Account(props: ScreenProps) {
  const { data, navigate, refresh, toast, path } = props;
  const [edit, setEdit] = useState(false);
  const [links, setLinks] = useState(false);
  const [hub, setHub] = useState<'followers' | 'following' | 'blocked' | null>(null);
  const [badgeOpen, setBadgeOpen] = useState(false);
  const [social, setSocial] = useState<SocialData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<SocialData>('/social')
      .then((s) => {
        if (active) setSocial(s);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [data.posts]);
  const parent = data.profile.role === 'PARENT';
  const privacyRows: { key: keyof Profile['privacy']; title: string; description: string }[] = [
    { key: 'accuracy', title: '정답률 공개', description: '얼마나 이해했는지 비율로만 보여드려요' },
    { key: 'time', title: '학습 시간 공개', description: '공부한 시간과 시간표를 보여드려요' },
    {
      key: 'wrongNotes',
      title: '오답노트 상세 공개',
      description: '어떤 문제를 틀렸는지 보여드려요',
    },
  ];
  async function privacyChange(key: keyof Profile['privacy']) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(
        '/profile',
        { privacy: { ...data.profile.privacy, [key]: !data.profile.privacy[key] } },
        'PATCH',
      );
      await refresh();
      toast('공개 범위를 바꿨어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const badges = [
    {
      title: '첫 문제의 시작',
      description: '첫 문제 풀이를 마쳤어요',
      earned: data.attempts.length > 0,
      icon: BookOpen,
    },
    {
      title: '기억 수집가',
      description: '첫 카드를 암기 완료했어요',
      earned: data.cards.some((c) => c.bucket === 'MASTERED'),
      icon: Sparkles,
    },
    {
      title: '일주일의 꾸준함',
      description: '7일 연속 공부했어요',
      earned: data.profile.streak >= 7,
      icon: Flame,
    },
    {
      title: '마음을 전하는 사람',
      description: '응원을 주고받았어요',
      earned: data.cheers.length > 0,
      icon: Heart,
    },
  ];
  if (path.startsWith('/settings'))
    return (
      <>
        <ScreenHeader title="설정" back={() => navigate('/profile')} />
        <div className="page-inset pb-8">
          <SectionTitle title="내 계정" />
          <ListRow
            icon={<Users size={21} />}
            title="프로필 편집"
            description={`${data.profile.nickname} · ${parent ? '학부모' : data.profile.grade || '학생'}`}
            onClick={() => setEdit(true)}
          />
          <ListRow
            icon={<Link2 size={21} />}
            title={parent ? '자녀 연결 관리' : '학부모 연결'}
            onClick={() => setLinks(true)}
          />
          {!parent && data.profile.role === 'STUDENT' && (
            <section className="mt-7">
              <SectionTitle title="부모님께 보여드릴 정보" />
              <p className="text-[14px] text-muted leading-6 mb-4">
                공개 범위는 내가 정해요.
                <br />
                언제든 바꿀 수 있고, 바로 반영돼요.
              </p>
              {privacyRows.map((row) => (
                <div key={row.key} className="privacy-setting-row">
                  <div className="flex-1">
                    <p className="text-[15px] font-semibold">{row.title}</p>
                    <p className="text-[12px] text-subtle mt-1 leading-5">{row.description}</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={data.profile.privacy[row.key]}
                    aria-label={row.title}
                    disabled={busy}
                    onClick={() => privacyChange(row.key)}
                    className={`w-12 h-7 rounded-full p-1 shrink-0 transition-colors ${data.profile.privacy[row.key] ? 'bg-brand' : 'bg-line-strong'}`}
                  >
                    <span
                      className={`block size-5 rounded-full bg-white transition-transform ${data.profile.privacy[row.key] ? 'translate-x-5' : ''}`}
                    />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-3 py-4">
                <div className="flex-1">
                  <p className="text-[15px] font-semibold">커뮤니티 활동</p>
                  <p className="text-[12px] text-subtle mt-1 leading-5">
                    글, 댓글, 친구와 나눈 이야기는 나만 봐요
                  </p>
                </div>
                <span className="text-[12px] font-semibold text-muted flex gap-1 items-center">
                  <LockKeyhole size={13} />
                  항상 비공개
                </span>
              </div>
              {error && (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              )}
            </section>
          )}
          <section className="mt-7">
            <SectionTitle title="안전한 이용" />
            <ListRow
              icon={<ShieldCheck size={21} />}
              title="차단한 사용자"
              onClick={() => setHub('blocked')}
            />
            <ListRow
              icon={<Bell size={21} />}
              title="알림"
              onClick={() => navigate('/notifications')}
            />
          </section>
          <p className="mt-8 text-[12px] text-subtle">Memoryz · 기억이 실력이 되는 곳</p>
        </div>
        <ProfileEditor {...props} open={edit} onClose={() => setEdit(false)} />
        <Sheet
          open={links}
          onClose={() => setLinks(false)}
          title={parent ? '자녀 연결 관리' : '부모님과 연결하기'}
        >
          {parent ? <ChildLinks {...props} /> : <InviteCode {...props} />}
        </Sheet>
        <Sheet open={!!hub} onClose={() => setHub(null)} title="친구 관리">
          {hub && <SocialHub {...props} initialTab={hub} />}
        </Sheet>
      </>
    );
  return (
    <>
      <ScreenHeader
        title="마이"
        action={
          <IconButton label="설정" onClick={() => navigate('/settings')}>
            <Settings size={23} />
          </IconButton>
        }
      />
      <div className="page-inset pb-8">
        <div className="profile-identity">
          <span className="size-14 shrink-0 rounded-full bg-surface text-secondary flex items-center justify-center text-[23px] font-bold">
            {data.profile.name.slice(0, 1) || data.profile.nickname.slice(0, 1)}
          </span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[23px] font-bold tracking-tight truncate">
              {data.profile.nickname}
            </h1>
            <p className="mt-1 text-[13px] text-muted">
              {parent
                ? '학부모'
                : [data.profile.school, data.profile.grade].filter(Boolean).join(' · ') ||
                  '나만의 공부를 시작해요'}
            </p>
          </div>
          <Button
            variant="secondary"
            className="!min-h-9 !px-3 !text-[13px]"
            onClick={() => setEdit(true)}
          >
            편집
          </Button>
        </div>
        <div className="profile-social-counts">
          {[
            {
              label: '내 글',
              value:
                social?.counts.posts ??
                data.posts.filter((p) => p.authorId === data.profile.id).length,
              action: () => navigate(`${parent ? '/parent-boards' : '/community'}?mine=1`),
            },
            {
              label: '댓글',
              value: social?.counts.comments,
              action: () => navigate(`${parent ? '/parent-boards' : '/community'}?commented=1`),
            },
            { label: '팔로워', value: social?.counts.followers, action: () => setHub('followers') },
            { label: '팔로잉', value: social?.counts.following, action: () => setHub('following') },
          ].map((s) => (
            <button key={s.label} onClick={s.action} className="flex flex-col items-center gap-1">
              <span className="font-bold text-[20px] tabular-nums">{s.value ?? '–'}</span>
              <span className="text-[12px] text-subtle">{s.label}</span>
            </button>
          ))}
        </div>
        {!parent && (
          <button
            onClick={() => setBadgeOpen(true)}
            className="w-full primary-surface rounded-[22px] p-5 flex items-center gap-4 text-left"
          >
            <span className="flex size-10 shrink-0 items-center justify-center">
              <Award size={32} />
            </span>
            <span className="flex-1">
              <span className="block text-[12px] font-medium on-primary">
                하나씩 쌓이는 나의 기록
              </span>
              <span className="block text-[18px] font-bold mt-1">
                {data.profile.streak > 0
                  ? `${data.profile.streak}일째, 기억을 쌓고 있어요`
                  : '오늘의 작은 시작도 빛나요'}
              </span>
            </span>
            <ChevronRight size={20} />
          </button>
        )}
        {parent && (
          <section className="mt-1">
            <SectionTitle title="연결된 자녀" />
            {data.child ? (
              <button
                onClick={() => navigate('/parent')}
                className="w-full rounded-[20px] bg-surface p-4 flex gap-3 items-center text-left"
              >
                <span className="size-11 rounded-full bg-white text-secondary flex items-center justify-center font-bold">
                  {data.child.name.slice(0, 1)}
                </span>
                <span className="flex-1">
                  <span className="font-bold text-[16px]">{data.child.name}</span>
                  <span className="block text-[12px] text-muted mt-1">
                    {data.child.school} · {data.child.grade}
                  </span>
                </span>
                <ChevronRight size={20} />
              </button>
            ) : (
              <p className="py-3 text-sm text-subtle">자녀를 연결하면 학습 현황을 볼 수 있어요.</p>
            )}
            <button
              onClick={() => setLinks(true)}
              className="w-full py-4 text-[14px] font-bold text-muted"
            >
              자녀 추가·연결 관리
            </button>
          </section>
        )}
        <button onClick={() => navigate('/cheer')} className="profile-wallet">
          <Wallet size={23} />
          <span>{parent ? '보낼 수 있는 포인트' : '응원으로 모은 포인트'}</span>
          <strong>
            {data.profile.points.toLocaleString()}
            <small>P</small>
          </strong>
          <ChevronRight size={17} className="text-disabled" />
        </button>
        <SectionTitle title={parent ? '활동과 소식' : '나의 학습과 소식'} />
        <div className="mt-3">
          {!parent && (
            <>
              <ListRow
                icon={<Link2 size={21} />}
                title="학부모 연결"
                onClick={() => setLinks(true)}
              />
              <ListRow
                icon={<BookOpen size={21} />}
                title="배운 과목"
                extra={
                  <span className="text-sm text-subtle">
                    {data.profile.completedSubjects.length}과목
                  </span>
                }
                onClick={() => navigate('/completed-subjects')}
              />
              <ListRow
                icon={<Check size={21} />}
                title="오답노트"
                extra={
                  <span className="text-sm text-subtle">
                    {wrongQuestions(data).length + wrongEssays(data).length}개
                  </span>
                }
                onClick={() => navigate('/wrong-notes')}
              />
            </>
          )}
          <ListRow
            icon={<Heart size={21} />}
            title={parent ? '보낸 응원' : '받은 응원'}
            extra={<span className="text-sm text-subtle">{data.cheers.length}번</span>}
            onClick={() => navigate('/cheer')}
          />
          <ListRow
            icon={<Bell size={21} />}
            title="알림"
            onClick={() => navigate('/notifications')}
          />
          {data.profile.role === 'ADMIN' && (
            <ListRow
              icon={<ShieldCheck size={21} />}
              title="운영 관리"
              onClick={() => navigate('/admin')}
            />
          )}
        </div>
      </div>
      <ProfileEditor {...props} open={edit} onClose={() => setEdit(false)} />
      <Sheet
        open={links}
        onClose={() => setLinks(false)}
        title={parent ? '자녀 연결 관리' : '부모님과 연결하기'}
      >
        {parent ? <ChildLinks {...props} /> : <InviteCode {...props} />}
      </Sheet>
      <Sheet open={!!hub} onClose={() => setHub(null)} title="함께 공부하는 친구">
        {hub && <SocialHub {...props} initialTab={hub} />}
      </Sheet>
      <Sheet open={badgeOpen} onClose={() => setBadgeOpen(false)} title="나의 기억 배지">
        <p className="text-[14px] text-muted mb-5">공부한 만큼, 나만의 배지가 쌓여요.</p>
        <div className="grid grid-cols-2 gap-3">
          {badges.map((b) => (
            <div
              key={b.title}
              className={`rounded-[20px] p-5 text-center ${b.earned ? 'bg-surface text-ink' : 'bg-canvas text-subtle'}`}
            >
              {b.icon === Flame ? (
                <span className="system-emoji block !text-[34px] mb-3" aria-hidden="true">
                  🔥
                </span>
              ) : (
                <b.icon size={34} className="mx-auto mb-3" />
              )}
              <h3 className="font-semibold text-[14px]">{b.title}</h3>
              <p className="text-[11px] mt-1.5 leading-4">
                {b.earned ? b.description : '아직 획득 전이에요'}
              </p>
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}

function ProfileEditor({
  data,
  refresh,
  toast,
  open,
  onClose,
}: ScreenProps & { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({
    name: data.profile.name,
    nickname: data.profile.nickname,
    school: data.profile.school,
    grade: data.profile.grade,
  });
  const [schools, setSchools] = useState<{ id: string; name: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || !searching || form.school.trim().length < 1) return;
    let active = true;
    const timer = setTimeout(() => {
      api<{ id: string; name: string }[]>(`/schools?q=${encodeURIComponent(form.school)}`)
        .then((s) => {
          if (active) setSchools(s);
        })
        .catch(() => {
          if (active) setSchools([]);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [form.school, searching, open]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/profile', form, 'PATCH');
      await refresh();
      onClose();
      toast('프로필을 바꿨어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open={open} onClose={() => !busy && onClose()} title="나를 소개해 주세요">
      <form onSubmit={save} className="flex flex-col gap-4">
        <label className="text-sm font-semibold">
          이름
          <input
            required
            maxLength={40}
            autoComplete="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="field mt-2"
          />
        </label>
        <label className="text-sm font-semibold">
          닉네임
          <input
            required
            minLength={2}
            maxLength={30}
            value={form.nickname}
            onChange={(e) => setForm({ ...form, nickname: e.target.value })}
            className="field mt-2"
          />
        </label>
        {data.profile.role === 'STUDENT' && (
          <>
            <label className="text-sm font-semibold">
              학교
              <input
                value={form.school}
                maxLength={100}
                placeholder="학교 이름을 검색해 주세요"
                onChange={(e) => {
                  setForm({ ...form, school: e.target.value });
                  setSearching(true);
                }}
                className="field mt-2"
              />
              {searching && schools.length > 0 && (
                <span className="flex flex-col mt-1 max-h-36 overflow-auto rounded-xl bg-canvas">
                  {schools.map((s) => (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => {
                        setForm({ ...form, school: s.name });
                        setSearching(false);
                      }}
                      className="px-4 py-3 text-left text-sm font-medium"
                    >
                      {s.name}
                    </button>
                  ))}
                </span>
              )}
            </label>
            <label className="text-sm font-semibold">
              학년
              <select
                className="field mt-2"
                value={form.grade}
                onChange={(e) => setForm({ ...form, grade: e.target.value })}
              >
                <option value="">학년 선택</option>
                {['고1', '고2', '고3', 'N수·기타'].map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="mt-2">
          {busy ? '저장하고 있어요…' : '저장하기'}
        </Button>
      </form>
    </Sheet>
  );
}

function InviteCode({ toast }: ScreenProps) {
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!invite) return;
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((Date.parse(invite.expiresAt) - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [invite]);
  async function generate() {
    setBusy(true);
    setError('');
    try {
      setInvite(await api('/invite', {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <p className="text-[15px] text-muted leading-6 mb-6">
        부모님 앱에서 아래 코드를 입력하면 연결돼요.
        <br />
        내가 허용한 학습 정보만 보여드려요.
      </p>
      {invite && (
        <div className="rounded-[24px] bg-surface p-7 text-center mb-5">
          <span
            className={`block text-[36px] font-bold tracking-[0.18em] tabular-nums ${remaining ? '' : 'text-disabled'}`}
          >
            {invite.code}
          </span>
          <span className="block text-[13px] text-muted mt-3">
            {remaining
              ? `${Math.floor(remaining / 60)}분 ${String(remaining % 60).padStart(2, '0')}초 뒤 만료돼요`
              : '코드가 만료됐어요'}
          </span>
          {remaining > 0 && (
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(invite.code);
                  toast('연결 코드를 복사했어요');
                } catch {
                  toast('코드를 길게 눌러 복사해 주세요');
                }
              }}
              className="mx-auto mt-4 flex gap-1.5 items-center text-[13px] font-bold"
            >
              <Copy size={15} />
              코드 복사
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger mb-4">
          {error}
        </p>
      )}
      <Button onClick={generate} disabled={busy} className="w-full">
        {busy ? '코드를 만들고 있어요…' : invite ? '새 코드 받기' : '연결 코드 만들기'}
      </Button>
      <p className="text-[12px] text-subtle leading-5 mt-4 text-center">
        새 코드를 만들면 이전 코드는 더 이상 사용할 수 없어요.
      </p>
    </div>
  );
}
