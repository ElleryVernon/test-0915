'use client';
import { sessionFetch } from '@/lib/session-boundary';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  BookOpen,
  ChevronRight,
  FileText,
  ImageIcon,
  LoaderCircle,
  MessageCircle,
} from '@/components/icons';
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
import layout from './study-layout.module.css';
import { OptionField, OptionList } from '@/components/ui-choice';
import { GenerationSource } from './generation-source';
import { MaterialFolderBrowser } from './material-folder-picker';
import { generationDefault } from '@/lib/study-library';
import { folderUploadPath } from '@/lib/quiz-session';
import { selectedMaterials } from '@/lib/material-folders';
import { generationSourcePayload, generatedMaterialId } from '@/lib/generation-sources';
import generation from './generation-workspace.module.css';
import { useMaterialDetail } from '@/lib/materials';
import { evidencePageLabel, evidenceText, sourceEvidence } from '@/lib/source-evidence';
import { findCitation } from './material-layout';
import { pdfEvidencePages, evidencePdfUrl } from './pdf-evidence';
import PdfViewer from './pdf-viewer';

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
  const [expandedCitation, setExpandedCitation] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const id = useId();
  const isPdf = !!material?.type.toLowerCase().includes('pdf');
  const isImage = !!material?.url && !!material.type.toLowerCase().includes('image');
  const { detail, loading, error, retry } = useMaterialDetail(isPdf ? (material ?? null) : null);
  const parts = useMemo(() => sourceEvidence(citation, isPdf), [citation, isPdf]);
  const located = useMemo(
    () => (detail ? findCitation(detail.content, citation, detail.pageBreaks) : null),
    [detail, citation],
  );
  const pageLabel = located
    ? evidencePageLabel(located.start, located.end, detail?.pageBreaks)
    : null;
  const pages = useMemo(
    () => (detail ? pdfEvidencePages(detail.content, citation, detail.pageBreaks) : []),
    [detail, citation],
  );
  const canPreview = !!material?.url && !!evidencePdfUrl(material.url, pages);
  const hasLayout = parts.some((part) => part.kind === 'layout');
  const isLong = isPdf || isImage || citation.length > 420 || parts.length > 1;
  const expanded = expandedCitation === citation;
  const preview = parts.find((part) => part.kind === 'text');
  return (
    <section className={layout.source} aria-label="자료에서 찾은 근거" data-source-evidence>
      <p className={layout.sourceTitle}>
        <BookOpen size={16} />
        자료에서 찾은 근거
      </p>
      <p className={layout.sourceMeta}>원문 발췌{pageLabel ? ` · ${pageLabel}` : ''}</p>
      {isPdf && (
        <p className={layout.sourceMeta}>전체 근거에서 본문·수식·도식을 함께 볼 수 있어요.</p>
      )}
      {expanded && isPdf && canPreview && (
        <div className="segmented" role="tablist" aria-label="근거 보기 방식">
          <button
            type="button"
            role="tab"
            aria-selected={!showText}
            className={!showText ? 'is-active' : undefined}
            onClick={() => setShowText(false)}
          >
            원본 · 도식 포함
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={showText}
            className={showText ? 'is-active' : undefined}
            onClick={() => setShowText(true)}
          >
            텍스트 발췌
          </button>
        </div>
      )}
      <div id={id}>
        {expanded && isImage && (
          <img
            className={layout.sourceImage}
            src={material!.url}
            alt={`${material!.title} 원본 근거`}
            loading="lazy"
          />
        )}
        {expanded && isPdf && canPreview && !showText ? (
          <>
            <p className={layout.sourceMeta}>주황색으로 강조한 부분이 인용한 원문이에요.</p>
            <div className={layout.sourcePdf}>
              <PdfViewer
                url={material!.url!}
                title={material!.title}
                evidence={pages}
                initialPage={pages[0].page}
              />
            </div>
          </>
        ) : (
          <div
            className={expanded ? layout.sourceReading : undefined}
            tabIndex={expanded ? 0 : undefined}
            role={expanded ? 'region' : undefined}
            aria-label={expanded ? '원문 발췌 읽기' : undefined}
          >
            {expanded && isPdf && loading && (
              <p role="status" className={layout.sourceMeta}>
                근거 페이지를 찾고 있어요
              </p>
            )}
            {expanded && isPdf && error && (
              <button className={layout.sourceExpand} onClick={retry}>
                원본 페이지 다시 불러오기
              </button>
            )}
            {expanded && isPdf && !canPreview && !loading && !error && (
              <p className={layout.sourceMeta}>
                원본의 근거 위치를 확인하지 못했어요. 저장된 발췌를 보여드려요.
              </p>
            )}
            {expanded && showText && hasLayout && (
              <p className={layout.sourceNotice}>
                텍스트로 표현하기 어려운 수식과 그림은 ‘원본 · 도식 포함’에서 확인해 주세요.
              </p>
            )}
            {expanded ? (
              parts.map((part) =>
                part.kind === 'layout' ? (
                  <details key={part.start} className={layout.sourceLayout}>
                    <summary>수식·그림의 추출 문자 확인</summary>
                    <p>배치가 사라진 문자예요. 수식과 그림은 원본 PDF를 확인해 주세요.</p>
                    <pre>{part.text}</pre>
                  </details>
                ) : (
                  <blockquote key={part.start} className={layout.sourceQuote}>
                    {evidenceText(part.text)}
                  </blockquote>
                ),
              )
            ) : hasLayout && isPdf ? null : preview ? (
              <blockquote
                className={`${layout.sourceQuote} ${isLong ? layout.sourceQuotePreview : ''}`}
              >
                {evidenceText(preview.text)}
              </blockquote>
            ) : (
              <p className={layout.sourceMeta}>
                본문으로 읽기 어려운 근거예요. 원본에서 확인해 주세요.
              </p>
            )}
          </div>
        )}
      </div>
      {isLong && (
        <button
          type="button"
          className={layout.sourceExpand}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpandedCitation(expanded ? null : citation)}
        >
          {expanded ? '근거 접기' : '전체 근거 보기'}
          <ChevronRight
            size={16}
            aria-hidden
            style={{ transform: expanded ? 'rotate(-90deg)' : 'rotate(90deg)' }}
          />
        </button>
      )}
      {material &&
        (onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className={layout.sourceOpen}
            aria-label={`${material.title} 원본 보기`}
          >
            <FileText size={16} />
            <span className={layout.sourceName}>{material.title}</span>
            <span>원본 보기</span>
            <ChevronRight size={16} />
          </button>
        ) : (
          <p className={layout.sourceFile}>
            <FileText size={16} />
            {material.title}
          </p>
        ))}
    </section>
  );
}
export { MaterialViewer } from './material-viewer';
export function MaterialIcon({ type }: { type: string }) {
  return type.toLowerCase().includes('image') ? <ImageIcon size={22} /> : <FileText size={22} />;
}

