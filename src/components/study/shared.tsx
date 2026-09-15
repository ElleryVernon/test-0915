'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, ChevronRight, FileText, ImageIcon, LoaderCircle } from '@/components/icons';
import type { AppData, ScreenProps, Material, MaterialImage } from '@/lib/contracts';
import { Button, ErrorNote, Sheet } from '@/components/ui';
import { api, apiErrorOf } from '@/lib/api';
import {
  acknowledgeAiTask,
  AI_CLIENT_DEADLINE_MS,
  AiTaskFailureError,
  AiTaskPendingError,
  runAiTask,
  type AiTaskRecord,
} from '@/lib/ai-task';
import { retryAtOf, useRetryCountdown, waitingLabel } from '@/lib/retry-countdown';
import { exclusively, generatedItemCount, type GenerationMode } from './logic';
import { recoverGenerationTask } from './generation-task';
import { generationCopy, progressCopy } from '@/lib/ai-progress';
import { OptionField, OptionList } from '@/components/ui-choice';

export function params(path: string) {
  return new URL(path, 'https://memoryz.local').searchParams;
}
export function errorMessage(error: unknown) {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    return '응답을 기다리는 시간이 길어졌어요. 잠시 뒤 결과를 확인해 주세요.';
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message))
    return '인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
  return error instanceof Error ? error.message : '잠시 뒤 다시 시도해 주세요.';
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A refusal that says when to come back keeps the action's button waiting until then.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const retryIn = useRetryCountdown(retryAt);
  const lock = useRef(false);
  async function run(action: () => Promise<void>) {
    await exclusively(lock, async () => {
      setBusy(true);
      setError('');
      try {
        await action();
        setRetryAt(null);
      } catch (error) {
        setError(errorMessage(error));
        setRetryAt(retryAtOf(error));
      } finally {
        setBusy(false);
      }
    });
  }
  return { busy, error, setError, run, retryAt, retryIn };
}
export { ErrorNote };
export function BusyText({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center justify-center gap-2">
      <LoaderCircle size={18} className="animate-spin" />
      {children}
    </span>
  );
}
export function Chip({
  active,
  onClick,
  children,
  disabled = false,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button aria-pressed={active} disabled={disabled} onClick={onClick} className="selection-chip">
      {children}
    </button>
  );
}
export function Progress({ value, total }: { value: number; total: number }) {
  return (
    <div
      role="progressbar"
      aria-label="학습 진행률"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={value}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface"
    >
      <div
        className="h-full rounded-full bg-brand transition-[width] duration-300"
        style={{ width: `${total ? (value / total) * 100 : 0}%` }}
      />
    </div>
  );
}
export function SubjectSelect({
  data,
  value,
  onChange,
  all = true,
}: {
  data: AppData;
  value: string;
  onChange: (v: string) => void;
  all?: boolean;
}) {
  return (
    <OptionField
      label="과목 선택"
      name="subject"
      value={value}
      onChange={onChange}
      options={[
        ...(all ? [{ value: '', label: '모든 과목' }] : []),
        ...data.subjects.map((s) => ({ value: s.id, label: s.name })),
      ]}
    />
  );
}
export function Citation({
  material,
  citation,
  onOpen,
}: {
  material?: Material;
  citation: string;
  onOpen?: () => void;
}) {
  return (
    <div className="rounded-[20px] bg-surface p-4">
      <p className="mb-2 flex items-center gap-2 text-[13px] font-bold">
        <BookOpen size={16} />
        자료에서 찾은 근거
      </p>
      <blockquote className="whitespace-pre-wrap break-words text-[14px] leading-[1.7] text-secondary">
        “{citation}”
      </blockquote>
      {material && (
        <button
          onClick={onOpen}
          className="mt-3 flex min-h-10 w-full items-center gap-2 text-left text-[12px] font-semibold text-muted"
        >
          <FileText size={15} />
          <span className="min-w-0 flex-1 truncate">{material.title}</span>
          <span>원본 보기</span>
          <ChevronRight size={16} />
        </button>
      )}
    </div>
  );
}
export { MaterialViewer } from './material-viewer';
export function MaterialIcon({ type }: { type: string }) {
  return type.toLowerCase().includes('image') ? <ImageIcon size={22} /> : <FileText size={22} />;
}
export function GenerationSheet({
  open,
  onClose,
  props,
  initialMaterial = '',
  mode = 'quiz',
}: {
  open: boolean;
  onClose: () => void;
  props: ScreenProps;
  initialMaterial?: string;
  mode?: GenerationMode;
}) {
  const [material, setMaterial] = useState(initialMaterial || props.data.materials[0]?.id || '');
  const [count, setCount] = useState(5);
  const [created, setCreated] = useState<number | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [task, setTask] = useState<AiTaskRecord | null>(null);
  const [restoring, setRestoring] = useState(true);
  const action = useAction();
  // A failure that said when to come back (stored on the task, or the last refusal) keeps the button waiting.
  const retryIn = useRetryCountdown(action.retryAt, task?.retryAt);
  const selected = props.data.materials.find((item) => item.id === material);
  const sourceReady = !!selected && selected.contentLength >= 20;
  const label = mode === 'quiz' ? '문제' : mode === 'essay' ? '서술형 문제' : '복습 카드';
  // Elapsed time since the button was pressed, so a one-minute generation reads as progress.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!action.busy) return setElapsed(0);
    const startedAt = Date.now();
    // jitter: none — an elapsed-time counter in the sheet; it sends nothing [site src/components/study/shared.tsx:179]
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [action.busy]);
  const progress = progressCopy(generationCopy(label), task?.steps, elapsed);
  // A run belongs to the sheet that started it: once the sheet is gone (back navigation), the run
  // stops waiting and never acknowledges, so a reopened sheet recovers the stored result instead.
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (open) {
      setCreated(null);
      setUncertain(false);
      action.setError('');
    }
    // Clear display state on reopening, then recover the saved request below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) {
      setRestoring(true);
      return;
    }
    if (!material) {
      setRestoring(false);
      return;
    }
    const controller = new AbortController();
    setRestoring(true);
    setTask(null);
    setUncertain(false);
    recoverGenerationTask({
      userId: props.data.profile.id,
      materialId: material,
      mode,
      signal: controller.signal,
    })
      .then((recovery) => {
        if (!recovery || controller.signal.aborted) return;
        const { task: current, count: savedCount } = recovery;
        setCount(savedCount);
        setTask(current);
        if (current.status === 'COMPLETED')
          setCreated(generatedItemCount(current.result, mode, savedCount));
        else if (current.status === 'RUNNING' || current.status === 'READY') setUncertain(true);
      })
      .catch((error) => {
        if (!controller.signal.aborted) action.setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false);
      });
    return () => controller.abort();
    // Count is restored from the task. Including it here would reset recovery after restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, material, mode, props.data.profile.id]);
  // jitter: none — one POST per click, already spread by people; runAiTask owns polling and cooldown, the server's admission queue caps concurrency [site src/components/study/shared.tsx:243]
  async function generate() {
    const lookup = {
      userId: props.data.profile.id,
      endpoint: '/generate' as const,
      payload: task?.payload || { materialId: material, count, mode },
    };
    if (created !== null) {
      await props.refresh();
      await acknowledgeAiTask(lookup);
      onClose();
      return;
    }
    try {
      const result = await runAiTask({
        ...lookup,
        retryFailed: task?.status === 'FAILED' || task?.status === 'INTERRUPTED',
        onStatus: setTask,
        signal: lifetime.current?.signal,
      });
      if (lifetime.current?.signal.aborted) return;
      setCreated(generatedItemCount(result, mode, count));
      setUncertain(false);
    } catch (error) {
      if (error instanceof AiTaskPendingError || error instanceof AiTaskFailureError) {
        setTask(error.task);
        setUncertain(error instanceof AiTaskPendingError);
      }
      throw error;
    }
    await props.refresh();
    if (lifetime.current?.signal.aborted) return;
    await acknowledgeAiTask(lookup);
    props.toast(`${label} ${count}개를 만들었어요`);
    onClose();
  }
  return (
    <Sheet
      open={open}
      onClose={() => {
        if (action.busy) props.toast('자료를 만들고 있어요. 완료될 때까지 잠시 기다려 주세요.');
        else onClose();
      }}
      title={`${label} 만들기`}
    >
      <div className="space-y-5" aria-busy={action.busy}>
        <p className="text-[15px] leading-relaxed text-muted">
          내 자료에서 근거를 찾아 만들어요. 사용할 자료를 골라 주세요.
        </p>
        <div>
          <p className="mb-2 text-sm font-semibold">자료</p>
          <OptionList
            label="자료"
            name="material"
            value={material}
            collapse={5}
            onChange={(next) => {
              if (!(action.busy || restoring || created !== null || uncertain)) setMaterial(next);
            }}
            options={props.data.materials.map((m) => ({
              value: m.id,
              label: m.title,
              description: `${m.type.toUpperCase()} · ${m.contentLength.toLocaleString('ko-KR')}자${m.contentLength < 20 ? ' · 본문이 짧아 만들 수 없어요' : ''}`,
              icon: <MaterialIcon type={m.type} />,
              disabled: m.contentLength < 20,
            }))}
          />
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold">만들 개수</p>
          <div className="grid grid-cols-3 gap-2">
            {[3, 5, 10].map((n) => (
              <Chip
                key={n}
                active={count === n}
                disabled={action.busy || restoring || created !== null || uncertain}
                onClick={() => {
                  setCount(n);
                  setTask(null);
                  action.setError('');
                }}
              >
                {n}개
              </Chip>
            ))}
          </div>
        </div>
        {action.busy && (
          <div
            role="status"
            className="primary-surface relative overflow-hidden rounded-[20px] p-5"
          >
            <div className="relative flex items-center gap-3">
              <LoaderCircle size={24} className="shrink-0 animate-spin" />
              <div>
                <p className="text-[16px] font-bold">
                  {created !== null
                    ? '만든 자료를 불러오고 있어요'
                    : `자료를 읽고 ${label}를 만들고 있어요`}
                </p>
                <p className="mt-2 text-[13px] leading-relaxed on-primary">
                  {created !== null ? (
                    '저장된 결과를 가져오고 있어요.'
                  ) : (
                    <>
                      {progress.stage}
                      {/* The ticking seconds stay out of the live region; only stage changes are announced. */}
                      <span aria-hidden="true"> · {progress.elapsed}</span>
                    </>
                  )}
                </p>
                {created === null && (
                  <p className="mt-1 text-[13px] leading-relaxed on-primary">{progress.hint}</p>
                )}
              </div>
            </div>
          </div>
        )}
        {created !== null && !action.busy && (
          <div role="status" className="rounded-2xl bg-surface p-4 text-sm leading-relaxed">
            <strong>
              {label} {created}개는 저장되었어요.
            </strong>
            <p className="mt-1 text-muted">화면을 다시 불러오면 바로 학습할 수 있어요.</p>
          </div>
        )}
        {uncertain && (
          <p className="rounded-2xl bg-surface p-4 text-sm leading-relaxed">
            이전 요청을 보관하고 있어요. 같은 요청 번호로 이어서 확인해 중복 생성을 막아요.
          </p>
        )}
        {!props.data.aiAvailable && (
          <p className="rounded-2xl bg-surface p-4 text-sm leading-relaxed">
            AI 연결이 아직 준비되지 않았어요. 올린 자료는 안전하게 저장되며, 연결 후 문제를 만들 수
            있어요.
          </p>
        )}
        {selected && !sourceReady && (
          <div className="rounded-2xl bg-surface p-4 text-sm leading-relaxed">
            <p>원문을 20자 이상 입력해 주세요. 충분한 근거가 있어야 문제를 만들 수 있어요.</p>
            <button
              className="mt-2 min-h-11 font-bold"
              onClick={() => {
                onClose();
                props.navigate(`/subjects/${selected.subjectId}?material=${selected.id}&edit=1`);
              }}
            >
              자료 본문 보완하기 <ChevronRight size={15} className="inline" />
            </button>
          </div>
        )}
        {task && (task.status === 'FAILED' || task.status === 'INTERRUPTED') && (
          <p className="rounded-2xl bg-surface p-4 text-sm leading-relaxed">
            {task.error || '이전 작업을 완료하지 못했어요.'} 다시 만들기를 누르면 새 작업으로
            시작해요.
          </p>
        )}
        <ErrorNote error={action.error} />
        <Button
          className="w-full"
          disabled={
            action.busy ||
            restoring ||
            (created === null && retryIn > 0) ||
            (created === null && !uncertain && (!sourceReady || !props.data.aiAvailable))
          }
          onClick={() => action.run(generate)}
        >
          {action.busy ? (
            <BusyText>{created !== null ? '불러오는 중' : '만드는 중'}</BusyText>
          ) : restoring ? (
            '이전 작업 확인 중'
          ) : created !== null ? (
            '만든 자료 확인하기'
          ) : uncertain ? (
            '이전 요청 이어가기'
          ) : task?.status === 'FAILED' || task?.status === 'INTERRUPTED' ? (
            waitingLabel('다시 만들기', retryIn)
          ) : (
            waitingLabel(`${count}개 만들기`, retryIn)
          )}
        </Button>
        {!props.data.materials.length && (
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => {
              onClose();
              props.navigate('/subjects');
            }}
          >
            먼저 자료 올리기
          </Button>
        )}
      </div>
    </Sheet>
  );
}
export async function imageFile(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1920 / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이미지를 준비하지 못했어요. 다시 시도해 주세요.');
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.85),
    );
    if (!blob) throw new Error('이미지를 읽지 못했어요. 다른 사진을 선택해 주세요.');
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
// No automatic retry: each one re-sends up to 10 MB and mints a new upload id. A refusal (the PDF
// queue's [30 s, 60 s), OCR admission's [10 s, 20 s)) keeps 다시 시도 waiting instead.
// jitter: cooldown on a refused upload (hint + U[0,1 s)); client deadline 190 s above the server's 180 s [site src/components/study/shared.tsx:446]
export async function uploadFile(file: File) {
  validateUploadSize(file);
  const prepared = await imageFile(file);
  validateUploadSize(prepared);
  const form = new FormData();
  form.append('file', prepared);
  const response = await fetch('/api/upload', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(AI_CLIENT_DEADLINE_MS),
  });
  const result = await response
    .json()
    .catch(() => ({ error: '파일 업로드 응답을 읽지 못했어요. 다시 시도해 주세요.' }));
  if (!response.ok) throw apiErrorOf(response, result, '파일을 올리지 못했어요.');
  return result.data as {
    uploadId: string;
    url: string;
    content: string;
    type: string;
    title: string;
    pages: number | null;
    extraction: string;
    images: MaterialImage[];
    warning?: string;
  };
}

export function validateUploadSize(file: Pick<File, 'size'>) {
  if (!file.size) throw new Error('빈 파일은 올릴 수 없어요. 내용이 있는 파일을 선택해 주세요.');
  if (file.size > 10_000_000)
    throw new Error('파일은 10MB까지 올릴 수 있어요. 더 작은 파일을 선택해 주세요.');
}
