'use client';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  GraduationCap,
  Heart,
  Search,
  ShieldCheck,
  X,
} from './icons';
import { Button, IconButton } from './ui';
import { api } from '@/lib/api';
import type { ScreenProps } from '@/lib/contracts';
import styles from './onboarding.module.css';

type Draft = {
  step: number;
  role: '' | 'STUDENT' | 'PARENT';
  nickname: string;
  grade: string;
  school: string;
  schoolId?: string;
};
const empty: Draft = { step: 0, role: '', nickname: '', grade: '', school: '', schoolId: undefined };
const steps = ['이용 목적', '프로필', '시작 준비'];
export default function Onboarding({
  refresh,
  navigate,
  data,
  onExit,
}: ScreenProps & { onExit: () => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>(empty);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [schools, setSchools] = useState<{ id: string; name: string; address: string }[]>([]);
  const [schoolStatus, setSchoolStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [schoolSearch, setSchoolSearch] = useState('');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const parent = draft.role === 'PARENT';
  async function load() {
    setError('');
    try {
      const result = await api<{ draft: Partial<Draft>; complete: boolean }>('/onboarding');
      if (result.complete) {
        await refresh();
        navigate(data.profile.role === 'PARENT' ? '/parent' : '/study', { replace: true });
        return;
      }
      setDraft({ ...empty, ...result.draft });
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (loaded) titleRef.current?.focus({ preventScroll: true });
  }, [draft.step, loaded]);
  useEffect(() => {
    if (schoolSearch.trim().length < 2 || draft.step !== 2) {
      setSchools([]);
      setSchoolStatus('idle');
      return;
    }
    const controller = new AbortController();
    setSchoolStatus('loading');
    // User-paced debounce, cancelled when the query or step changes.
    const timer = window.setTimeout(async () => {
      try {
        const result = await api<{ id: string; name: string; address: string }[]>(
          `/schools?q=${encodeURIComponent(schoolSearch.trim())}`,
          undefined,
          'GET',
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setSchools(result);
          setSchoolStatus('done');
        }
      } catch {
        if (!controller.signal.aborted) {
          setSchools([]);
          setSchoolStatus('error');
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [schoolSearch, draft.step]);
  const valid =
    draft.step === 0
      ? !!draft.role
      : draft.step === 1
        ? draft.nickname.trim().length >= 2
        : parent || (!!draft.grade && (!draft.school.trim() || !!draft.schoolId));
  async function advance() {
    if (!valid || busy) return;
    const complete = draft.step === 2;
    const next = { ...draft, nickname: draft.nickname.trim(), step: Math.min(2, draft.step + 1) };
    setBusy(true);
    setError('');
    try {
      if (!saved) await api('/onboarding', { ...next, complete }, 'PATCH');
      if (complete) {
        setSaved(true);
        await refresh();
        navigate(parent ? '/parent' : '/study', { replace: true });
      } else {
        setDraft(next);
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function previous() {
    if (!busy && !saved) {
      setError('');
      setDraft((d) => ({ ...d, step: Math.max(0, d.step - 1) }));
    }
  }
  return (
    <main className={styles.screen} aria-busy={busy}>
      <header className={styles.header}>
        {draft.step > 0 ? (
          <IconButton label="이전 단계로 돌아가기" onClick={previous} disabled={busy || saved}>
            <ArrowLeft size={23} />
          </IconButton>
        ) : (
          <IconButton label="로그아웃하고 나중에 계속하기" onClick={onExit} disabled={busy}>
            <X size={23} />
          </IconButton>
        )}
        <span>시작하기</span>
        <span className={styles.secure}>
          <ShieldCheck size={17} />
        </span>
      </header>
      <ol className={styles.steps} aria-label="가입 설정 단계">
        {steps.map((s, i) => (
          <li
            key={s}
            data-current={i === draft.step}
            data-done={i < draft.step}
            aria-current={i === draft.step ? 'step' : undefined}
          >
            <span>{i < draft.step ? <Check size={13} /> : i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      {!loaded ? (
        <section className={styles.content}>
          {error ? (
            <div className="error-banner" role="alert">
              {error}
              <Button variant="ghost" onClick={load}>
                다시 불러오기
              </Button>
            </div>
          ) : (
            <p role="status">이어서 설정할 내용을 불러오고 있어요…</p>
          )}
        </section>
      ) : (
        <>
          <section key={draft.step} className={styles.content}>
            <h1 ref={titleRef} tabIndex={-1}>
              {draft.step === 0 ? (
                <>
                  어떻게 memoryz를
                  <br />
                  사용하고 싶나요?
                </>
              ) : draft.step === 1 ? (
                <>
                  어떤 이름으로
                  <br />
                  불러 드릴까요?
                </>
              ) : parent ? (
                <>
                  자녀의 공부를
                  <br />
                  함께 응원해요
                </>
              ) : (
                <>
                  지금의 학습에
                  <br />
                  맞춰 준비할게요
                </>
              )}
            </h1>
            <p className={styles.description}>
              {draft.step === 0
                ? '선택한 역할에 맞는 공간을 준비해 드려요.'
                : draft.step === 1
                  ? '커뮤니티에 표시할 닉네임이에요.\n실명 대신 편한 이름을 사용해도 좋아요.'
                  : parent
                    ? '자녀가 공유한 학습 현황을 확인하고,\n응원과 포인트를 보낼 수 있어요.'
                    : '학년에 맞는 학습과 학교 커뮤니티에 사용해요.\n학교는 나중에 마이에서 추가해도 괜찮아요.'}
            </p>
            {draft.step === 0 && (
              <fieldset className={styles.roles}>
                <legend className="sr-only">이용 목적</legend>
                {(['STUDENT', 'PARENT'] as const).map((role) => (
                  <label key={role} className={styles.role} data-selected={draft.role === role}>
                    <input
                      type="radio"
                      name="onboarding-role"
                      value={role}
                      checked={draft.role === role}
                      onChange={() => setDraft((d) => ({ ...d, role }))}
                    />
                    <span className={styles.roleIcon}>
                      {role === 'STUDENT' ? <GraduationCap size={26} /> : <Heart size={25} />}
                    </span>
                    <span className={styles.roleCopy}>
                      <strong>
                        {role === 'STUDENT' ? '직접 공부할게요' : '자녀의 공부를 응원할게요'}
                      </strong>
                      <span>
                        {role === 'STUDENT'
                          ? '내 자료로 문제를 풀고 복습해요'
                          : '학습 현황을 함께 확인해요'}
                      </span>
                    </span>
                    <span className={styles.choiceMark}>
                      {draft.role === role && <Check size={15} />}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {draft.step === 1 && (
              <div className={styles.fields}>
                <label htmlFor="onboarding-nickname">닉네임</label>
                <input
                  id="onboarding-nickname"
                  className="field"
                  autoComplete="nickname"
                  maxLength={20}
                  value={draft.nickname}
                  placeholder="예: 꾸준히배우는중"
                  onChange={(e) => {
                    setError('');
                    setDraft((d) => ({ ...d, nickname: e.target.value }));
                  }}
                  aria-describedby="nickname-help"
                />
                <p id="nickname-help" className={styles.help}>
                  2~20자 · 나중에 마이에서 바꿀 수 있어요
                </p>
                <div className={styles.note}>
                  <ShieldCheck size={19} />
                  <p>
                    로그인 계정의 이름과 연락처는
                    <br />
                    커뮤니티에 공개하지 않아요.
                  </p>
                </div>
              </div>
            )}
            {draft.step === 2 &&
              (parent ? (
                <div className={styles.parentGuide}>
                  <h2>자녀 연결은 이렇게 해요</h2>
                  <ol>
                    <li>
                      <span>1</span>
                      <p>
                        자녀가 마이에서<strong>연결 코드를 만들어요.</strong>
                      </p>
                    </li>
                    <li>
                      <span>2</span>
                      <p>
                        학부모 홈에서<strong>6자리 코드를 입력해요.</strong>
                      </p>
                    </li>
                  </ol>
                  <div className={styles.note}>
                    <ShieldCheck size={20} />
                    <p>
                      자녀가 공개한 정보만 볼 수 있어요.
                      <br />
                      지금 코드가 없어도 시작할 수 있어요.
                    </p>
                  </div>
                </div>
              ) : (
                <div className={styles.fields}>
                  <fieldset>
                    <legend>학년</legend>
                    <div className={styles.grades}>
                      {['고1', '고2', '고3', 'N수/기타'].map((g) => (
                        <button
                          type="button"
                          key={g}
                          aria-pressed={draft.grade === g}
                          onClick={() => setDraft((d) => ({ ...d, grade: g }))}
                        >
                          {g}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label htmlFor="onboarding-school">
                    학교 <span className={styles.optional}>선택</span>
                  </label>
                  <div className="search-field">
                    <Search size={19} />
                    <input
                      id="onboarding-school"
                      value={draft.school}
                      placeholder="학교명 또는 지역으로 검색"
                      maxLength={100}
                      autoComplete="off"
                      onChange={(e) => {
                        setDraft((d) => ({ ...d, school: e.target.value, schoolId: undefined }));
                        setSchoolSearch(e.target.value);
                      }}
                    />
                    {draft.school && (
                      <IconButton
                        label="학교 입력 지우기"
                        onClick={() => {
                          setDraft((d) => ({ ...d, school: '', schoolId: undefined }));
                          setSchoolSearch('');
                        }}
                      >
                        <X size={16} />
                      </IconButton>
                    )}
                  </div>
                  <div className={styles.schoolResults} aria-live="polite">
                    {schoolStatus === 'loading' ? (
                      <p>학교를 찾고 있어요…</p>
                    ) : schoolStatus === 'error' ? (
                      <p>검색을 불러오지 못했어요. 검색어를 다시 입력해 주세요.</p>
                    ) : schoolStatus === 'done' && schools.length === 0 ? (
                      <p>검색 결과가 없어요. 학교명이나 지역을 바꿔 검색해 주세요.</p>
                    ) : (
                      schools.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => {
                            setDraft((d) => ({ ...d, school: s.name, schoolId: s.id }));
                            setSchoolSearch('');
                          }}
                        >
                          <GraduationCap size={20} />
                          <span>{s.name}<small style={{ display: 'block', fontWeight: 400 }}>{s.address}</small></span>
                          <ArrowRight size={16} />
                        </button>
                      ))
                    )}
                  </div>
                  {draft.schoolId && <p className={styles.help}>학교 선택 완료 · {draft.school}</p>}
                  {!draft.school && (
                    <p className={styles.help}>
                      학교는 나중에 학교 커뮤니티에서 등록해도 돼요.
                    </p>
                  )}
                </div>
              ))}
          </section>
          <footer className={styles.footer}>
            {error && (
              <div role="alert" className="error-banner">
                {error}
                {saved && <p>설정은 저장됐어요. 아래 버튼으로 다시 연결해 주세요.</p>}
              </div>
            )}
            <Button className="w-full" onClick={advance} disabled={!valid || busy}>
              {busy
                ? '저장하는 중…'
                : saved
                  ? '내 공간으로 연결하기'
                  : draft.step < 2
                    ? '다음 단계로'
                    : parent
                      ? '학부모 홈으로'
                      : '내 학습 시작하기'}
              {!busy && <ArrowRight size={18} />}
            </Button>
            <p>
              {draft.step < 2
                ? '완료한 단계는 저장돼요. 나중에 이어서 설정할 수 있어요.'
                : parent
                  ? '자녀 연결은 학부모 홈에서 할 수 있어요.'
                  : '예제로 먼저 체험하거나, 내 자료로 바로 시작할 수 있어요.'}
            </p>
          </footer>
        </>
      )}
    </main>
  );
}
