'use client';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  GraduationCap,
  Heart,
  School,
  Search,
  ShieldCheck,
  X,
} from './icons';
import { Button, IconButton } from './ui';
import { useJourneyLayer } from './journey';
import { api } from '@/lib/api';
import type { ScreenProps } from '@/lib/contracts';
import styles from './onboarding.module.css';

type SchoolOption = { id: string; name: string; address: string };
type Draft = {
  step: number;
  role: '' | 'STUDENT' | 'PARENT';
  nickname: string;
  grade: string;
  school: string;
  schoolId?: string;
};
// Region chips search name+address, and every address starts with the full province name —
// so a short label maps to the literal province string the server can match.
export const SCHOOL_REGIONS: { label: string; q: string }[] = [
  { label: '서울', q: '서울' },
  { label: '경기', q: '경기' },
  { label: '인천', q: '인천' },
  { label: '부산', q: '부산' },
  { label: '대구', q: '대구' },
  { label: '광주', q: '광주' },
  { label: '대전', q: '대전' },
  { label: '울산', q: '울산' },
  { label: '세종', q: '세종' },
  { label: '강원', q: '강원' },
  { label: '충북', q: '충청북도' },
  { label: '충남', q: '충청남도' },
  { label: '전북', q: '전북' },
  { label: '전남', q: '전남' },
  { label: '경북', q: '경상북도' },
  { label: '경남', q: '경상남도' },
  { label: '제주', q: '제주' },
];
const RECENT_SCHOOLS_KEY = 'memoryz:recent-schools';
const MAX_RECENT_SCHOOLS = 3;

