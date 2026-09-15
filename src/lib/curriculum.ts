/** National ordinary high-school courses. Sources and exclusions: docs/CURRICULUM.md. */
export type CurriculumVersion = '2022' | '2015';
export type CourseKind = 'common' | 'general' | 'career' | 'convergence';
export type CourseStage = 'common' | 'elective';
export type CurriculumCourse = { name: string; group: string; kind: CourseKind };
type CourseGroup = { group: string } & Partial<Record<CourseKind, string[]>>;
export const COURSE_KIND_LABEL: Record<CourseKind, string> = {
  common: '공통 과목',
  general: '일반 선택',
  career: '진로 선택',
  convergence: '융합 선택',
};
const languages = [
  '독일어',
  '프랑스어',
  '스페인어',
  '중국어',
  '일본어',
  '러시아어',
  '아랍어',
  '베트남어',
];
const groups2022: CourseGroup[] = [
  {
    group: '국어',
    common: ['공통국어1', '공통국어2'],
    general: ['화법과 언어', '독서와 작문', '문학'],
    career: ['주제 탐구 독서', '문학과 영상', '직무 의사소통'],
    convergence: ['독서 토론과 글쓰기', '매체 의사소통', '언어생활 탐구'],
  },
  {
    group: '수학',
    common: ['공통수학1', '공통수학2', '기본수학1', '기본수학2'],
    general: ['대수', '미적분Ⅰ', '확률과 통계'],
    career: ['기하', '미적분Ⅱ', '경제 수학', '인공지능 수학', '직무 수학'],
    convergence: ['수학과 문화', '실용 통계', '수학과제 탐구'],
  },
  {
    group: '영어',
    common: ['공통영어1', '공통영어2', '기본영어1', '기본영어2'],
    general: ['영어Ⅰ', '영어Ⅱ', '영어 독해와 작문'],
    career: [
      '영미 문학 읽기',
      '영어 발표와 토론',
      '심화 영어',
      '심화 영어 독해와 작문',
      '직무 영어',
    ],
    convergence: ['실생활 영어 회화', '미디어 영어', '세계 문화와 영어'],
  },
  {
    group: '사회 · 역사 · 도덕',
    common: ['한국사1', '한국사2', '통합사회1', '통합사회2'],
    general: ['세계시민과 지리', '세계사', '사회와 문화', '현대사회와 윤리'],
    career: [
      '한국지리 탐구',
      '도시의 미래 탐구',
      '동아시아 역사 기행',
      '정치',
      '법과 사회',
      '경제',
      '윤리와 사상',
      '인문학과 윤리',
      '국제 관계의 이해',
    ],
    convergence: [
      '여행지리',
      '역사로 탐구하는 현대 세계',
      '사회문제 탐구',
      '금융과 경제생활',
      '윤리문제 탐구',
      '기후변화와 지속가능한 세계',
    ],
  },
  {
    group: '과학',
    common: ['통합과학1', '통합과학2', '과학탐구실험1', '과학탐구실험2'],
    general: ['물리학', '화학', '생명과학', '지구과학'],
    career: [
      '역학과 에너지',
      '전자기와 양자',
      '물질과 에너지',
      '화학 반응의 세계',
      '세포와 물질대사',
      '생물의 유전',
      '지구시스템과학',
      '행성우주과학',
    ],
    convergence: ['과학의 역사와 문화', '기후변화와 환경생태', '융합과학 탐구'],
  },
  {
    group: '체육',
    general: ['체육1', '체육2'],
    career: ['운동과 건강', '스포츠 문화', '스포츠 과학'],
    convergence: ['스포츠 생활1', '스포츠 생활2'],
  },
  {
    group: '예술',
    general: ['음악', '미술', '연극'],
    career: ['음악 연주와 창작', '음악 감상과 비평', '미술 창작', '미술 감상과 비평'],
    convergence: ['음악과 미디어', '미술과 매체'],
  },
  {
    group: '기술 · 가정 · 정보',
    general: ['기술·가정', '정보'],
    career: ['로봇과 공학세계', '생활과학 탐구', '인공지능 기초', '데이터 과학'],
    convergence: [
      '창의 공학 설계',
      '지식 재산 일반',
      '생애 설계와 자립',
      '아동발달과 부모',
      '소프트웨어와 생활',
    ],
  },
  {
    group: '제2외국어 · 한문',
    general: [...languages, '한문'],
    career: [
      ...languages.map((n) => `${n} 회화`),
      ...languages.map((n) => `심화 ${n}`),
      '한문 고전 읽기',
    ],
    convergence: [
      '독일어권 문화',
      '프랑스어권 문화',
      '스페인어권 문화',
      '중국 문화',
      '일본 문화',
      '러시아 문화',
      '아랍 문화',
      '베트남 문화',
      '언어생활과 한자',
    ],
  },
  {
    group: '교양',
    general: ['진로와 직업', '생태와 환경'],
    career: ['인간과 철학', '논리와 사고', '인간과 심리', '교육의 이해', '삶과 종교', '보건'],
    convergence: ['인간과 경제활동', '논술'],
  },
];
const groups2015: CourseGroup[] = [
  {
    group: '국어',
    common: ['국어'],
    general: ['화법과 작문', '독서', '언어와 매체', '문학'],
    career: ['실용 국어', '심화 국어', '고전 읽기'],
  },
  {
    group: '수학',
    common: ['수학'],
    general: ['수학Ⅰ', '수학Ⅱ', '미적분', '확률과 통계'],
    career: ['기본 수학', '실용 수학', '인공지능 수학', '기하', '경제 수학', '수학과제 탐구'],
  },
  {
    group: '영어',
    common: ['영어'],
    general: ['영어 회화', '영어Ⅰ', '영어Ⅱ', '영어 독해와 작문'],
    career: ['기본 영어', '실용 영어', '영어권 문화', '진로 영어', '영미 문학 읽기'],
  },
  {
    group: '사회 · 역사 · 도덕',
    common: ['한국사', '통합사회'],
    general: [
      '한국지리',
      '세계지리',
      '세계사',
      '동아시아사',
      '경제',
      '정치와 법',
      '사회·문화',
      '생활과 윤리',
      '윤리와 사상',
    ],
    career: ['여행지리', '사회문제 탐구', '고전과 윤리'],
  },
  {
    group: '과학',
    common: ['통합과학', '과학탐구실험'],
    general: ['물리학Ⅰ', '화학Ⅰ', '생명과학Ⅰ', '지구과학Ⅰ'],
    career: ['물리학Ⅱ', '화학Ⅱ', '생명과학Ⅱ', '지구과학Ⅱ', '과학사', '생활과 과학', '융합과학'],
  },
  { group: '체육', general: ['체육', '운동과 건강'], career: ['스포츠 생활', '체육 탐구'] },
  {
    group: '예술',
    general: ['음악', '미술', '연극'],
    career: ['음악 연주', '음악 감상과 비평', '미술 창작', '미술 감상과 비평'],
  },
  {
    group: '기술 · 가정 · 정보',
    general: ['기술·가정', '정보'],
    career: [
      '농업 생명 과학',
      '공학 일반',
      '창의 경영',
      '해양 문화와 기술',
      '가정과학',
      '지식 재산 일반',
      '인공지능 기초',
    ],
  },
  {
    group: '제2외국어 · 한문',
    general: [...languages.map((n) => `${n}Ⅰ`), '한문Ⅰ'],
    career: [...languages.map((n) => `${n}Ⅱ`), '한문Ⅱ'],
  },
  {
    group: '교양',
    general: [
      '철학',
      '논리학',
      '심리학',
      '교육학',
      '종교학',
      '진로와 직업',
      '보건',
      '환경',
      '실용 경제',
      '논술',
    ],
  },
];
const flatten = (groups: CourseGroup[]): CurriculumCourse[] =>
  groups.flatMap((group) =>
    (Object.keys(COURSE_KIND_LABEL) as CourseKind[]).flatMap((kind) =>
      (group[kind] ?? []).map((name) => ({ name, group: group.group, kind })),
    ),
  );
