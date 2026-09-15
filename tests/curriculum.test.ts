import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import {
  CURRICULA,
  curriculumForGrade,
  filterCourses,
  koreanAcademicYear,
  toggleCompletedSubject,
} from '../src/lib/curriculum';

test('curriculum follows enrollment cohort, including the Korean March academic-year boundary', () => {
  assert.equal(koreanAcademicYear(new Date('2026-02-28T14:59:59Z')), 2025);
  assert.equal(koreanAcademicYear(new Date('2026-02-28T15:00:00Z')), 2026);
  assert.equal(curriculumForGrade('고1', 2025), '2022');
  assert.equal(curriculumForGrade('고2', 2025), '2015');
  assert.equal(curriculumForGrade('고2', 2026), '2022');
  assert.equal(curriculumForGrade('고3', 2026), '2015');
  assert.equal(curriculumForGrade('고3', 2027), '2022');
  assert.equal(curriculumForGrade('N수·기타', 2026), null);
  assert.equal(curriculumForGrade('', 2026), null);
});

test('official renamed subjects and kinds remain distinct between the two curricula', () => {
  const course = (version: '2015' | '2022', name: string) =>
    CURRICULA[version].find((c) => c.name === name);
  assert.equal(course('2022', '공통국어2')?.kind, 'common');
  assert.equal(course('2022', '과학탐구실험2')?.kind, 'common');
  assert.equal(course('2022', '기본수학1')?.kind, 'common');
  assert.equal(course('2022', '대수')?.kind, 'general');
  assert.equal(course('2022', '미적분Ⅱ')?.kind, 'career');
  assert.equal(course('2022', '세포와 물질대사')?.kind, 'career');
  assert.equal(course('2022', '기후변화와 환경생태')?.kind, 'convergence');
  assert.equal(course('2022', '프랑스어권 문화')?.kind, 'convergence');
  assert.equal(course('2022', '생명과학Ⅰ'), undefined);
  assert.equal(course('2015', '생명과학Ⅰ')?.kind, 'general');
  assert.equal(course('2015', '생명과학Ⅱ')?.kind, 'career');
  assert.equal(course('2015', '수학Ⅰ')?.kind, 'general');
  assert.equal(course('2015', '기본 수학')?.kind, 'career');
  assert.equal(course('2015', '사회·문화')?.kind, 'general');
  assert.equal(course('2015', '대수'), undefined);
  assert.ok(CURRICULA['2015'].every((c) => c.kind !== 'convergence'));
  for (const courses of Object.values(CURRICULA)) {
    assert.equal(
      new Set(courses.map((c) => c.name)).size,
      courses.length,
      'no duplicated selectable names',
    );
    for (const group of ['체육', '예술', '기술 · 가정 · 정보', '제2외국어 · 한문', '교양']) {
      assert.ok(
        courses.some((c) => c.group === group),
        `${group} must be available`,
      );
    }
  }
});

test('search crosses stage and group filters and tolerates schoolbook spacing and Roman numerals', () => {
  assert.deepEqual(
    filterCourses('2015', 'common', '국어', ' 생명과학 2 ').map((c) => c.name),
    ['생명과학Ⅱ'],
  );
  assert.deepEqual(
    filterCourses('2015', 'common', '', '사회 문화').map((c) => c.name),
    ['사회·문화'],
  );
  assert.deepEqual(
    filterCourses('2022', 'common', '', '미적분II').map((c) => c.name),
    ['미적분Ⅱ'],
  );
  assert.ok(
    filterCourses('2022', 'common', '수학', '').every(
      (c) => c.kind === 'common' && c.group === '수학',
    ),
  );
  assert.equal(
    filterCourses('2022', 'elective', '과학', '').find((c) => c.name === '통합과학1'),
    undefined,
  );
  assert.deepEqual(filterCourses('2022', 'common', '', '존재하지않는과목'), []);
});

test('toggling preserves legacy and custom selections and enforces the existing profile limit', () => {
  const saved = ['통합과학', '공통수학', '학교 탐구'];
  const updated = toggleCompletedSubject(saved, '공통수학1');
  assert.deepEqual(saved, ['통합과학', '공통수학', '학교 탐구']);
  assert.deepEqual(updated, [...saved, '공통수학1']);
  assert.deepEqual(toggleCompletedSubject(updated, '공통수학1'), saved);
  const full = Array.from({ length: 100 }, (_, n) => `학교 과목 ${n}`);
  assert.deepEqual(toggleCompletedSubject(full, '문학'), full);
  assert.equal(toggleCompletedSubject(full, '학교 과목 0').length, 99);
});
after(() => console.log('curriculum verification passed'));
