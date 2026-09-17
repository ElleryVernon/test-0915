'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  ChevronRight,
  ChevronDown,
  BookOpen,
  Layers,
  PencilLine,
  ListChecks,
  Check,
  MoreHorizontal,
  FileText,
  Upload,
  Camera,
  Trash2,
  Search,
  FolderOpen,
  Sparkles,
  Sigma,
  Atom,
  Languages,
  Globe,
} from '@/components/icons';
import type { ScreenProps, Material, Subject } from '@/lib/contracts';
import { Button, EmptyState, IconButton, Sheet } from '@/components/ui';
import { api } from '@/lib/api';
import { useRetryCountdown, waitingLabel } from '@/lib/retry-countdown';
import { mergeSavedMaterial, rememberSavedMaterial, useMaterialDetail } from '@/lib/materials';
import { seoulDateKey } from '@/lib/home';
import {
  acknowledgeAiTask,
  AiTaskFailureError,
  AiTaskPendingError,
  runAiTask,
  type AiTaskRecord,
} from '@/lib/ai-task';
import { generatedItemCount, type GenerationMode } from './logic';
import {
  examCountdown,
  materialMeta,
  studyMethods,
  subjectInsight,
  subjectSummary,
} from './insights';
import {
  BusyText,
  Chip,
  ErrorNote,
  GenerationSheet,
  MaterialIcon,
  MaterialViewer,
  params,
  uploadFile,
  useAction,
} from './shared';
import { useJourneyState } from '../journey';
import { StudyHeader } from './study-header';
import { Checkbox } from '@/components/ui-choice';
import { DateField } from '@/components/ui-date';
import { ActionGroup, ActionRow } from '@/components/ui-content';
import library from './study-library.module.css';
import { CardLibrary } from './card-library';
import { soleUploadSubject, studyOnboarding } from '@/lib/study-onboarding';
import { StudyOnboarding } from './study-onboarding';
import { StudyLibraryEntry } from './library-entry';
import { FirstLearningWelcome } from './first-learning';
import { firstLearning } from '@/lib/first-learning';
import { StudyInvitation } from './study-invitation';
import { LearningFolders } from './learning-folders';
import { UNFILED_MATERIALS } from '@/lib/material-folders';

export function SubjectGlyph({ name }: { name: string }) {
  return /수학|미적분|대수/.test(name) ? (
    <Sigma size={21} />
  ) : /과학|생물|생명|물리|화학/.test(name) ? (
    <Atom size={21} />
  ) : /영어|국어|문학/.test(name) ? (
    <Languages size={21} />
  ) : /사회|역사|지리/.test(name) ? (
    <Globe size={21} />
  ) : (
    <BookOpen size={21} />
  );
}
const METHOD_ICONS = { quiz: BookOpen, essay: PencilLine, wrong: ListChecks, cards: Layers };
const EXAM_NAMES = ['중간고사', '기말고사', '모의고사', '수행평가'];
const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Seoul',
  });

/** Start with a usable source; expose the learning hub once there is something to study. */
export function StudyHome(props: ScreenProps) {
  const [addingSubject, setAddingSubject] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [generation, setGeneration] = useState<GenerationMode | null>(null);
  const { phase } = studyOnboarding(props.data);
  const welcome =
    firstLearning(props.data).showWelcome && params(props.path).get('methods') !== '1';
  function createFirstCard() {
    if (!props.data.subjects.length) setAddingSubject(true);
    else props.navigate('/create-card');
  }
  useEffect(() => {
    if (params(props.path).get('upload') === 'camera') {
      props.navigate('/subjects?upload=camera', { replace: true });
    }
  }, [props.path, props.navigate]);
  const methods = studyMethods(props.data);
  const features = [
    { key: 'cards', label: '플래시카드', description: '기억할 개념을 차근차근 복습해요' },
    { key: 'essay', label: '서술형 도우미', description: '생각을 정리하고 답안을 완성해요' },
    { key: 'quiz', label: '문제은행', description: '내 자료로 만든 문제를 풀어요' },
    { key: 'wrong', label: '오답노트', description: '헷갈린 개념을 다시 확인해요' },
  ] as const;
  return (
    <>
      <StudyHeader title="학습" large />
      <div className={library.home} data-study-home>
        {welcome ? (
          <FirstLearningWelcome props={props} onAddSource={() => setSourceOpen(true)} />
        ) : phase !== 'ready' ? (
          <StudyOnboarding
            props={props}
            onAddSource={() => setSourceOpen(true)}
            onGenerate={setGeneration}
            onManualCard={createFirstCard}
          />
        ) : (
          <>
            <StudyInvitation props={props} />
            <section className={library.section} aria-labelledby="study-methods-heading">
              <h2 id="study-methods-heading" className={library.methodsHeading}>
                원하는 방식으로 공부하기
              </h2>
              <nav className={library.featureGrid} aria-label="학습 방법">
                {features.map((feature) => {
                  const method = methods.find((item) => item.key === feature.key)!;
                  const Icon = METHOD_ICONS[feature.key];
                  return (
                    <button
                      type="button"
                      key={feature.key}
                      className={library.feature}
                      onClick={() => props.navigate(method.path)}
                    >
                      <span className={library.featureTop}>
                        <Icon size={26} aria-hidden="true" />
                        <ChevronRight size={17} aria-hidden="true" />
                      </span>
                      <strong>{feature.label}</strong>
                      <span className={library.featureDescription}>{feature.description}</span>
                      <small>{method.meta}</small>
                    </button>
                  );
                })}
              </nav>
            </section>
          </>
        )}
        <StudyLibraryEntry onClick={() => props.navigate('/subjects')} />
      </div>
      {sourceOpen && (
        <SourceUploadFlow props={props} onClose={() => setSourceOpen(false)} sourceOnly />
      )}
      {addingSubject && (
        <SubjectEditor
          open
          onClose={() => setAddingSubject(false)}
          props={props}
          nextStep="card"
          onCreated={(subject) => {
            setAddingSubject(false);
            props.navigate(`/create-card?subject=${subject.id}`);
          }}
        />
      )}
      {generation && (
        <GenerationSheet
          key={generation}
          open
          onClose={() => setGeneration(null)}
          props={props}
          mode={generation}
        />
      )}
    </>
  );
}