/**
 * Sessions never interrupt with community pings; when a session ends, unread answer notices
 * surface once as a single row back to the thread.
 */
export function CommunityAnswersRow({ props }: { props: ScreenProps }) {
  const unread = props.data.notifications.filter(
    (n) => !n.read && (n.kind === 'FIRST_ANSWER' || n.kind === 'MORE_ANSWERS'),
  );
  if (!unread.length) return null;
  const target = unread.length === 1 ? unread[0].href || '/community' : '/community';
  return (
    <button className="session-answer-row" onClick={() => props.navigate(target)}>
      <MessageCircle size={18} />
      <span>답변 도착 {unread.length}</span>
      <ChevronRight size={16} />
    </button>
  );
}
export function GenerationSheet({
  open,
  onClose,
  props,
  initialMaterial = '',
  initialFolder = '',
  initialTopic = '',
  mode = 'quiz',
}: {
  open: boolean;
  onClose: () => void;
  props: ScreenProps;
  initialMaterial?: string;
  initialFolder?: string;
  initialTopic?: string;
  mode?: GenerationMode;
}) {
  const [materialIds, setMaterialIds] = useState(() => {
    const id = generationDefault(props.data.materials, initialMaterial);
    return id ? [id] : [];
  });
  const [selecting, setSelecting] = useState(
    () => !generationDefault(props.data.materials, initialMaterial),
  );
  const [topic, setTopic] = useState(initialTopic.slice(0, 120));
  const [destination, setDestination] = useState('');
  const [resultMaterial, setResultMaterial] = useState('');
  const [count, setCount] = useState(5);
  const [created, setCreated] = useState<number | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [task, setTask] = useState<AiTaskRecord | null>(null);
  const resumedRequest = useRef<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const action = useAction();
  // A failure that said when to come back (stored on the task, or the last refusal) keeps the button waiting.
  const retryIn = useRetryCountdown(action.retryAt, task?.retryAt);
  const sources = selectedMaterials(props.data.materials, materialIds);
  const selected = sources[0];
  const subjectId = sources.some((m) => m.subjectId === destination)
    ? destination
    : selected?.subjectId || '';
  const sourceReady =
    sources.length > 0 &&
    sources.length === materialIds.length &&
    sources.every((m) => m.contentLength >= 20);
  const sourceKey = [...materialIds].sort().join(',');
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
    if (!open) return;
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [open]);
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

    const controller = new AbortController();
    setRestoring(true);
    setTask(null);
    setUncertain(false);
    recoverGenerationTask({
      userId: props.data.profile.id,
      materialIds,
      subjectId,
      topic,
      mode,
      signal: controller.signal,
    })
      .then((recovery) => {
        if (!recovery || controller.signal.aborted) return;
        const { task: current, count: savedCount } = recovery;
        setCount(savedCount);
        setTask(current);
        setSelecting(false);
        if (!materialIds.length) {
          const ids = current.payload.materialIds;
          setMaterialIds(
            Array.isArray(ids)
              ? ids.filter((id): id is string => typeof id === 'string')
              : typeof current.payload.materialId === 'string'
                ? [current.payload.materialId]
                : [],
          );
          setTopic(typeof current.payload.topic === 'string' ? current.payload.topic : '');
          setDestination(
            typeof current.payload.subjectId === 'string' ? current.payload.subjectId : '',
          );
        }
        if (current.status === 'COMPLETED') {
          setCreated(generatedItemCount(current.result, mode, savedCount));
          setResultMaterial(generatedMaterialId(current.result) || selected?.id || '');
        } else if (current.status === 'RUNNING' || current.status === 'READY') setUncertain(true);
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
  }, [open, sourceKey, subjectId, topic, mode, props.data.profile.id]);
  // jitter: none — one POST per click, already spread by people; runAiTask owns polling and cooldown, the server's admission queue caps concurrency [site src/components/study/shared.tsx:243]
  async function generate() {
    const signal = lifetime.current?.signal;
    const lookup = {
      userId: props.data.profile.id,
      endpoint: '/generate' as const,
      payload: task?.payload || {
        ...generationSourcePayload(materialIds, subjectId, topic),
        count,
        mode,
      },
    };
    if (created !== null) {
      await props.refresh();
      await acknowledgeAiTask(lookup);
      onClose();
      const id = resultMaterial || selected?.id;
      if (id)
        props.navigate(
          mode === 'essay' ? `/essay?material=${id}` : `/subjects/${subjectId}?material=${id}`,
        );
      return;
    }
    let savedCount = 0;
    try {
      const result = await runAiTask({
        ...lookup,
        retryFailed: task?.status === 'FAILED' || task?.status === 'INTERRUPTED',
        onStatus: setTask,
        signal,
      });
      if (signal?.aborted) return;
      savedCount = generatedItemCount(result, mode, count);
      setCreated(savedCount);
      setResultMaterial(generatedMaterialId(result) || selected?.id || '');
      setUncertain(false);
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof AiTaskPendingError || error instanceof AiTaskFailureError) {
        setTask(error.task);
        setUncertain(error instanceof AiTaskPendingError);
      }
      throw error;
    }
    await props.refresh();
    if (signal?.aborted) return;
    // Keep the saved result visible until the user opens it. Recovery never re-sends generation.
  }
  useEffect(() => {
    if (!open) {
      resumedRequest.current = null;
      return;
    }
    if (
      restoring ||
      !uncertain ||
      !task ||
      action.busy ||
      resumedRequest.current === task.requestId
    )
      return;
    // Recovery resumes GET polling for the existing request, never a new generation POST.
    resumedRequest.current = task.requestId;
    void action.run(generate);
    // Each recovered request is resumed once per opening; runAiTask owns subsequent polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, restoring, uncertain, task?.requestId, action.busy]);
  const working = created === null && (action.busy || uncertain);
  const failed = task?.status === 'FAILED' || task?.status === 'INTERRUPTED';
  const closeWorkspace = () => {
    if (working) props.toast('요청은 보관돼요. 만들기를 다시 열면 진행 상황을 확인할 수 있어요.');
    onClose();
  };
  return (
    <Sheet open={open} onClose={closeWorkspace} workspace title={`${label} 만들기`}>
      <div className={generation.workspace}>
        {!working && created === null && (
          <nav className={generation.navigation} aria-label="만들기 단계">
            <ol className={generation.steps}>
              <li
                aria-current={selecting ? 'step' : undefined}
                data-state={selecting ? 'current' : 'complete'}
              >
                {selecting ? (
                  <span className={generation.step}>자료 선택</span>
                ) : (
                  <button
                    type="button"
                    className={`${generation.step} ${generation.stepAction}`}
                    disabled={restoring}
                    onClick={() => setSelecting(true)}
                    aria-label="완료한 자료 선택 단계로 돌아가기"
                  >
                    <Check size={14} aria-hidden="true" />
                    자료 선택
                  </button>
                )}
              </li>
              <li
                aria-current={!selecting ? 'step' : undefined}
                data-state={selecting ? 'upcoming' : 'current'}
              >
                <span className={generation.step}>
                  {mode === 'cards' ? '카드 설정' : '문제 설정'}
                </span>
              </li>
            </ol>
            {selecting && sources.length > 0 && (
              <button
                type="button"
                className={generation.cancelChange}
                onClick={() => setSelecting(false)}
              >
                변경 취소
              </button>
            )}
          </nav>
        )}
        {selecting && created === null && !working ? (
          <>
            <MaterialFolderBrowser
              data={props.data}
              selected={sources}
              initialFolder={initialFolder}
              confirmLabel={(n) => `${n}개 자료로 다음`}
              onAddMaterials={(folder) => {
                onClose();
                props.navigate(folderUploadPath(folder || initialFolder, props.data.subjects));
              }}
              onSelect={(next) => {
                setMaterialIds(next);
                if (next.length === 0) setTopic('');
                setCreated(null);
                setResultMaterial('');
                setTask(null);
                action.setError('');
                setSelecting(false);
              }}
            />
          </>
        ) : (
          <>
            <div className={generation.body}>
              {created !== null ? (
                <div className={generation.page}>
                  <div className={generation.state} role="status">
                    <span className={generation.stateIcon}>
                      <Check size={28} />
                    </span>
                    <h3>
                      {label} {created}
                      {mode === 'cards' ? '장' : '개'}를 만들었어요
                    </h3>
                    <p>
                      선택한 자료의 근거와 함께 저장했어요.
                      <br />
                      바로 확인하고 학습을 시작해 보세요.
                    </p>
                  </div>
                  <GenerationSource data={props.data} selected={sources} />
                </div>
              ) : working ? (
                <div className={generation.page}>
                  <div className={generation.state}>
                    <span className={generation.stateIcon}>
                      <LoaderCircle size={28} className="animate-spin" />
                    </span>
                    <h3>
                      자료를 읽고
                      <br />
                      {label}를 만들고 있어요
                    </h3>
                    <p>{progress.hint}</p>
                  </div>
                  <div className={generation.statusLine}>
                    <span role="status">{progress.stage}</span>
                    <span aria-hidden="true">{progress.elapsed}</span>
                  </div>
                  <GenerationSource data={props.data} selected={sources} />
                </div>
              ) : (
                <div className={generation.page}>
                  <section className={generation.section} aria-label="생성 개수 설정">
                    <h3>{mode === 'cards' ? '몇 장을 만들까요?' : '몇 문제를 만들까요?'}</h3>
                    <div className={generation.counts} role="group" aria-label="만들 개수">
                      {[3, 5, 10].map((n) => (
                        <button
                          type="button"
                          key={n}
                          aria-pressed={count === n}
                          disabled={restoring}
                          onClick={() => {
                            setCount(n);
                            setTask(null);
                            action.setError('');
                          }}
                        >
                          <strong>{n}</strong>
                          <span>{mode === 'cards' ? '장' : '문제'}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                  <GenerationSource
                    data={props.data}
                    selected={sources}
                    locked={restoring}
                    onEdit={() => setSelecting(true)}
                  />
                  {sources.length > 0 && (
                    <section className={generation.section}>
                      <label htmlFor="generation-topic" className={generation.optional}>
                        집중할 주제 <span>선택</span>
                      </label>
                      <input
                        id="generation-topic"
                        className={generation.topic}
                        value={topic}
                        maxLength={120}
                        disabled={restoring}
                        placeholder="집중해서 연습하고 싶은 주제"
                        onChange={(event) => {
                          setTopic(event.target.value);
                          setTask(null);
                          action.setError('');
                        }}
                      />
                      <p>
                        긴 교재는 단원이나 개념을 적으면 범위를 좁힐 수 있어요. 비워 두면 자료
                        전체를 활용해요.
                      </p>
                    </section>
                  )}
                  {new Set(sources.map((m) => m.subjectId)).size > 1 && (
                    <div className={generation.destination}>
                      <span>저장할 과목</span>
                      <OptionField
                        compact
                        label="저장할 과목"
                        value={subjectId}
                        disabled={restoring}
                        onChange={(value) => {
                          setDestination(value);
                          setTask(null);
                          action.setError('');
                        }}
                        options={[...new Set(sources.map((m) => m.subjectId))].map((id) => ({
                          value: id,
                          label:
                            props.data.subjects.find((s) => s.id === id)?.name || '과목 미지정',
                        }))}
                      />
                    </div>
                  )}
                  {!sourceReady && (
                    <div className={generation.notice}>
                      <p>
                        본문이 20자 이상인 자료가 필요해요. 다른 자료를 고르거나 본문을 보완해
                        주세요.
                      </p>
                      {selected && (
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            props.navigate(
                              `/subjects/${selected.subjectId}?material=${selected.id}&edit=1`,
                            );
                          }}
                        >
                          자료 본문 보완하기
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            <footer className={generation.footer}>
              {created === null && !working && !props.data.aiAvailable && (
                <div className={generation.notice}>
                  AI 연결이 아직 준비되지 않았어요. 자료는 그대로 보관되며, 연결 후 만들 수 있어요.
                </div>
              )}
              {failed && (
                <div className={generation.notice} role="status">
                  <strong>만들기를 마치지 못했어요</strong>
                  <p>{task?.error || '자료와 개수는 유지했어요. 잠시 뒤 다시 시도해 주세요.'}</p>
                </div>
              )}
              <ErrorNote
                error={
                  created !== null && action.error
                    ? '저장된 결과를 불러오지 못했어요. 다시 확인해 주세요.'
                    : failed
                      ? ''
                      : action.error
                }
              />
              {!working && created === null && (
                <p>
                  자료 {sources.length}개 · {label} {count}
                  {mode === 'cards' ? '장' : '개'}
                </p>
              )}
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
                  mode === 'essay' ? (
                    '만든 서술형 문제 보기'
                  ) : (
                    '만든 자료 확인하기'
                  )
                ) : uncertain ? (
                  '진행 상황 이어서 확인'
                ) : failed ? (
                  waitingLabel('다시 만들기', retryIn)
                ) : (
                  waitingLabel(
                    mode === 'cards'
                      ? `복습 카드 ${count}장 만들기`
                      : `${mode === 'essay' ? '서술형 ' : ''}${count}문제 만들기`,
                    retryIn,
                  )
                )}
              </Button>
              {working && (
                <Button variant="ghost" className="w-full" onClick={closeWorkspace}>
                  닫고 나중에 확인하기
                </Button>
              )}
            </footer>
          </>
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
  const response = await sessionFetch('/api/upload', {
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
