'use client';
import { useRef, useState } from 'react';
import {
  Plus,
  ChevronRight,
  BookOpen,
  Layers,
  PencilLine,
  Check,
  MoreHorizontal,
  FileText,
  Upload,
  Camera,
  Trash2,
  FolderOpen,
  GraduationCap,
  Sigma,
  Atom,
  Languages,
  Globe,
} from '@/components/icons';
import type { ScreenProps, Material, Subject } from '@/lib/contracts';
import { Button, EmptyState, IconButton, ScreenHeader, SectionTitle, Sheet } from '@/components/ui';
import { api } from '@/lib/api';
import {
  acknowledgeAiTask,
  AiTaskFailureError,
  AiTaskPendingError,
  runAiTask,
  type AiTaskRecord,
} from '@/lib/ai-task';
import {
  dueCards,
  generatedItemCount,
  type GenerationMode,
  wrongEssays,
  wrongQuestions,
} from './logic';
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

export function SubjectGlyph({ name }: { name: string }) {
  return /수학|미적분|대수/.test(name) ? (
    <Sigma size={23} />
  ) : /과학|생물|생명|물리|화학/.test(name) ? (
    <Atom size={23} />
  ) : /영어|국어|문학/.test(name) ? (
    <Languages size={23} />
  ) : /사회|역사|지리/.test(name) ? (
    <Globe size={23} />
  ) : (
    <BookOpen size={23} />
  );
}
export function StudyHome(props: ScreenProps) {
  const [add, setAdd] = useState(false);
  const [semester, setSemester] = useState('');
  const subjects = props.data.subjects.filter((s) => !semester || s.semester === semester);
  const semesters = [...new Set(props.data.subjects.map((s) => s.semester))];
  const due = dueCards(props.data.cards).length;
  return (
    <>
      <ScreenHeader
        title="학습"
        action={
          <IconButton label="과목 추가" onClick={() => setAdd(true)}>
            <Plus size={23} />
          </IconButton>
        }
      />
      <div className="page-inset pb-8">
        <section className="study-recall" aria-label="오늘의 복습">
          <div>
            <span className="eyebrow">오늘 다시 떠올릴 기억</span>
            <h2>
              {due ? (
                <>
                  <strong>{due}</strong>장의 카드가 기다려요
                </>
              ) : (
                '오늘의 복습을 마쳤어요'
              )}
            </h2>
            <p>
              {due ? '짧게 복습하고 다음 공부를 시작해요.' : '새로운 카드로 기억을 더 쌓아 볼까요?'}
            </p>
          </div>
          <Button onClick={() => props.navigate('/flashcards' + (due ? '?review=1' : ''))}>
            {due ? '복습 시작' : '카드 보기'}
            <ChevronRight size={17} />
          </Button>
        </section>
        <nav className="study-shortcuts" aria-label="학습 방법">
          {[
            {
              Icon: BookOpen,
              label: '문제 풀기',
              count: `${props.data.questions.length}문제`,
              path: '/quiz',
            },
            {
              Icon: PencilLine,
              label: '서술형 코칭',
              count: `${props.data.essays.length}문제`,
              path: '/essay',
            },
            {
              Icon: Layers,
              label: '복습 카드',
              count: `${props.data.cards.filter((c) => !c.deleted).length}장`,
              path: '/flashcards',
            },
            {
              Icon: FileText,
              label: '오답노트',
              count: `${wrongQuestions(props.data).length + wrongEssays(props.data).length}문제`,
              path: '/wrong-notes',
            },
          ].map(({ Icon, label, count, path }) => (
            <button key={path} onClick={() => props.navigate(path)}>
              <Icon size={23} />
              <strong>{label}</strong>
              <small>{count}</small>
            </button>
          ))}
        </nav>
        <SectionTitle
          title="내 과목"
          action={
            semesters.length > 0 && (
              <select
                aria-label="학기 선택"
                value={semester}
                onChange={(e) => setSemester(e.target.value)}
                className="library-semester"
              >
                <option value="">전체 학기</option>
                {semesters.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            )
          }
        />
        <div className="subject-library">
          {subjects.map((s) => (
            <button
              key={s.id}
              onClick={() => props.navigate(`/subjects/${s.id}`)}
              className="subject-library-row"
            >
              <span className="subject-library-icon">
                <SubjectGlyph name={s.name} />
              </span>
              <span className="row-copy">
                <span>{s.name}</span>
                <small>
                  자료 {s.materialCount}개 · 복습 카드 {s.cardCount}장
                </small>
              </span>
              <ChevronRight size={17} className="text-disabled" />
            </button>
          ))}
          {!subjects.length && (
            <p className="py-6 text-sm text-muted">이 학기에 공부할 과목을 추가해 보세요.</p>
          )}
          <button className="library-add" onClick={() => setAdd(true)}>
            <Plus size={19} />새 과목 추가
          </button>
        </div>
        <button className="library-add mt-4" onClick={() => props.navigate('/completed-subjects')}>
          <GraduationCap size={19} />
          배운 과목 설정
        </button>
      </div>
      <SubjectEditor open={add} onClose={() => setAdd(false)} props={props} />
    </>
  );
}

function SubjectEditor({
  open,
  onClose,
  props,
  subject,
}: {
  open: boolean;
  onClose: () => void;
  props: ScreenProps;
  subject?: Subject;
}) {
  const [name, setName] = useState(subject?.name || '');
  const [deleting, setDeleting] = useState(false);
  const action = useAction();
  return (
    <Sheet open={open} onClose={onClose} title={subject ? '과목 설정' : '어떤 과목을 공부하나요?'}>
      <div className="space-y-5">
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
        <ErrorNote error={action.error} />
        <Button
          className="w-full"
          disabled={!name.trim() || action.busy}
          onClick={() =>
            action.run(async () => {
              await api(
                subject ? `/subjects/${subject.id}` : '/subjects',
                { name: name.trim() },
                subject ? 'PATCH' : 'POST',
              );
              await props.refresh();
              onClose();
              props.toast(subject ? '과목 이름을 바꿨어요' : '새 과목을 만들었어요');
            })
          }
        >
          {action.busy ? <BusyText>저장 중</BusyText> : subject ? '변경 사항 저장' : '과목 만들기'}
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
                    className="flex-1"
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
  const [tab, setTab] = useState('자료');
  const [settings, setSettings] = useState(false);
  const [upload, setUpload] = useState(params(props.path).get('upload') === '1');
  const [selected, setSelected] = useState<Material | null>(
    props.data.materials.find(
      (m) => m.id === params(props.path).get('material') && m.subjectId === subjectId,
    ) || null,
  );
  const [view, setView] = useState(false);
  const [edit, setEdit] = useState(params(props.path).get('edit') === '1');
  const [generation, setGeneration] = useState<'quiz' | 'essay' | 'cards' | null>(null);
  const [deleteMaterial, setDeleteMaterial] = useState(false);
  const action = useAction();
  if (!subject)
    return (
      <>
        <ScreenHeader title="내 과목" back={() => props.navigate('/study')} />
        <EmptyState
          title="과목을 찾을 수 없어요"
          description="삭제되었거나 다른 계정의 과목이에요."
          action={<Button onClick={() => props.navigate('/study')}>내 과목으로</Button>}
        />
      </>
    );
  const materials = props.data.materials.filter((m) => m.subjectId === subject.id);
  const questions = props.data.questions.filter((q) => q.subjectId === subject.id);
  const cards = props.data.cards.filter((c) => c.subjectId === subject.id && !c.deleted);
  return (
    <>
      <ScreenHeader
        title=""
        back={() => props.navigate('/study')}
        action={
          <IconButton label="과목 설정" onClick={() => setSettings(true)}>
            <MoreHorizontal size={24} />
          </IconButton>
        }
      />
      <div className="page-inset pb-8">
        <p className="eyebrow">
          {subject.semester} · 자료 {materials.length}
        </p>
        <h1 className="mt-1 text-[28px] font-extrabold tracking-[-.04em]">{subject.name}</h1>
        <div className="mt-5 flex gap-2">
          {[
            ['자료', materials.length],
            ['문제', questions.length],
            ['카드', cards.length],
          ].map(([label, n]) => (
            <Chip key={label} active={tab === label} onClick={() => setTab(String(label))}>
              {label} <span className="ml-1 opacity-60">{n}</span>
            </Chip>
          ))}
        </div>
        {tab === '자료' ? (
          <div className="mt-5">
            {materials.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setSelected(m);
                  setDeleteMaterial(false);
                }}
                className="material-library-row"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface">
                  <MaterialIcon type={m.type} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-bold">{m.title}</span>
                  <span className="mt-1 block text-[12px] text-muted">
                    {new Date(m.createdAt).toLocaleDateString('ko-KR', {
                      month: 'long',
                      day: 'numeric',
                    })}{' '}
                    · {questions.filter((q) => q.materialId === m.id).length}문제
                  </span>
                </span>
                <ChevronRight size={18} className="text-disabled" />
              </button>
            ))}
            {!materials.length && (
              <EmptyState
                title="첫 자료를 올려 주세요"
                description="수업 필기, 교과서 PDF, 정리한 글에서 학습이 시작돼요."
              />
            )}
            <Button className="mt-6 w-full" onClick={() => setUpload(true)}>
              <Plus size={20} />
              자료 올리기
            </Button>
          </div>
        ) : tab === '문제' ? (
          <div className="mt-6 space-y-4">
            {questions.length ? (
              <>
                <p className="text-sm text-muted">
                  총 {questions.length}문제 · 서술형{' '}
                  {props.data.essays.filter((e) => e.subjectId === subject.id).length}문제
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
                    <ChevronRight size={18} className="mt-1 shrink-0" />
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
                title="아직 만든 문제가 없어요"
                description="자료를 선택하고 AI로 문제를 만들어 보세요."
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
              서술형 코칭으로
            </Button>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            <p className="text-sm text-muted">
              복습할 카드 {dueCards(cards).length}장 · 전체 {cards.length}장
            </p>
            <Button
              className="w-full"
              onClick={() => props.navigate(`/flashcards?subject=${subject.id}`)}
            >
              카드 보관함 열기
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => props.navigate(`/create-card?subject=${subject.id}`)}
            >
              직접 카드 만들기
            </Button>
          </div>
        )}
      </div>
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
      />
      <Sheet
        open={!!selected && !view && !edit && !generation}
        onClose={() => setSelected(null)}
        title={selected?.title || '자료'}
      >
        {selected && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 rounded-2xl bg-surface p-4 text-center">
              <div>
                <strong className="text-xl">
                  {questions.filter((q) => q.materialId === selected.id).length}
                </strong>
                <p className="text-xs text-muted">객관식 문제</p>
              </div>
              <div>
                <strong className="text-xl">
                  {props.data.essays.filter((q) => q.materialId === selected.id).length}
                </strong>
                <p className="text-xs text-muted">서술형 문제</p>
              </div>
            </div>
            <Button className="w-full" variant="secondary" onClick={() => setView(true)}>
              원본 보기
            </Button>
            <Button className="w-full" variant="secondary" onClick={() => setEdit(true)}>
              제목 · 본문 수정
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => props.navigate(`/quiz?material=${selected.id}`)}>
                문제 풀기
              </Button>
              <Button
                variant="secondary"
                onClick={() => props.navigate(`/essay?material=${selected.id}`)}
              >
                서술형 코칭
              </Button>
            </div>
            <div className="space-y-1">
              {(
                [
                  ['quiz', '문제 더 만들기'],
                  ['essay', '서술형 만들기'],
                  ['cards', '복습 카드 만들기'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  className="flex min-h-12 w-full items-center justify-between text-sm font-semibold"
                  onClick={() => setGeneration(mode)}
                >
                  {label}
                  <ChevronRight size={18} />
                </button>
              ))}
            </div>
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
              <Button variant="ghost" className="w-full" onClick={() => setDeleteMaterial(true)}>
                <Trash2 size={17} />
                자료 삭제
              </Button>
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
  const [content, setContent] = useState(material.content);
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
            placeholder="문제를 만들 원문을 입력해 주세요"
          />
        </label>
        <ErrorNote error={action.error} />
        <Button
          className="w-full"
          disabled={!title.trim() || action.busy}
          onClick={() =>
            action.run(async () => {
              await api(`/materials/${material.id}`, { title: title.trim(), content }, 'PATCH');
              await props.refresh();
              onSaved({ ...material, title, content });
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
}: {
  open: boolean;
  onClose: () => void;
  props: ScreenProps;
  subject: Subject;
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
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const action = useAction();
  async function save() {
    let material = saved;
    if (!material) {
      setProgress(file ? '자료를 올리고 있어요' : '자료를 저장하고 있어요');
      const uploaded = file ? await uploadFile(file) : undefined;
      material = await api<Material>('/materials', {
        subjectId: subject.id,
        title: title.trim() || file?.name,
        content: content.trim() || uploaded?.content || '',
        type: uploaded?.type || 'TXT',
        url: uploaded?.url,
      });
      setSaved(material);
      await props.refresh();
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
              if (!title) setTitle(f.name);
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
        <div className="grid grid-cols-2 gap-3">
          <button
            className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl bg-surface text-sm font-bold"
            disabled={!!saved || action.busy}
            onClick={() => input.current?.click()}
          >
            <Upload size={24} />
            파일 선택
          </button>
          <button
            className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl bg-surface text-sm font-bold"
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
        <label className="flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            className="h-5 w-5 accent-ink"
            checked={generate}
            disabled={!props.data.aiAvailable || action.busy}
            onChange={(e) => setGenerate(e.target.checked)}
          />
          <span className="text-sm font-semibold">문제와 복습 카드 함께 만들기</span>
        </label>
        {generate && (
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              className="h-5 w-5 accent-ink"
              checked={essay}
              disabled={action.busy}
              onChange={(e) => setEssay(e.target.checked)}
            />
            <span className="text-sm">서술형 4단계 코칭도 만들기</span>
          </label>
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
          disabled={action.busy || !title.trim() || (!file && !content.trim())}
          onClick={() => action.run(save)}
        >
          {action.busy ? (
            <BusyText>{progress}</BusyText>
          ) : uncertainStage ? (
            '진행 상황 확인'
          ) : saved ? (
            '생성 다시 시도'
          ) : generate ? (
            '문제와 카드 만들기'
          ) : (
            '자료 저장하기'
          )}
        </Button>
      </div>
    </Sheet>
  );
}
export { CompletedSubjects } from './completed-subjects';