/** Reused in feature landing headers, never during an active exercise. */
export function StudyLibraryAction({ props }: { props: ScreenProps }) {
  return (
    <button
      type="button"
      className={library.libraryAction}
      onClick={() => props.navigate('/subjects')}
    >
      <FolderOpen size={17} aria-hidden="true" />내 과목·자료
    </button>
  );
}

export function StudySubjectLibrary(props: ScreenProps) {
  const [unfiled, setUnfiled] = useState(false);
  const [unfiledMaterial, setUnfiledMaterial] = useState<Material | null>(null);
  const [add, setAdd] = useState(
    params(props.path).get('create') === 'card' && !props.data.subjects.length,
  );
  const [create, setCreate] = useState(false);
  const [manage, setManage] = useState(false);
  const [editingSubject, setEditingSubject] = useState<Subject | null>(null);
  const [cardSetup, setCardSetup] = useState(params(props.path).get('create') === 'card');
  const [uploadIntent, setUploadIntent] = useState<'file' | 'camera' | null>(() => {
    const upload = params(props.path).get('upload');
    return upload === 'camera' ? 'camera' : upload === '1' ? 'file' : null;
  });
  useEffect(() => {
    const query = params(props.path);
    if (query.get('create') === 'card' && props.data.subjects.length) {
      props.navigate('/create-card', { replace: true });
    } else if (query.has('upload') || query.get('create') === 'card') {
      // Consume the entry intent without remounting the active setup sheet. Closing it must
      // not make it return on refresh or after an unrelated subject is created later.
      props.navigate('/subjects', { replace: true, keepScreen: true });
    }
  }, [props.path, props.navigate, props.data.subjects.length]);
  function createCard() {
    setCreate(false);
    if (props.data.subjects.length) props.navigate('/create-card');
    else {
      setCardSetup(true);
      setAdd(true);
    }
  }
  const [semesterOpen, setSemesterOpen] = useState(false);
  const [semester, setSemester] = useJourneyState('study.semester', '');
  const now = Date.now();
  const subjects = props.data.subjects.filter((s) => !semester || s.semester === semester);
  const semesters = [...new Set(props.data.subjects.map((s) => s.semester))];
  return (
    <>
      <StudyHeader
        title="내 과목·자료"
        back={() => props.back('/study')}
        action={
          <>
            <IconButton label="학습 검색" onClick={() => props.navigate('/search')}>
              <Search size={22} />
            </IconButton>
            <IconButton label="만들기" onClick={() => setCreate(true)}>
              <Plus size={24} />
            </IconButton>
          </>
        }
      />
      <div className={library.home} data-study-home>
        <section className={library.section} aria-labelledby="study-subjects-title">
          <div className={library.heading}>
            <h2 id="study-subjects-title">과목 폴더</h2>
            <button type="button" onClick={() => setManage(true)}>
              과목 관리
            </button>
          </div>
          <div className={library.toolbar}>
            {semesters.length > 0 && (
              <button
                className="study-chip"
                aria-haspopup="dialog"
                onClick={() => setSemesterOpen(true)}
              >
                {semester || '전체 학기'}
                <ChevronDown size={12} />
              </button>
            )}
          </div>
          <div>
            {(subjects.length > 0 || (!semester && props.data.materials.length > 0)) && (
              <LearningFolders
                data={props.data}
                mode="materials"
                semester={semester}
                now={now}
                onSelect={(id) =>
                  id === UNFILED_MATERIALS ? setUnfiled(true) : props.navigate(`/subjects/${id}`)
                }
              />
            )}
            {!subjects.length && !(!semester && props.data.materials.length > 0) && (
              <div className={library.empty}>
                <p>
                  {props.data.subjects.length
                    ? '이 학기에 등록한 과목이 없어요.'
                    : '공부할 과목과 첫 자료를 추가해 보세요.'}
                </p>
                {props.data.subjects.length ? (
                  <Button
                    variant="secondary"
                    className="mt-3 w-full"
                    onClick={() => setSemester('')}
                  >
                    전체 학기 보기
                  </Button>
                ) : (
                  <Button className="mt-3 w-full" onClick={() => setUploadIntent('file')}>
                    첫 과목 폴더 만들기
                  </Button>
                )}
              </div>
            )}
            {subjects.length > 0 && (
              <button type="button" className={library.addFolder} onClick={() => setAdd(true)}>
                <Plus size={18} />새 과목 폴더
              </button>
            )}
          </div>
        </section>
      </div>
      <Sheet open={unfiled} onClose={() => setUnfiled(false)} title="과목 미지정 자료">
        <p className={library.manageIntro}>
          과목 정보를 찾을 수 없는 자료예요. 저장한 원문은 계속 확인할 수 있어요.
        </p>
        <div className="study-options">
          {props.data.materials
            .filter(
              (material) =>
                !props.data.subjects.some((subject) => subject.id === material.subjectId),
            )
            .map((material) => (
              <button
                key={material.id}
                type="button"
                onClick={() => {
                  setUnfiled(false);
                  setUnfiledMaterial(material);
                }}
              >
                <MaterialIcon type={material.type} />
                <span>{material.title}</span>
                <ChevronRight size={18} />
              </button>
            ))}
        </div>
      </Sheet>
      <MaterialViewer
        material={unfiledMaterial}
        onClose={() => {
          setUnfiledMaterial(null);
          setUnfiled(true);
        }}
      />
      <Sheet open={manage} onClose={() => setManage(false)} title="과목 관리">
        <div className={library.manage}>
          <section>
            <div className={library.heading}>
              <h3>공부 중인 과목</h3>
              <span>{props.data.subjects.length}개</span>
            </div>
            <p className={library.manageIntro}>과목별로 자료·문제·카드를 모아 두는 공간이에요.</p>
            {[...props.data.subjects]
              .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }))
              .map((s) => (
                <button
                  key={s.id}
                  className={library.subjectRow}
                  onClick={() => {
                    setManage(false);
                    setEditingSubject(s);
                  }}
                >
                  <span className={library.subjectCopy}>
                    <strong>{s.name}</strong>
                    <small>{s.semester || '학기 미지정'}</small>
                  </span>
                  <span className="text-xs text-muted">설정</span>
                  <ChevronRight size={16} />
                </button>
              ))}
            <Button
              variant="secondary"
              className="w-full mt-3"
              onClick={() => {
                setManage(false);
                setAdd(true);
              }}
            >
              <Plus size={18} />
              공부할 과목 추가
            </Button>
          </section>
          <section className={library.history}>
            <button
              onClick={() => {
                setManage(false);
                props.navigate('/completed-subjects');
              }}
            >
              <span>이전에 배운 과목 · {props.data.profile.completedSubjects.length}개</span>
              <ChevronRight size={18} />
            </button>
            <p>이수한 과목을 학습 이력으로 기록해요. 자료를 담는 내 과목과는 별도로 저장돼요.</p>
          </section>
        </div>
      </Sheet>
      {(add || editingSubject) && (
        <SubjectEditor
          key={editingSubject?.id || 'new'}
          open
          onClose={() => {
            setAdd(false);
            setEditingSubject(null);
            setCardSetup(false);
          }}
          props={props}
          subject={editingSubject || undefined}
          nextStep="card"
          onCreated={
            cardSetup
              ? (subject) => {
                  setAdd(false);
                  setCardSetup(false);
                  props.navigate(`/create-card?subject=${subject.id}`);
                }
              : (subject) => {
                  setAdd(false);
                  props.navigate(`/subjects/${subject.id}`);
                }
          }
        />
      )}
      <CreateSheet
        open={create}
        onClose={() => setCreate(false)}
        props={props}
        onUpload={() => {
          setCreate(false);
          setUploadIntent('file');
        }}
        onCreateCard={createCard}
        onAddSubject={() => {
          setCreate(false);
          setAdd(true);
        }}
      />
      {uploadIntent && (
        <SourceUploadFlow
          props={props}
          onClose={() => setUploadIntent(null)}
          capture={uploadIntent === 'camera'}
        />
      )}
      <Sheet open={semesterOpen} onClose={() => setSemesterOpen(false)} title="학기 선택">
        <div className="study-options">
          {['', ...semesters].map((value) => (
            <button
              key={value || 'all'}
              aria-pressed={semester === value}
              onClick={() => {
                setSemester(value);
                setSemesterOpen(false);
              }}
            >
              <span>{value || '전체 학기'}</span>
              {semester === value && <Check size={20} />}
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}

function CreateSheet({
  open,
  onClose,
  props,
  onAddSubject,
  onUpload,
  onCreateCard,
}: {
  open: boolean;
  onClose: () => void;
  props: ScreenProps;
  onAddSubject: () => void;
  onUpload: () => void;
  onCreateCard: () => void;
}) {
  const subjects = props.data.subjects;
  return (
    <Sheet open={open} onClose={onClose} title="무엇을 만들까요?">
      <div className="study-create">
        <button onClick={onUpload}>
          <span className="study-create-icon">
            <Upload size={22} />
          </span>
          <span className="study-create-copy">
            <strong>자료 올리기</strong>
            <small>
              {subjects.length
                ? '필기·PDF·사진에서 문제와 카드를 만들어요'
                : '과목을 먼저 만든 뒤 올릴 수 있어요'}
            </small>
          </span>
          <ChevronRight size={18} className="text-disabled" />
        </button>
        <button onClick={onAddSubject}>
          <span className="study-create-icon">
            <Plus size={22} />
          </span>
          <span className="study-create-copy">
            <strong>과목 추가</strong>
            <small>새 과목의 자료 보관함을 만들어요</small>
          </span>
          <ChevronRight size={18} className="text-disabled" />
        </button>
        <button onClick={onCreateCard}>
          <span className="study-create-icon">
            <Layers size={22} />
          </span>
          <span className="study-create-copy">
            <strong>카드 만들기</strong>
            <small>개념·관계·비교·가림 카드를 직접 만들어요</small>
          </span>
          <ChevronRight size={18} className="text-disabled" />
        </button>
      </div>
    </Sheet>
  );
}

/** Shared source intake for first use, the library menu and the home camera shortcut. */
function SourceUploadFlow({
  props,
  onClose,
  capture = false,
  sourceOnly = false,
}: {
  props: ScreenProps;
  onClose: () => void;
  capture?: boolean;
  sourceOnly?: boolean;
}) {
  const [subject, setSubject] = useState(() =>
    soleUploadSubject(props.data.subjects, props.data.materials),
  );
  const [creating, setCreating] = useState(!props.data.subjects.length);
  if (subject)
    return (
      <UploadSheet
        open
        props={props}
        subject={subject}
        onClose={onClose}
        capture={capture}
        sourceOnly={sourceOnly}
      />
    );
  if (creating)
    return (
      <SubjectEditor
        open
        props={props}
        onClose={onClose}
        onCreated={(saved) => {
          setCreating(false);
          setSubject(saved);
        }}
      />
    );
  return (
    <Sheet open onClose={onClose} title="자료를 담을 폴더 선택">
      <p className={library.manageIntro}>
        과목 폴더에 자료를 모아 두면 문제와 카드도 함께 정리돼요.
      </p>
      <div className="study-options">
        {[...props.data.subjects]
          .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
          .map((item) => (
            <button type="button" key={item.id} onClick={() => setSubject(item)}>
              <FolderOpen size={21} />
              <span>
                {item.name}
                <small className={library.uploadFolderMeta}>
                  {item.semester || '학기 미지정'} · 자료{' '}
                  {props.data.materials.filter((material) => material.subjectId === item.id).length}
                  개
                </small>
              </span>
              <ChevronRight size={18} />
            </button>
          ))}
        <button type="button" onClick={() => setCreating(true)}>
          <span>새 과목 폴더 만들기</span>
          <Plus size={18} />
        </button>
      </div>
    </Sheet>
  );
}

function SubjectEditor({
  open,
  onClose,
  props,
  subject,
  onCreated,
  nextStep = 'source',
}: {
  open: boolean;
  onClose: () => void;
  props: ScreenProps;
  subject?: Subject;
  onCreated?: (subject: Subject) => void;
  nextStep?: 'source' | 'card';
}) {
  const [name, setName] = useState(subject?.name || '');
  const [examName, setExamName] = useState(subject?.examDate ? subject.examName || '' : '');
  const [examDate, setExamDate] = useState(subject?.examDate || '');
  const [deleting, setDeleting] = useState(false);
  const action = useAction();
  const past = !!examDate && examDate < seoulDateKey(new Date());
  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!action.busy) onClose();
      }}
      title={subject ? '과목 설정' : '어떤 과목을 공부하나요?'}
    >
      <div className={`space-y-5 ${library.editor}`}>
        {onCreated && (
          <p className="text-sm text-muted leading-relaxed">
            {nextStep === 'card'
              ? '카드를 담을 과목을 먼저 만들어요. 다음 화면에서 카드를 직접 작성할 수 있어요.'
              : '자료를 정리할 과목을 먼저 만들어요. 다음 화면에서 필기나 파일을 추가할 수 있어요.'}
          </p>
        )}
        <label className="block text-sm font-semibold">
          과목 이름
          <input
            autoFocus
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            className="field mt-2"
            placeholder="예: 생명과학"
          />
        </label>
        {!subject && (
          <div className="flex flex-wrap gap-2">
            {['국어', '수학', '영어', '생명과학', '화학', '한국사'].map((n) => (
              <Chip key={n} active={name === n} onClick={() => setName(n)}>
                {n}
              </Chip>
            ))}
          </div>
        )}
        <details className={library.exam} open={!!subject?.examDate}>
          <summary>
            시험 일정 <span>선택</span>
            <ChevronDown size={16} />
          </summary>
          <fieldset className="study-exam">
            <legend>
              시험 일정 <small>선택</small>
            </legend>
            <div className="flex flex-wrap gap-2">
              {EXAM_NAMES.map((n) => (
                <Chip
                  key={n}
                  active={examName === n}
                  onClick={() => setExamName(examName === n ? '' : n)}
                >
                  {n}
                </Chip>
              ))}
            </div>
            <input
              className="field"
              value={examName}
              maxLength={20}
              onChange={(e) => setExamName(e.target.value)}
              placeholder="시험 이름 (비우면 '시험')"
              aria-label="시험 이름"
            />
            <DateField
              label="시험 날짜"
              name="exam-date"
              value={examDate}
              onChange={setExamDate}
              clearable
            />
            {past && <p className="study-exam-note">지난 날짜라 D-day 가 보이지 않아요.</p>}
            {examDate && (
              <button
                type="button"
                className="study-exam-clear"
                onClick={() => {
                  setExamDate('');
                  setExamName('');
                }}
              >
                시험 일정 지우기
              </button>
            )}
          </fieldset>
        </details>
        <ErrorNote error={action.error} />
        <Button
          className="w-full"
          disabled={!name.trim() || action.busy}
          onClick={() =>
            action.run(async () => {
              const exam = examDate
                ? { examDate, examName: examName.trim() || null }
                : subject?.examDate
                  ? { examDate: null }
                  : {};
              const savedSubject = await api<Subject>(
                subject ? `/subjects/${subject.id}` : '/subjects',
                { name: name.trim(), ...exam },
                subject ? 'PATCH' : 'POST',
              );
              await props.refresh();
              if (!subject && onCreated) onCreated(savedSubject);
              else onClose();
              props.toast(subject ? '과목 설정을 저장했어요' : '새 과목을 만들었어요');
            })
          }
        >
          {action.busy ? (
            <BusyText>저장 중</BusyText>
          ) : subject ? (
            '변경 사항 저장'
          ) : onCreated ? (
            nextStep === 'card' ? (
              '과목 만들고 카드 작성'
            ) : (
              '과목 만들고 자료 추가'
            )
          ) : (
            '과목 만들기'
          )}
        </Button>
        {subject && (
          <>
            {!deleting ? (
              <Button variant="ghost" className="w-full" onClick={() => setDeleting(true)}>
                과목 삭제
              </Button>
            ) : (
              <div className="rounded-2xl bg-surface p-4">
                <p className="text-sm leading-relaxed">
                  {subject.name} 안의 자료, 문제, 카드도 함께 보이지 않게 돼요. 이 과목을
                  삭제할까요?
                </p>
                <div className="mt-3 flex gap-2">
                  <Button variant="secondary" className="flex-1" onClick={() => setDeleting(false)}>
                    취소
                  </Button>
                  <Button
                    className="flex-1 !bg-danger"
                    disabled={action.busy}
                    onClick={() =>
                      action.run(async () => {
                        await api(`/subjects/${subject.id}`, {}, 'DELETE');
                        await props.refresh();
                        onClose();
                        props.navigate('/study');
                        props.toast('과목을 삭제했어요');
                      })
                    }
                  >
                    삭제하기
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
export function SubjectDetail(props: ScreenProps) {
  const subjectId = props.path.split('?')[0].split('/')[2];
  const subject = props.data.subjects.find((s) => s.id === subjectId);
  const [tab, setTab] = useJourneyState('subject.tab', '자료');
  const [settings, setSettings] = useState(false);
  const [upload, setUpload] = useState(params(props.path).get('upload') === '1');
  const [selectedId, setSelectedId] = useJourneyState<string | null>(
    'subject.material',
    params(props.path).get('material'),
  );
  const selected =
    props.data.materials.find((m) => m.id === selectedId && m.subjectId === subjectId) ?? null;
  const setSelected = (material: Material | null) => setSelectedId(material?.id ?? null);
  const [view, setView] = useState(false);
  const [edit, setEdit] = useState(params(props.path).get('edit') === '1');
  const [generation, setGeneration] = useState<'quiz' | 'essay' | 'cards' | null>(null);
  const [deleteMaterial, setDeleteMaterial] = useState(false);
  const action = useAction();
  if (!subject)
    return (
      <>
        <StudyHeader title="내 과목" back={() => props.back('/study')} />
        <EmptyState
          title="과목을 찾을 수 없어요"
          description="삭제되었거나 다른 계정의 과목이에요."
          action={<Button onClick={() => props.navigate('/study')}>내 과목으로</Button>}
        />
      </>
    );
  const now = Date.now();
  const materials = props.data.materials.filter((m) => m.subjectId === subject.id);
  const questions = props.data.questions.filter((q) => q.subjectId === subject.id);
  const essays = props.data.essays.filter((essay) => essay.subjectId === subject.id);
  const cards = props.data.cards.filter((c) => c.subjectId === subject.id && !c.deleted);
  const summary = subjectSummary(props.data, subject.id, now);
  const exam = examCountdown(subject, new Date(now));
  const insight = subjectInsight(summary, exam);
  return (
    <>
      <StudyHeader
        back={() => props.back('/subjects')}
        action={
          <IconButton label="과목 설정" onClick={() => setSettings(true)}>
            <MoreHorizontal size={24} />
          </IconButton>
        }
      />
      <div className={`page-inset subject-detail${tab === '자료' ? ' has-fixed-cta' : ''}`}>
        <nav className={library.folderPath} aria-label="과목 폴더 경로">
          <button type="button" onClick={() => props.navigate('/subjects')}>
            내 과목·자료
          </button>
          <ChevronRight size={14} aria-hidden="true" />
          <span aria-current="location">{subject.name}</span>
        </nav>
        <p className="subject-detail-eyebrow">
          {subject.semester}
          {exam && <span className="study-dday">{exam.label}</span>}
        </p>
        <h1 className="subject-detail-title">{subject.name}</h1>
        <p className="subject-detail-meta">
          자료 {summary.materials} · 문제 {summary.questions + summary.essays} · 카드{' '}
          {summary.cards}
          {summary.due > 0 && (
            <>
              {' · '}
              <b>오늘 복습 {summary.due}장</b>
            </>
          )}
        </p>
        <div className="subject-tabs">
          {[
            ['자료', materials.length],
            ['문제', questions.length + essays.length],
            ['카드', cards.length],
          ].map(([label, n]) => (
            <Chip key={label} active={tab === label} onClick={() => setTab(String(label))}>
              {label}
              <span className="subject-tab-count">{n}</span>
            </Chip>
          ))}
        </div>
        {tab === '자료' ? (
          <div className="subject-materials">
            {materials.map((m) => {
              const meta = materialMeta(props.data, m.id);
              return (
                <button
                  key={m.id}
                  data-material-id={m.id}
                  onClick={() => {
                    setSelected(m);
                    setDeleteMaterial(false);
                  }}
                  className="material-library-row"
                >
                  <span className="material-library-icon">
                    <MaterialIcon type={m.type} />
                  </span>
                  <span className="material-library-copy">
                    <span>{m.title}</span>
                    <small className={meta.empty ? 'is-next' : undefined}>
                      {dayLabel(m.createdAt)} · {meta.text}
                    </small>
                  </span>
                  <ChevronRight size={18} className="shrink-0 text-disabled" />
                </button>
              );
            })}
            {!materials.length && (
              <EmptyState
                title="첫 자료를 올려 주세요"
                description="수업 필기, 교과서 PDF, 정리한 글에서 학습이 시작돼요."
              />
            )}
            {insight && (
              <div className="subject-insight">
                <Sparkles size={22} />
                <span className="subject-insight-copy">
                  <strong>{insight.title}</strong>
                  <small>{insight.description}</small>
                </span>
                <button onClick={() => setGeneration('quiz')}>만들기</button>
              </div>
            )}
          </div>
        ) : tab === '문제' ? (
          <div className="mt-6 space-y-4">
            {questions.length ? (
              <>
                <p className="text-sm text-muted">
                  객관식 {questions.length}문제 · 서술형 {essays.length}문제
                </p>
                {questions.slice(0, 8).map((q, i) => (
                  <button
                    key={q.id}
                    onClick={() => props.navigate(`/quiz?question=${q.id}`)}
                    className="flex min-h-16 w-full gap-3 text-left"
                  >
                    <span className="pt-0.5 text-sm font-bold text-disabled">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="flex-1 text-[15px] font-semibold leading-relaxed">
                      {q.prompt}
                    </span>
                    <ChevronRight size={18} className="mt-1 shrink-0 text-disabled" />
                  </button>
                ))}
                <Button
                  className="w-full"
                  onClick={() => props.navigate(`/quiz?subject=${subject.id}`)}
                >
                  이 과목 문제 풀기
                </Button>
              </>
            ) : (
              <EmptyState
                title={
                  essays.length ? `서술형 ${essays.length}문제가 있어요` : '아직 만든 문제가 없어요'
                }
                description={
                  essays.length
                    ? '아래 서술형 도우미에서 문제를 확인할 수 있어요.'
                    : '자료를 선택하고 AI로 문제를 만들어 보세요.'
                }
              />
            )}
            <Button variant="secondary" className="w-full" onClick={() => setGeneration('quiz')}>
              문제 만들기
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => props.navigate(`/essay?subject=${subject.id}`)}
            >
              서술형 도우미{essays.length ? ` · ${essays.length}문제` : ''}
            </Button>
          </div>
        ) : (
          <CardLibrary props={props} subjectId={subject.id} />
        )}
      </div>
      {tab === '자료' && (
        <div className="study-fixed-cta above-nav">
          <Button className="w-full" onClick={() => setUpload(true)}>
            <Upload size={18} />이 폴더에 자료 추가
          </Button>
        </div>
      )}
      <SubjectEditor
        open={settings}
        onClose={() => setSettings(false)}
        props={props}
        subject={subject}
      />
      <UploadSheet
        key={String(upload)}
        open={upload}
        onClose={() => setUpload(false)}
        props={props}
        subject={subject}
        capture={params(props.path).get('capture') === '1'}
      />
      <Sheet
        open={!!selected && !view && !edit && !generation}
        onClose={() => setSelected(null)}
        title={selected?.title || '자료'}
      >
        {selected && (
          <div className="space-y-5">
            <div>
              <p className="mb-4 text-sm text-muted">
                객관식 {questions.filter((q) => q.materialId === selected.id).length}개{' · '}서술형{' '}
                {props.data.essays.filter((q) => q.materialId === selected.id).length}개
              </p>
              <Button
                className="w-full"
                onClick={() =>
                  questions.some((q) => q.materialId === selected.id)
                    ? props.navigate(`/quiz?material=${selected.id}`)
                    : setGeneration('quiz')
                }
              >
                <BookOpen size={18} />
                {questions.some((q) => q.materialId === selected.id)
                  ? '문제 풀기'
                  : '첫 문제 만들기'}
              </Button>
              {props.data.essays.some((e) => e.materialId === selected.id) && (
                <Button
                  className="mt-2 w-full"
                  variant="secondary"
                  onClick={() => props.navigate(`/essay?material=${selected.id}`)}
                >
                  <PencilLine size={18} />
                  서술형 코칭
                </Button>
              )}
            </div>
            <ActionGroup label="자료 관리">
              <ActionRow
                icon={<FileText size={19} />}
                data-material-open
                onClick={() => setView(true)}
              >
                원본 보기
              </ActionRow>
              {selected.extraction !== 'combined' && (
                <ActionRow icon={<PencilLine size={19} />} onClick={() => setEdit(true)}>
                  제목 · 본문 수정
                </ActionRow>
              )}
            </ActionGroup>
            <ActionGroup label="학습 콘텐츠 만들기">
              {questions.some((q) => q.materialId === selected.id) && (
                <ActionRow icon={<BookOpen size={19} />} onClick={() => setGeneration('quiz')}>
                  문제 더 만들기
                </ActionRow>
              )}
              <ActionRow icon={<PencilLine size={19} />} onClick={() => setGeneration('essay')}>
                {props.data.essays.some((q) => q.materialId === selected.id)
                  ? '서술형 더 만들기'
                  : '서술형 만들기'}
              </ActionRow>
              <ActionRow icon={<Layers size={19} />} onClick={() => setGeneration('cards')}>
                복습 카드 만들기
              </ActionRow>
            </ActionGroup>
            <ErrorNote error={action.error} />
            {deleteMaterial ? (
              <div className="rounded-2xl bg-surface p-4">
                <p className="mb-3 text-sm">이 자료와 연결된 문제를 삭제할까요?</p>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    className="flex-1"
                    onClick={() => setDeleteMaterial(false)}
                  >
                    취소
                  </Button>
                  <Button
                    className="flex-1"
                    disabled={action.busy}
                    onClick={() =>
                      action.run(async () => {
                        await api(`/materials/${selected.id}`, {}, 'DELETE');
                        await props.refresh();
                        setSelected(null);
                        props.toast('자료를 삭제했어요');
                      })
                    }
                  >
                    삭제하기
                  </Button>
                </div>
              </div>
            ) : (
              <div className="pt-3">
                <ActionRow
                  danger
                  icon={<Trash2 size={19} />}
                  onClick={() => setDeleteMaterial(true)}
                >
                  자료 삭제
                </ActionRow>
              </div>
            )}
          </div>
        )}
      </Sheet>
      <MaterialViewer material={view ? selected : null} onClose={() => setView(false)} />
      {selected && edit && (
        <MaterialEdit
          material={selected}
          props={props}
          onClose={() => setEdit(false)}
          onSaved={(m) => {
            setSelected(m);
            setEdit(false);
          }}
        />
      )}
      {generation && (
        <GenerationSheet
          key={`${generation}:${selected?.id}`}
          open
          onClose={() => setGeneration(null)}
          props={props}
          initialMaterial={selected?.id || materials[0]?.id}
          mode={generation}
        />
      )}
    </>
  );
}
function MaterialEdit({
  material,
  props,
  onClose,
  onSaved,
}: {
  material: Material;
  props: ScreenProps;
  onClose: () => void;
  onSaved: (m: Material) => void;
}) {
  const [title, setTitle] = useState(material.title);
  const [content, setContent] = useState(material.content ?? '');
  // Bootstrap carries only a summary; the editor needs the body before it can show or save it.
  const body = useMaterialDetail(material.content === undefined ? material : null);
  const [loaded, setLoaded] = useState(material.content !== undefined);
  useEffect(() => {
    if (body.detail && !loaded) {
      setContent(body.detail.content);
      setLoaded(true);
    }
  }, [body.detail, loaded]);
  const action = useAction();
  return (
    <Sheet open onClose={onClose} title="자료 수정">
      <div className="space-y-4">
        <label className="block text-sm font-semibold">
          제목
          <input
            className="field mt-2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={160}
          />
        </label>
        <label className="block text-sm font-semibold">
          학습 본문
          <textarea
            className="field mt-2 min-h-56 resize-y"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={100000}
            placeholder={loaded ? '문제를 만들 원문을 입력해 주세요' : '본문을 불러오고 있어요'}
            disabled={!loaded}
          />
        </label>
        <ErrorNote error={action.error || body.error} />
        <Button
          className="w-full"
          disabled={!title.trim() || action.busy || !loaded}
          onClick={() =>
            action.run(async () => {
              const saved = await api<Material>(
                `/materials/${material.id}`,
                { title: title.trim(), content },
                'PATCH',
              );
              // The edit changed the hash, so the old entry is never read again; the new body is here,
              // and a file's images and page count come from the detail this editor loaded.
              rememberSavedMaterial(saved, body.detail);
              await props.refresh();
              // The answer alone would drop the file's page and image counts from the meta line.
              onSaved(mergeSavedMaterial(material, saved));
              props.toast('자료를 수정했어요');
            })
          }
        >
          {action.busy ? <BusyText>저장 중</BusyText> : '저장하기'}
        </Button>
      </div>
    </Sheet>
  );
}
function UploadSheet({
  open,
  onClose,
  props,
  subject,
  capture = false,
  sourceOnly = false,
}: {
  open: boolean;
  onClose: () => void;
  props: ScreenProps;
  subject: Subject;
  /** Opened from home's "사진 찍기": the camera comes first and reads as the main action. */
  capture?: boolean;
  /** First-use onboarding separates saving a source from choosing a learning method. */
  sourceOnly?: boolean;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [generate, setGenerate] = useState(false);
  const [essay, setEssay] = useState(false);
  const [progress, setProgress] = useState('');
  const [saved, setSaved] = useState<Material | null>(null);
  const [generated, setGenerated] = useState<string[]>([]);
  const [uncertainStage, setUncertainStage] = useState(false);
  const [task, setTask] = useState<AiTaskRecord | null>(null);
  // A retry after a failed save reuses the upload instead of sending the file again.
  const uploaded = useRef<{ file: File; result: Awaited<ReturnType<typeof uploadFile>> } | null>(
    null,
  );
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const action = useAction();
  // A refused upload or generation that said when to come back keeps the button waiting.
  const retryIn = useRetryCountdown(action.retryAt, task?.retryAt);
  // jitter: none — a serial upload, save, and 2-3 generation chain a person starts; uneven stages already spread devices, waits live in uploadFile and runAiTask [site src/components/study/subjects.tsx:960]
  async function save() {
    let material = saved;
    if (!material) {
      setProgress(file ? '자료를 올리고 있어요' : '자료를 저장하고 있어요');
      if (file && uploaded.current?.file !== file)
        uploaded.current = { file, result: await uploadFile(file) };
      const upload = file ? uploaded.current?.result : undefined;
      // The server decides the type and keeps page offsets only while the text is the extracted one.
      material = await api<Material>('/materials', {
        subjectId: subject.id,
        title: title.trim() || upload?.title || '제목 없는 자료',
        content: content.trim() || upload?.content || '',
        type: upload?.type || 'TXT',
        uploadId: upload?.uploadId,
      });
      // The answer already carries the body this screen just sent; a file's images are not in it.
      rememberSavedMaterial(material);
      setSaved(material);
      await props.refresh();
      if (upload?.warning) props.toast(upload.warning);
    }
    if (generate) {
      const stages = [
        { mode: 'quiz', label: '자료에서 문제를 만들고 있어요' },
        { mode: 'cards', label: '복습 카드를 만들고 있어요' },
        ...(essay ? [{ mode: 'essay', label: '서술형 문제를 만들고 있어요' }] : []),
      ];
      for (const stage of stages) {
        if (generated.includes(stage.mode)) {
          await props.refresh();
          await acknowledgeAiTask({
            userId: props.data.profile.id,
            endpoint: '/generate',
            payload: { materialId: material.id, mode: stage.mode, count: 5 },
          });
          continue;
        }
        setProgress(stage.label);
        try {
          const response = await runAiTask({
            userId: props.data.profile.id,
            endpoint: '/generate',
            payload: { materialId: material.id, mode: stage.mode, count: 5 },
            retryFailed: task?.status === 'FAILED' || task?.status === 'INTERRUPTED',
            onStatus: setTask,
          });
          generatedItemCount(response, stage.mode as GenerationMode, 5);
          setUncertainStage(false);
        } catch (error) {
          if (error instanceof AiTaskPendingError || error instanceof AiTaskFailureError) {
            setTask(error.task);
            setUncertainStage(error instanceof AiTaskPendingError);
          }
          throw error;
        }
        setGenerated((current) => [...current, stage.mode]);
        await props.refresh();
        await acknowledgeAiTask({
          userId: props.data.profile.id,
          endpoint: '/generate',
          payload: { materialId: material.id, mode: stage.mode, count: 5 },
        });
      }
    }
    props.toast(generate ? '학습 자료를 만들었어요' : '자료를 저장했어요');
    onClose();
  }
  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!action.busy) onClose();
      }}
      title={`${subject.name} 자료 올리기`}
    >
      <div className="space-y-5">
        <p className="text-[14px] leading-relaxed text-muted">
          수업 노트를 올리거나 글을 붙여 넣어 주세요. 자료 하나가 문제와 복습 카드로 이어져요.
        </p>
        <input
          ref={input}
          type="file"
          accept=".pdf,.txt,image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              setFile(f);
              if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
              setSaved(null);
            }
          }}
        />
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              setFile(f);
              if (!title) setTitle('수업 노트');
              setSaved(null);
            }
          }}
        />
        <div className={`grid grid-cols-2 gap-3${capture ? ' upload-capture-first' : ''}`}>
          <button
            className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl bg-surface text-sm font-bold"
            disabled={!!saved || action.busy}
            onClick={() => input.current?.click()}
          >
            <Upload size={24} />
            파일 선택
          </button>
          <button
            className={`flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl text-sm font-bold${capture ? ' upload-capture-main' : ' bg-surface'}`}
            disabled={!!saved || action.busy}
            onClick={() => camera.current?.click()}
          >
            <Camera size={24} />
            사진 촬영
          </button>
        </div>
        {file && (
          <div className="flex items-center gap-3 text-sm">
            <FileText size={21} />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="text-xs text-muted">{(file.size / 1024 / 1024).toFixed(1)}MB</span>
            <IconButton
              label="파일 선택 취소"
              disabled={!!saved || action.busy}
              onClick={() => setFile(null)}
            >
              <Trash2 size={17} />
            </IconButton>
          </div>
        )}
        <label className="block text-sm font-semibold">
          자료 제목
          <input
            className="field mt-2"
            value={title}
            disabled={!!saved || action.busy}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={160}
            placeholder="예: 3단원 세포와 에너지"
          />
        </label>
        <label className="block text-sm font-semibold">
          본문 {file ? '(선택)' : ''}
          <textarea
            className="field mt-2 min-h-32 resize-y"
            value={content}
            disabled={!!saved || action.busy}
            onChange={(e) => setContent(e.target.value)}
            maxLength={100000}
            placeholder={
              file
                ? '파일에서 읽을 수 없는 내용을 보완해 주세요'
                : '교과서나 수업 필기를 붙여 넣어 주세요'
            }
          />
        </label>
        {!sourceOnly && (
          <Checkbox
            name="generate"
            checked={generate}
            disabled={!props.data.aiAvailable || action.busy}
            onChange={setGenerate}
          >
            문제와 복습 카드 함께 만들기
          </Checkbox>
        )}
        {generate && (
          <Checkbox
            name="essay"
            checked={essay}
            disabled={action.busy}
            onChange={setEssay}
            className="font-medium"
          >
            서술형 4단계 코칭도 만들기
          </Checkbox>
        )}
        {!props.data.aiAvailable && (
          <p className="text-xs leading-relaxed text-muted">
            자료는 바로 저장할 수 있어요. AI 문제 생성은 연결 준비가 끝나면 이용할 수 있어요.
          </p>
        )}
        {saved && action.error && (
          <div className="space-y-2 rounded-2xl bg-surface p-4">
            <p className="text-sm font-semibold">원본 자료는 저장되었어요.</p>
            <p className="text-xs leading-relaxed text-muted">
              완료된 단계는 다시 만들지 않아요. 자료함에서 바로 학습할 수 있어요.
            </p>
            <div className="flex flex-wrap gap-2 text-xs font-semibold">
              {[['quiz', '문제'], ['cards', '카드'], ...(essay ? [['essay', '서술형']] : [])].map(
                ([mode, label]) => (
                  <span key={mode}>
                    {label} {generated.includes(mode) ? '완료' : '대기'}
                  </span>
                ),
              )}
            </div>
          </div>
        )}
        {action.busy && (
          <div
            role="status"
            className="primary-surface relative overflow-hidden rounded-[20px] p-5"
          >
            <div className="relative">
              <p className="text-[16px] font-bold">
                <BusyText>{progress}</BusyText>
              </p>
              <p className="mt-2 text-[13px] leading-relaxed on-primary">
                원문을 확인하며 차근차근 만들고 있어요. 완료된 자료는 그대로 저장해 두어요.
              </p>
            </div>
          </div>
        )}
        {uncertainStage && (
          <p className="rounded-2xl bg-surface p-4 text-sm leading-relaxed">
            이전 작업을 이어서 확인할 수 있어요. 진행 중인 작업을 새로 만들지 않고 결과만 확인해요.
          </p>
        )}
        <ErrorNote error={action.error} />
        <Button
          className="w-full"
          disabled={
            action.busy ||
            (!uncertainStage && retryIn > 0) ||
            !title.trim() ||
            (!file && !content.trim())
          }
          onClick={() => action.run(save)}
        >
          {action.busy ? (
            <BusyText>{progress}</BusyText>
          ) : uncertainStage ? (
            '진행 상황 확인'
          ) : saved ? (
            waitingLabel('생성 다시 시도', retryIn)
          ) : generate ? (
            waitingLabel('문제와 카드 만들기', retryIn)
          ) : (
            waitingLabel('자료 저장하기', retryIn)
          )}
        </Button>
      </div>
    </Sheet>
  );
}
export { CompletedSubjects } from './completed-subjects';