export function Highlighted({ text, query }: { text: string; query: string }) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i !== -1) {
      ranges.push([i, i + w.length]);
      i = lower.indexOf(w, i + w.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const out: ReactNode[] = [];
  let pos = 0;
  merged.forEach(([s, e], i) => {
    if (s > pos) out.push(text.slice(pos, s));
    out.push(<mark key={i}>{text.slice(s, e)}</mark>);
    pos = e;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}
const empty: Draft = {
  step: 0,
  role: '',
  nickname: '',
  grade: '',
  school: '',
  schoolId: undefined,
};
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
  const [schools, setSchools] = useState<SchoolOption[]>([]);
  const [schoolStatus, setSchoolStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [schoolSearch, setSchoolSearch] = useState('');
  const [schoolPickerOpen, setSchoolPickerOpen] = useState(false);
  const [schoolRetry, setSchoolRetry] = useState(0);
  const [browse, setBrowse] = useState<SchoolOption[]>([]);
  const [recents, setRecents] = useState<SchoolOption[]>([]);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const schoolInputRef = useRef<HTMLInputElement>(null);
  const schoolTriggerRef = useRef<HTMLButtonElement>(null);
  const closeSchoolPicker = useJourneyLayer(schoolPickerOpen, () => setSchoolPickerOpen(false));
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
    if (!schoolPickerOpen || schoolSearch.trim().length < 2 || draft.step !== 2) {
      setSchools([]);
      setSchoolStatus('idle');
      return;
    }
    const controller = new AbortController();
    setSchools([]);
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
  }, [schoolPickerOpen, schoolSearch, draft.step, schoolRetry]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_SCHOOLS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SchoolOption[];
      setRecents(
        parsed.filter((s) => s && s.id && s.name && s.address).slice(0, MAX_RECENT_SCHOOLS),
      );
    } catch {}
  }, []);
  const browseState = useRef<'idle' | 'loading' | 'done' | 'error'>('idle');
  useEffect(() => {
    if (!schoolPickerOpen || draft.step !== 2) return;
    if (browseState.current === 'loading' || browseState.current === 'done') return;
    browseState.current = 'loading';
    api<SchoolOption[]>('/schools?q=', undefined, 'GET')
      .then((result) => {
        browseState.current = 'done';
        setBrowse(result);
      })
      .catch(() => {
        browseState.current = 'error';
      });
  }, [schoolPickerOpen, draft.step]);
  const selectSchool = (s: SchoolOption) => {
    setDraft((d) => ({ ...d, school: s.name, schoolId: s.id }));
    setRecents((prev) => {
      const next = [s, ...prev.filter((r) => r.id !== s.id)].slice(0, MAX_RECENT_SCHOOLS);
      try {
        localStorage.setItem(RECENT_SCHOOLS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
    schoolInputRef.current?.blur();
    closeSchoolPicker();
  };
  const renderSchoolRow = (s: SchoolOption, query?: string) => (
    <li key={s.id}>
      <button
        type="button"
        className={styles.schoolRow}
        aria-pressed={draft.schoolId === s.id}
        onClick={() => selectSchool(s)}
      >
        <span className={styles.schoolRowIcon}>
          <School size={20} />
        </span>
        <span className={styles.schoolRowText}>
          <strong>{query ? <Highlighted text={s.name} query={query} /> : s.name}</strong>
          <small>{query ? <Highlighted text={s.address} query={query} /> : s.address}</small>
        </span>
        {draft.schoolId === s.id ? <Check size={18} /> : <ChevronRight size={16} />}
      </button>
    </li>
  );
  const valid =
    draft.step === 0
      ? !!draft.role
      : draft.step === 1
        ? draft.nickname.trim().length >= 2
        : parent || !!draft.grade;
  async function advance() {
    if (!valid || busy) return;
    const complete = draft.step === 2;
    const next = { ...draft, nickname: draft.nickname.trim(), step: Math.min(2, draft.step + 1) };
    setBusy(true);
    setError('');
    try {
      if (!saved)
        await api(
          '/onboarding',
          { ...next, school: next.schoolId ? next.school : '', schoolId: next.schoolId, complete },
          'PATCH',
        );
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
    <>
      <main
        className={styles.screen}
        aria-busy={busy}
        // While a school query is being typed, the results outrank the footer (see the module CSS).
        data-searching={schoolPickerOpen ? 'true' : undefined}
      >
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
                    <div className={styles.schoolField}>
                      <div className={styles.schoolLabel}>
                        학교 <span className={styles.optional}>선택</span>
                      </div>
                      <button
                        ref={schoolTriggerRef}
                        type="button"
                        className={styles.schoolTrigger}
                        aria-haspopup="dialog"
                        aria-expanded={schoolPickerOpen}
                        disabled={busy || saved}
                        onClick={() => {
                          setSchoolSearch('');
                          flushSync(() => setSchoolPickerOpen(true));
                          schoolInputRef.current?.focus({ preventScroll: true });
                        }}
                      >
                        <GraduationCap size={22} />
                        <span>
                          <strong>{draft.schoolId ? draft.school : '학교 찾기'}</strong>
                          <small>
                            {draft.schoolId
                              ? '선택한 학교 · 눌러서 변경'
                              : '학교명이나 지역으로 검색해요'}
                          </small>
                        </span>
                        {draft.schoolId ? <Check size={20} /> : <Search size={20} />}
                      </button>
                      {draft.schoolId && (
                        <button
                          type="button"
                          className={styles.schoolRemove}
                          disabled={busy || saved}
                          onClick={() =>
                            setDraft((d) => ({ ...d, school: '', schoolId: undefined }))
                          }
                        >
                          학교 선택 해제
                        </button>
                      )}
                      <p className={styles.help}>학교는 나중에 학교 커뮤니티에서 등록해도 돼요.</p>
                    </div>
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
      <Dialog.Root
        open={schoolPickerOpen}
        onOpenChange={(open) => {
          if (!open) {
            schoolInputRef.current?.blur();
            closeSchoolPicker();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.schoolBackdrop} />
          <Dialog.Content
            className={styles.schoolPicker}
            aria-describedby="onboarding-school-hint"
            data-school-picker
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              schoolInputRef.current?.focus({ preventScroll: true });
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              schoolTriggerRef.current?.focus({ preventScroll: true });
            }}
          >
            {/* When the on-screen keyboard opens for a field, pin that field's label to the top of
              the scrolling content so the field and what follows it (search results) stay visible
              above the keyboard. The screen itself follows the visual viewport
              (onboarding.module.css .screen). */}
            <div className={styles.schoolSearchHeader}>
              <div className={styles.schoolPickerHeading}>
                <IconButton
                  label="학교 찾기 닫기"
                  onClick={() => {
                    schoolInputRef.current?.blur();
                    closeSchoolPicker();
                  }}
                >
                  <ArrowLeft size={22} />
                </IconButton>
                <Dialog.Title>학교 찾기</Dialog.Title>
              </div>
              <label className="sr-only" htmlFor="onboarding-school">
                학교명 또는 지역
              </label>
              <div className="search-field">
                <Search size={19} />
                <input
                  id="onboarding-school"
                  ref={schoolInputRef}
                  type="search"
                  inputMode="search"
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={100}
                  value={schoolSearch}
                  placeholder="학교명 또는 지역으로 검색"
                  aria-describedby="onboarding-school-hint"
                  onChange={(e) => setSchoolSearch(e.target.value)}
                />
                {schoolSearch && (
                  <IconButton
                    label="검색어 지우기"
                    // Clearing keeps the field focused so the keyboard stays for the next query.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSchoolSearch('');
                      schoolInputRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    <X size={16} />
                  </IconButton>
                )}
              </div>
              <p id="onboarding-school-hint">학교명이나 지역을 2자 이상 입력해 주세요.</p>
            </div>
            {/* Results push the field's surroundings around; keep the field pinned as they arrive. */}
            <div className={styles.schoolPickerResults} data-school-results>
              {schoolStatus !== 'idle' && (
                <div role="status" aria-live="polite" className={styles.schoolSearchStatus}>
                  {schoolStatus === 'loading'
                    ? '학교를 찾고 있어요…'
                    : schoolStatus === 'done' && schools.length
                      ? `${schools.length}개 학교 · 주소를 확인해 선택해 주세요.`
                      : null}
                </div>
              )}
              {schoolStatus === 'error' && (
                <div role="alert" className={styles.schoolSearchStatus}>
                  <p>학교를 불러오지 못했어요. 다시 시도해 주세요.</p>
                  <Button variant="ghost" onClick={() => setSchoolRetry((n) => n + 1)}>
                    다시 시도
                  </Button>
                </div>
              )}
              {schoolStatus === 'loading' && (
                <ul className={styles.schoolSkeleton} aria-hidden="true">
                  {Array.from({ length: 6 }, (_, i) => (
                    <li key={i}>
                      <span className={styles.skeletonIcon} />
                      <span className={styles.skeletonLines}>
                        <i />
                        <i />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {schoolStatus === 'done' &&
                schoolSearch.trim().length >= 2 &&
                (schools.length ? (
                  <ul className={styles.schoolResults} data-results-list>
                    {schools.map((s) => renderSchoolRow(s, schoolSearch))}
                  </ul>
                ) : (
                  <div className={styles.schoolEmpty} role="status">
                    <Search size={26} />
                    <strong>검색 결과가 없어요</strong>
                    <p>
                      학교명이나 지역을 바꿔 검색해 주세요.
                      <br />
                      같은 이름의 학교는 주소로 구분할 수 있어요.
                    </p>
                  </div>
                ))}
              {schoolStatus === 'idle' && (
                <>
                  {recents.length > 0 && (
                    <section className={styles.schoolSection}>
                      <h3>최근에 선택한 학교</h3>
                      <ul className={styles.schoolResults}>
                        {recents.map((s) => renderSchoolRow(s))}
                      </ul>
                    </section>
                  )}
                  <section className={styles.schoolSection}>
                    <h3>지역으로 빠르게 찾기</h3>
                    <div
                      className={styles.schoolRegions}
                      role="group"
                      aria-label="지역 빠른 선택"
                    >
                      {SCHOOL_REGIONS.map((r) => (
                        <button
                          key={r.q}
                          type="button"
                          onClick={() => {
                            setSchoolSearch(r.q);
                            schoolInputRef.current?.focus({ preventScroll: true });
                          }}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </section>
                  {browse.length > 0 && (
                    <section className={styles.schoolSection}>
                      <h3>전국 고등학교</h3>
                      <p className={styles.schoolBrowseHint}>
                        같은 이름의 학교는 주소로 구분할 수 있어요.
                      </p>
                      <ul className={styles.schoolResults} data-browse-list>
                        {browse.map((s) => renderSchoolRow(s))}
                      </ul>
                    </section>
                  )}
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