export const CURRICULA: Record<CurriculumVersion, CurriculumCourse[]> = {
  '2022': flatten(groups2022),
  '2015': flatten(groups2015),
};
export const COURSE_GROUPS = groups2022.map((g) => g.group);
export function koreanAcademicYear(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')!.value);
  return year - (Number(parts.find((p) => p.type === 'month')!.value) < 3 ? 1 : 0);
}
export function curriculumForGrade(grade: string, academicYear: number): CurriculumVersion | null {
  const number = /^고([123])$/.exec(grade)?.[1];
  if (!number) return null;
  return academicYear - Number(number) + 1 >= 2025 ? '2022' : '2015';
}
export const normalizeCourseName = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/iii/g, '3')
    .replace(/ii/g, '2')
    .replace(/i/g, '1')
    .replace(/[\s·ㆍ]/g, '');
export function filterCourses(
  version: CurriculumVersion,
  stage: CourseStage,
  group: string,
  query: string,
) {
  const search = normalizeCourseName(query);
  return CURRICULA[version].filter((course) =>
    search
      ? normalizeCourseName(course.name).includes(search)
      : (stage === 'common' ? course.kind === 'common' : course.kind !== 'common') &&
        (!group || course.group === group),
  );
}
export const MAX_COMPLETED_SUBJECTS = 100;
export function toggleCompletedSubject(selected: string[], name: string): string[] {
  return selected.includes(name)
    ? selected.filter((s) => s !== name)
    : selected.length < MAX_COMPLETED_SUBJECTS
      ? [...selected, name]
      : selected;
}
