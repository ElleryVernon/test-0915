'use client';
import { useEffect, useState } from 'react';
import { ArrowRight, GraduationCap, Search, ShieldCheck } from '@/components/icons';
import { Button, ScreenHeader } from './ui';
import { api } from '@/lib/api';
import type { ScreenProps } from '@/lib/contracts';
export default function Onboarding({ data, navigate, refresh, toast }: ScreenProps) {
  const [parent] = useState(data.profile.role === 'PARENT');
  const [nickname, setNickname] = useState(data.profile.nickname);
  const [name, setName] = useState(data.profile.name);
  const [grade, setGrade] = useState(data.profile.grade || '고2');
  const [school, setSchool] = useState(data.profile.school);
  const [schools, setSchools] = useState<{ id: string; name: string }[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (school.trim().length < 2) return;
    const c = new AbortController();
    const t = setTimeout(
      () =>
        fetch(`/api/schools?q=${encodeURIComponent(school)}`, { signal: c.signal })
          .then((r) => r.json())
          .then((r) => setSchools(Array.isArray(r.data) ? r.data : (r.data?.schools ?? [])))
          .catch(() => {}),
      200,
    );
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [school]);
  async function save() {
    setError('');
    setBusy(true);
    try {
      if (parent) await api('/link', { code });
      else await api('/profile', { name, nickname, grade, school }, 'PATCH');
      await refresh();
      navigate(parent ? '/parent' : '/');
      toast(parent ? '자녀와 연결했어요' : '나만의 학습 공간이 준비됐어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ScreenHeader title="나에게 맞게 시작하기" />
      <div className="page-inset pt-4">
        <span className="w-14 h-14 flex items-center justify-center rounded-2xl bg-surface text-secondary mb-6">
          {parent ? <ShieldCheck size={27} /> : <GraduationCap size={28} />}
        </span>
        <h1 className="page-title">
          {parent ? (
            <>
              자녀의 공부를
              <br />
              따뜻하게 응원해요
            </>
          ) : (
            <>
              어디에서
              <br />
              공부하고 있나요?
            </>
          )}
        </h1>
        <p className="text-muted text-sm mt-3 mb-8">
          {parent
            ? '자녀의 마이 화면에서 만든 6자리 연결 코드를 입력해 주세요.'
            : '학년과 학교에 맞는 나만의 학습 공간을 만들어 드려요.'}
        </p>
        {parent ? (
          <label className="block">
            <span className="eyebrow">6자리 연결 코드</span>
            <input
              className="field mt-2 text-center !text-3xl tracking-[.3em]"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
            />
            <p className="text-xs text-muted mt-3">
              코드는 10분 동안 유효해요. 자녀가 공개한 학습 정보만 볼 수 있어요.
            </p>
          </label>
        ) : (
          <div className="stack">
            <label>
              <span className="eyebrow">이름</span>
              <input
                className="field mt-2"
                maxLength={30}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              <span className="eyebrow">닉네임</span>
              <input
                className="field mt-2"
                maxLength={20}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </label>
            <fieldset>
              <legend className="eyebrow mb-2">학년</legend>
              <div className="grid grid-cols-4 gap-2">
                {['고1', '고2', '고3', 'N수 / 기타'].map((g) => (
                  <button
                    type="button"
                    key={g}
                    className="pill justify-center !rounded-xl !px-2 !text-sm"
                    onClick={() => setGrade(g)}
                    aria-pressed={grade === g}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </fieldset>
            <label>
              <span className="eyebrow">학교</span>
              <div className="search-field mt-2">
                <Search size={19} />
                <input
                  value={school}
                  onChange={(e) => setSchool(e.target.value)}
                  placeholder="학교 이름으로 검색"
                  maxLength={60}
                />
              </div>
            </label>
            {schools
              .filter((s) => s.name !== school)
              .slice(0, 4)
              .map((s) => (
                <button
                  key={s.id}
                  className="text-left px-4 py-3 bg-canvas rounded-xl"
                  onClick={() => {
                    setSchool(s.name);
                    setSchools([]);
                  }}
                >
                  {s.name}
                </button>
              ))}
          </div>
        )}
        {error && (
          <p className="error-banner mt-5" role="alert">
            {error}
          </p>
        )}
        <Button
          className="w-full mt-8"
          disabled={
            busy ||
            (parent ? code.length !== 6 : !name.trim() || !nickname.trim() || !school.trim())
          }
          onClick={save}
        >
          {busy ? '저장하는 중…' : parent ? '자녀와 연결하기' : '시작하기'}
          <ArrowRight size={18} />
        </Button>
        {parent && (
          <Button variant="ghost" className="w-full mt-2" onClick={() => navigate('/parent')}>
            나중에 연결하고 둘러보기
          </Button>
        )}
      </div>
    </>
  );
}
