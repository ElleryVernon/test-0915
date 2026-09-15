'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { School, Search, UserRound } from '@/components/icons';
import { api } from '@/lib/api';
import type { ScreenProps } from '@/lib/contracts';
import { Button, EmptyState, ScreenHeader, Sheet } from '@/components/ui';
interface AdminData {
  users: { id: string; name: string; nickname: string; role: string; suspended: boolean }[];
  reports: {
    id: string;
    reason: string;
    status: string;
    postId: string;
    postTitle: string;
    createdAt: string;
  }[];
  schools: { id: string; name: string }[];
}
export default function Admin({ data, navigate, toast }: ScreenProps) {
  const [admin, setAdmin] = useState<AdminData | null>(null);
  const [tab, setTab] = useState<'reports' | 'users' | 'schools'>('reports');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [school, setSchool] = useState('');
  const [user, setUser] = useState<AdminData['users'][number] | null>(null);
  useEffect(() => {
    let active = true;
    if (data.profile.role !== 'ADMIN') return;
    api<AdminData>('/admin')
      .then((a) => {
        if (active) setAdmin(a);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [data.profile.role]);
  async function mutation(path: string, body: unknown, method: string) {
    setBusy(true);
    setError('');
    try {
      await api(path, body, method);
      setAdmin(await api<AdminData>('/admin'));
      toast('변경 사항을 저장했어요');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function addSchool(e: FormEvent) {
    e.preventDefault();
    if (await mutation('/admin/schools', { name: school.trim() }, 'POST')) setSchool('');
  }
  if (data.profile.role !== 'ADMIN')
    return (
      <>
        <ScreenHeader title="운영 관리" />
        <EmptyState
          title="운영자만 접근할 수 있어요"
          description="계정 권한을 확인해 주세요."
          action={<Button onClick={() => navigate('/profile')}>마이페이지로</Button>}
        />
      </>
    );
  return (
    <>
      <ScreenHeader title="운영 관리" back={() => navigate('/profile')} />
      <div className="page-inset pb-8">
        <div className="grid grid-cols-3 gap-2 mt-3">
          {(
            [
              ['reports', '신고 관리', admin?.reports.filter((r) => r.status === 'OPEN').length],
              ['users', '사용자', admin?.users.length],
              ['schools', '학교', admin?.schools.length],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              onClick={() => {
                setTab(value);
                setQuery('');
              }}
              className={`rounded-[18px] p-4 text-left ${tab === value ? 'bg-ink text-white' : 'bg-surface'}`}
            >
              <span className="block text-[12px] opacity-70">{label}</span>
              <span className="block text-[24px] font-bold mt-2">{count ?? '–'}</span>
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-[14px] text-danger my-4">
            {error}
          </p>
        )}
        <div className="relative my-6">
          <Search size={18} className="absolute top-3.5 left-3.5 text-subtle" />
          <input
            aria-label="운영 목록 검색"
            placeholder="목록에서 검색"
            className="field !pl-10"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {!admin ? (
          <p role="status" className="text-sm text-subtle py-6">
            운영 데이터를 가져오고 있어요…
          </p>
        ) : (
          <>
            {tab === 'reports' &&
              (admin.reports.length ? (
                admin.reports
                  .filter((r) => `${r.postTitle} ${r.reason}`.includes(query))
                  .map((r) => (
                    <div key={r.id} className="rounded-2xl bg-surface p-4 mb-3">
                      <span className="text-[11px] font-semibold text-subtle">
                        {r.status === 'OPEN'
                          ? '검토 대기'
                          : r.status === 'RESOLVED'
                            ? '처리 완료'
                            : '기각'}
                      </span>
                      <h2 className="text-[16px] font-bold mt-2">{r.postTitle}</h2>
                      <p className="text-[13px] text-muted mt-2">{r.reason}</p>
                      <p className="text-[11px] text-subtle mt-2">
                        {new Date(r.createdAt).toLocaleString('ko-KR')}
                      </p>
                      {r.status === 'OPEN' && (
                        <div className="flex gap-2 mt-4">
                          <Button
                            disabled={busy}
                            variant="secondary"
                            className="flex-1 !min-h-10 !text-sm !bg-white"
                            onClick={() =>
                              mutation(`/admin/reports/${r.id}`, { status: 'DISMISSED' }, 'PATCH')
                            }
                          >
                            기각
                          </Button>
                          <Button
                            disabled={busy}
                            className="flex-1 !min-h-10 !text-sm"
                            onClick={() =>
                              mutation(`/admin/reports/${r.id}`, { status: 'RESOLVED' }, 'PATCH')
                            }
                          >
                            처리 완료
                          </Button>
                        </div>
                      )}
                    </div>
                  ))
              ) : (
                <EmptyState
                  title="접수된 신고가 없어요"
                  description="신고가 접수되면 여기에서 검토할 수 있어요."
                />
              ))}
            {tab === 'users' &&
              admin.users
                .filter((u) => `${u.name} ${u.nickname}`.includes(query))
                .map((u) => (
                  <button
                    key={u.id}
                    className="w-full flex gap-3 text-left py-4 items-center border-b border-surface"
                    onClick={() => setUser(u)}
                  >
                    <span className="size-10 rounded-full bg-surface flex items-center justify-center">
                      <UserRound size={20} />
                    </span>
                    <span className="flex-1">
                      <span className="text-[15px] font-semibold">{u.nickname}</span>
                      <span className="block text-[12px] text-subtle mt-1">
                        {u.name} ·{' '}
                        {u.role === 'STUDENT' ? '학생' : u.role === 'PARENT' ? '학부모' : '운영자'}
                      </span>
                    </span>
                    <span className={`text-[12px] ${u.suspended ? 'text-danger' : 'text-subtle'}`}>
                      {u.suspended ? '이용 제한' : '정상'}
                    </span>
                  </button>
                ))}
            {tab === 'schools' && (
              <>
                <form onSubmit={addSchool} className="flex gap-2 mb-5">
                  <input
                    aria-label="등록할 학교명"
                    required
                    minLength={2}
                    maxLength={100}
                    className="field"
                    placeholder="학교 이름"
                    value={school}
                    onChange={(e) => setSchool(e.target.value)}
                  />
                  <Button type="submit" disabled={busy} className="shrink-0 !px-4">
                    추가
                  </Button>
                </form>
                {admin.schools
                  .filter((s) => s.name.includes(query))
                  .map((s) => (
                    <div
                      key={s.id}
                      className="flex gap-3 py-4 items-center border-b border-surface"
                    >
                      <School size={20} className="text-subtle" />
                      <span className="text-[15px] font-medium">{s.name}</span>
                    </div>
                  ))}
              </>
            )}
          </>
        )}
      </div>
      <Sheet
        open={!!user}
        onClose={() => setUser(null)}
        title={user?.suspended ? '이용 제한을 해제할까요?' : '이용을 제한할까요?'}
      >
        {user && (
          <>
            <p className="text-[15px] text-muted leading-6 mb-5">
              {user.nickname}님의 계정 상태를 변경해요.
              {!user.suspended && ' 제한하면 계정으로 서비스에 접근할 수 없어요.'}
            </p>
            <Button
              disabled={busy || user.id === data.profile.id}
              className="w-full"
              onClick={async () => {
                if (
                  await mutation(`/admin/users/${user.id}`, { suspended: !user.suspended }, 'PATCH')
                )
                  setUser(null);
              }}
            >
              {user.suspended ? '이용 제한 해제' : '이용 제한'}
            </Button>
            {user.id === data.profile.id && (
              <p className="text-sm text-subtle mt-3">자신의 계정은 제한할 수 없어요.</p>
            )}
          </>
        )}
      </Sheet>
    </>
  );
}
