'use client';
import { useState } from 'react';
import { Check, ChevronRight, Plus, Search, X } from '@/components/icons';
import type { ScreenProps } from '@/lib/contracts';
import { api } from '@/lib/api';
import {
  COURSE_GROUPS,
  COURSE_KIND_LABEL,
  CURRICULA,
  MAX_COMPLETED_SUBJECTS,
  curriculumForGrade,
  filterCourses,
  koreanAcademicYear,
  normalizeCourseName,
  toggleCompletedSubject,
  type CourseStage,
  type CurriculumVersion,
} from '@/lib/curriculum';
import { Button, IconButton, ScreenHeader, Sheet } from '@/components/ui';
import { BusyText, ErrorNote, useAction } from './shared';
import { OptionField } from '@/components/ui-choice';

export function CompletedSubjects(props: ScreenProps) {
  const [academicYear] = useState(() => koreanAcademicYear());
  const [grade, setGrade] = useState(
    /^고[123]$/.test(props.data.profile.grade) ? props.data.profile.grade : '기타',
  );
  const [version, setVersion] = useState<CurriculumVersion>(
    () => curriculumForGrade(props.data.profile.grade, academicYear) ?? '2022',
  );
  const [stage, setStage] = useState<CourseStage>(grade === '고1' ? 'common' : 'elective');
  const [group, setGroup] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>(() => [
    ...new Set(props.data.profile.completedSubjects),
  ]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const action = useAction();
  const courses = filterCourses(version, stage, group, query);
  const recommended = curriculumForGrade(grade, academicYear);
  const toggle = (name: string) => setSelected((current) => toggleCompletedSubject(current, name));
  const customTrimmed = customName.trim();
  const canonicalCustom =
    CURRICULA[version].find(
      (c) => normalizeCourseName(c.name) === normalizeCourseName(customTrimmed),
    )?.name ?? customTrimmed;
  const alreadySelected = selected.some(
    (name) => normalizeCourseName(name) === normalizeCourseName(canonicalCustom),
  );
  const changeGrade = (next: string) => {
    setGrade(next);
    const nextVersion = curriculumForGrade(next, academicYear);
    if (nextVersion) setVersion(nextVersion);
    setStage(next === '고1' ? 'common' : 'elective');
    setGroup('');
    setQuery('');
  };
  return (
    <>
      <ScreenHeader title="배운 과목" back={() => props.back('/study')} />
      <div className="page-inset curriculum-page">
        <h2 className="text-[22px] leading-[1.35] font-bold tracking-[-.035em]">
          배운 과목만 골라 주세요
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          시간표나 교과서의 과목명을 기준으로 골라 주세요.
        </p>
        <div className="curriculum-context">
          <OptionField
            label="과목 목록 기준 학년"
            name="grade"
            value={grade}
            onChange={changeGrade}
            options={[
              { value: '고1', label: '고1' },
              { value: '고2', label: '고2' },
              { value: '고3', label: '고3' },
              { value: '기타', label: '졸업 · 기타' },
            ]}
          />
          <OptionField
            label="교육과정"
            name="curriculum"
            value={version}
            onChange={(next) => {
              setVersion(next as CurriculumVersion);
              setGroup('');
            }}
            options={[
              { value: '2022', label: '2022 개정' },
              { value: '2015', label: '2015 개정' },
            ]}
          />
        </div>
        <p className="curriculum-context-note">
          {recommended
            ? `${academicYear}학년도 ${grade} 학생은 ${recommended} 개정 교육과정이에요.`
            : '2025학년도 이후 입학생은 2022 개정을 선택해 주세요.'}
        </p>
        <div className="curriculum-search">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="과목 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="과목명 검색"
          />
          {query && (
            <IconButton label="검색어 지우기" onClick={() => setQuery('')}>
              <X size={17} />
            </IconButton>
          )}
        </div>
        {!query.trim() && (
          <>
            <div className="segmented-control mt-4" aria-label="과목 구분">
              <button
                className="segment-option"
                aria-pressed={stage === 'common'}
                onClick={() => {
                  setStage('common');
                  setGroup('');
                }}
              >
                공통 과목
              </button>
              <button
                className="segment-option"
                aria-pressed={stage === 'elective'}
                onClick={() => {
                  setStage('elective');
                  setGroup('');
                }}
              >
                선택 과목
              </button>
            </div>
            <p className="curriculum-stage-note">
              {stage === 'common'
                ? '주로 고1 · 학교에 따라 이수 시기가 달라요.'
                : '주로 고2·고3 · 학교에 따라 고1에도 배울 수 있어요.'}
            </p>
          </>
        )}
        <div className="curriculum-filter-summary">
          {!query.trim() && (
            <OptionField
              label="교과 영역"
              name="group"
              compact
              value={group}
              onChange={setGroup}
              options={[
                { value: '', label: '전체 교과' },
                ...COURSE_GROUPS.filter((g) =>
                  CURRICULA[version].some(
                    (c) =>
                      c.group === g &&
                      (stage === 'common' ? c.kind === 'common' : c.kind !== 'common'),
                  ),
                ).map((g) => ({ value: g, label: g })),
              ]}
            />
          )}
          <span aria-live="polite" className="curriculum-result-count">
            {query.trim() ? `전체 과목에서 검색 · ${courses.length}개` : `${courses.length}개 과목`}
          </span>
        </div>
        {!courses.length && (
          <div className="curriculum-empty">
            <p>일치하는 과목이 없어요</p>
            <span>다른 이름이나 교육과정으로 찾아보세요.</span>
            <button
              onClick={() => {
                setCustomName(query.trim());
                setCustomOpen(true);
              }}
            >
              학교 과목 직접 추가 <Plus size={16} />
            </button>
          </div>
        )}
        {COURSE_GROUPS.map((g) => {
          const items = courses.filter((c) => c.group === g);
          if (!items.length) return null;
          return (
            <section className="curriculum-section" key={g} aria-label={g}>
              <h2>{g}</h2>
              {items.map((course) => (
                <button
                  key={course.name}
                  role="checkbox"
                  aria-checked={selected.includes(course.name)}
                  aria-label={course.name}
                  disabled={
                    action.busy ||
                    (!selected.includes(course.name) && selected.length >= MAX_COMPLETED_SUBJECTS)
                  }
                  className="curriculum-course"
                  onClick={() => toggle(course.name)}
                >
                  <span>
                    <strong>{course.name}</strong>
                    <small>
                      {COURSE_KIND_LABEL[course.kind]}
                      {version === '2022' && course.name.startsWith('기본')
                        ? ' · 공통수학·영어 대체 이수'
                        : ''}
                    </small>
                  </span>
                  <span className="curriculum-check" aria-hidden="true">
                    {selected.includes(course.name) && <Check size={14} />}
                  </span>
                </button>
              ))}
            </section>
          );
        })}
        <div className="curriculum-footnote">
          <p>
            보통 교과 기준 목록이에요.
            <br />
            전문 교과나 학교에서 개설한 과목은 직접 추가할 수 있어요.
          </p>
          <button
            onClick={() => {
              setCustomName('');
              setCustomOpen(true);
            }}
          >
            <Plus size={16} /> 학교 과목 직접 추가
          </button>
          <a
            href={
              version === '2022'
                ? 'https://www.ice.go.kr/hakjeom/cm/cntnts/cntntsView.do?cntntsId=272&mi=10083'
                : 'https://www.goe.go.kr/resource/goe/na/bbs_2675/2026/02/a811781f-2e6f-4a1c-a8a0-de23e31896d5.pdf#page=122'
            }
            target="_blank"
            rel="noreferrer"
          >
            교육과정 안내 보기 <ChevronRight size={14} />
          </a>
        </div>
      </div>
      <div className="curriculum-savebar">
        <ErrorNote error={action.error} />
        {selected.length >= MAX_COMPLETED_SUBJECTS && (
          <p className="text-xs text-muted mb-3">
            배운 과목은 최대 {MAX_COMPLETED_SUBJECTS}개까지 선택할 수 있어요.
          </p>
        )}
        <div className="curriculum-save-actions">
          <button
            className="curriculum-selected-summary"
            aria-label={`선택한 과목 ${selected.length}개 확인`}
            onClick={() => setReviewOpen(true)}
          >
            <span>
              선택 <strong>{selected.length}</strong>
            </span>
            <ChevronRight size={16} />
          </button>
          <Button
            className="w-full"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                await api('/profile', { completedSubjects: selected }, 'PATCH');
                await props.refresh();
                props.toast('배운 과목을 저장했어요');
                props.back('/study');
              })
            }
          >
            {action.busy ? <BusyText>저장 중</BusyText> : `${selected.length}과목 저장`}
          </Button>
        </div>
      </div>
      <Sheet
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title={`선택한 과목 ${selected.length}개`}
      >
        <p className="text-[13px] text-muted mb-4">
          이전에 저장한 과목도 그대로 있어요. 아직 배우지 않은 과목은 해제해 주세요.
        </p>
        {selected.length ? (
          selected.map((name) => (
            <button
              key={name}
              className="curriculum-course"
              onClick={() => toggle(name)}
              aria-label={`${name} 선택 해제`}
            >
              <strong>{name}</strong>
              <X size={18} />
            </button>
          ))
        ) : (
          <p className="py-8 text-center text-muted">선택한 과목이 없어요</p>
        )}
        <Button className="w-full mt-6" onClick={() => setReviewOpen(false)}>
          확인
        </Button>
      </Sheet>
      <Sheet open={customOpen} onClose={() => setCustomOpen(false)} title="학교 과목 직접 추가">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!customTrimmed || alreadySelected || selected.length >= MAX_COMPLETED_SUBJECTS)
              return;
            setSelected((current) => [...current, canonicalCustom]);
            setCustomOpen(false);
          }}
        >
          <p className="text-sm text-muted mb-5">
            전문 교과나 학교에서 따로 배운 과목을 시간표에 적힌 이름으로 추가해 주세요.
          </p>
          <label className="text-sm font-semibold">
            과목 이름
            <input
              autoFocus
              className="field mt-2"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              maxLength={60}
              placeholder="예: 프로그래밍"
            />
          </label>
          {alreadySelected && <p className="text-sm text-muted mt-3">이미 선택한 과목이에요.</p>}
          <Button
            type="submit"
            className="w-full mt-6"
            disabled={
              !customTrimmed || alreadySelected || selected.length >= MAX_COMPLETED_SUBJECTS
            }
          >
            선택한 과목에 추가
          </Button>
        </form>
      </Sheet>
    </>
  );
}
