'use client';
import { useEffect, useReducer, useRef, useState, type PointerEvent } from 'react';
import {
  Check,
  ImagePlus,
  Move,
  PenLine,
  RotateCw,
  ScanLine,
  Square,
  Sparkles,
  Trash2,
  Undo2,
} from '@/components/icons';
import type { CardType, Mask, ScreenProps } from '@/lib/contracts';
import { Button, EmptyState, IconButton, ScreenHeader } from '@/components/ui';
import { useJourneyState } from '../journey';
import { api, apiErrorOf } from '@/lib/api';
import { sessionFetch } from '@/lib/session-boundary';
import { AI_CLIENT_DEADLINE_MS } from '@/lib/ai-task';
import { waitingLabel } from '@/lib/retry-countdown';
import { detectHighlights, normalizeMask, TYPES } from './logic';
import { editOcclusion, eraseMasks, initialOcclusion, paintMasks } from '@/lib/occlusion-edit';
import {
  BusyText,
  ErrorNote,
  imageFile,
  params,
  SubjectSelect,
  useAction,
  validateUploadSize,
} from './shared';

function EraserIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="m15.1 3.2 5.7 5.7a2 2 0 0 1 0 2.8l-8.3 8.3H7.8l-4.6-4.6a2 2 0 0 1 0-2.8l9.1-9.4a2 2 0 0 1 2.8 0ZM9 10.4l-4.4 4.4L8.6 19h3.1l2.7-2.7L9 10.4ZM21 20v2H7v-2h14Z" />
    </svg>
  );
}

async function uploadCardImage(file: File): Promise<{ url: string }> {
  validateUploadSize(file);
  const form = new FormData();
  form.append('file', file);
  // Card answers are written/reviewed in this editor; uploading its image never needs another OCR call.
  const response = await sessionFetch('/api/upload?purpose=card-image', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(AI_CLIENT_DEADLINE_MS),
  });
  const result = await response.json().catch(() => ({ error: '이미지를 저장하지 못했어요.' }));
  if (!response.ok) throw apiErrorOf(response, result, '이미지를 저장하지 못했어요.');
  return result.data;
}

export function CreateCard(props: ScreenProps) {
  const [type, setType] = useJourneyState<CardType>(
    'createCard.type',
    params(props.path).get('type') === 'BLIND' ? 'BLIND' : 'CONCEPT',
  );
  const [subject, setSubject] = useJourneyState(
    'createCard.subject',
    params(props.path).get('subject') || props.data.subjects[0]?.id || '',
  );
  const [front, setFront] = useJourneyState('createCard.front', '');
  const [back, setBack] = useJourneyState('createCard.back', '');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [history, dispatch] = useReducer(editOcclusion, undefined, () => initialOcclusion());
  const masks = history.masks;
  const masksRef = useRef(masks);
  masksRef.current = masks;
  const [tool, setTool] = useState<'draw' | 'move' | 'pen' | 'erase'>('draw');
  const [selection, setSelection] = useState<number | null>(null);
  const [showMasks, setShowMasks] = useState(true);
  const [hint, setHint] = useState('');
  const [draft, setDraft] = useState<Mask | null>(null);
  const [proposal, setProposal] = useState<(Mask & { answer: string })[] | null>(null);
  const proposalRequest = useRef<AbortController | null>(null);
  const drag = useRef<{
    mode: 'draw' | 'move' | 'resize' | 'pen' | 'erase';
    pointerId: number;
    start: { x: number; y: number };
    last: { x: number; y: number };
    index?: number;
    original?: Mask;
  } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const action = useAction();
  const aiAction = useAction();
  useEffect(() => () => proposalRequest.current?.abort(), []);
  async function suggestMasks() {
    if (!file) return;
    await aiAction.run(async () => {
      proposalRequest.current?.abort();
      const controller = new AbortController();
      proposalRequest.current = controller;
      const form = new FormData();
      form.append('file', file);
      // A user-initiated preview is one paid request, with no client retry.
      const response = await sessionFetch('/api/cards/occlusion-preview', {
        method: 'POST',
        body: form,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(AI_CLIENT_DEADLINE_MS)]),
      });
      const result = await response
        .json()
        .catch(() => ({ error: '가림 제안을 읽지 못했어요. 다시 시도해 주세요.' }));
      if (!response.ok) throw apiErrorOf(response, result, '가림 위치를 찾지 못했어요.');
      if (!Array.isArray(result.data?.regions)) throw new Error('가림 제안을 읽지 못했어요.');
      if (result.data.regions.length) {
        setProposal(result.data.regions);
        setShowMasks(true);
        setSelection(null);
      } else
        setHint(
          'AI가 확실히 읽을 수 있는 핵심 용어를 찾지 못했어요. 박스나 펜으로 직접 가려 주세요.',
        );
    });
  }
  function previewMasks(next: Mask[]) {
    masksRef.current = next;
    dispatch({ type: 'preview', masks: next });
  }
  function replaceMasks(next: Mask[]) {
    masksRef.current = next;
    dispatch({ type: 'replace', masks: next });
    setSelection(null);
  }
  function undo() {
    dispatch({ type: 'undo' });
    setSelection(null);
  }
  function redo() {
    dispatch({ type: 'redo' });
    setSelection(null);
  }
  useEffect(() => {
    if (!file) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  function position(e: PointerEvent) {
    const rect = canvas.current!.getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100)),
    };
  }
  function begin(e: PointerEvent, index?: number, resize = false) {
    if (!canvas.current || !showMasks || proposal || drag.current || !e.isPrimary || e.button !== 0)
      return;
    e.preventDefault();
    e.stopPropagation();
    canvas.current.setPointerCapture(e.pointerId);
    canvas.current.focus({ preventScroll: true });
    const point = position(e);
    dispatch({ type: 'begin' });
    if (index !== undefined && tool === 'move') {
      setSelection(index);
      drag.current = {
        mode: resize ? 'resize' : 'move',
        pointerId: e.pointerId,
        start: point,
        last: point,
        index,
        original: masks[index],
      };
    } else if (tool === 'draw' || tool === 'pen' || tool === 'erase') {
      setSelection(null);
      drag.current = { mode: tool, pointerId: e.pointerId, start: point, last: point };
      if (tool === 'pen') previewMasks(paintMasks(masksRef.current, point, point));
      if (tool === 'erase') previewMasks(eraseMasks(masksRef.current, point, point));
    } else {
      setSelection(null);
      dispatch({ type: 'cancel' });
      canvas.current.releasePointerCapture(e.pointerId);
    }
  }
  function moving(e: PointerEvent) {
    const active = drag.current;
    if (!active || e.pointerId !== active.pointerId) return;
    const point = position(e);
    if (active.mode === 'draw') setDraft(normalizeMask(active.start, point));
    else if (active.mode === 'pen') previewMasks(paintMasks(masksRef.current, active.last, point));
    else if (active.mode === 'erase')
      previewMasks(eraseMasks(masksRef.current, active.last, point));
    else if (active.index !== undefined && active.original) {
      const original = active.original;
      const next =
        active.mode === 'move'
          ? {
              ...original,
              x: Math.min(100 - original.width, Math.max(0, original.x + point.x - active.start.x)),
              y: Math.min(
                100 - original.height,
                Math.max(0, original.y + point.y - active.start.y),
              ),
            }
          : {
              ...original,
              width: Math.min(
                100 - original.x,
                Math.max(1, original.width + point.x - active.start.x),
              ),
              height: Math.min(
                100 - original.y,
                Math.max(1, original.height + point.y - active.start.y),
              ),
            };
      previewMasks(masksRef.current.map((mask, i) => (i === active.index ? next : mask)));
    }
    active.last = point;
  }
  function end(e: PointerEvent, cancelled = false) {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    if (cancelled) dispatch({ type: 'cancel' });
    else {
      if (drag.current?.mode === 'draw') {
        const mask = normalizeMask(drag.current.start, position(e));
        if (mask && masksRef.current.length < 100) previewMasks([...masksRef.current, mask]);
      } else if (drag.current.mode === 'erase') {
        previewMasks(eraseMasks(masksRef.current, drag.current.last, position(e)));
      }
      dispatch({ type: 'commit' });
    }
    setDraft(null);
    drag.current = null;
    if (canvas.current?.hasPointerCapture(e.pointerId))
      canvas.current.releasePointerCapture(e.pointerId);
  }
  function autoMask() {
    if (!image.current) return;
    const source = image.current;
    const element = document.createElement('canvas');
    const ratio = Math.min(1, 160 / Math.max(source.naturalWidth, source.naturalHeight));
    element.width = Math.max(1, Math.round(source.naturalWidth * ratio));
    element.height = Math.max(1, Math.round(source.naturalHeight * ratio));
    const context = element.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(source, 0, 0, element.width, element.height);
    const found = detectHighlights(
      context.getImageData(0, 0, element.width, element.height).data,
      element.width,
      element.height,
    );
    if (found.length) {
      replaceMasks(found);
      setShowMasks(true);
      setHint(
        `${masks.length ? '기존 가림을 바꾸고 ' : ''}형광펜 영역 ${found.length}곳을 가렸어요. 필요한 부분만 조정해 주세요.`,
      );
    } else setHint('뚜렷한 형광펜 영역을 찾지 못했어요. 박스를 그려 직접 가려 주세요.');
  }
  if (!props.data.subjects.length)
    return (
      <>
        <ScreenHeader title="카드 만들기" back={() => props.back('/flashcards')} />
        <EmptyState
          title="카드를 담을 과목이 필요해요"
          description="과목을 정하면 바로 카드 작성을 이어갈 수 있어요."
          action={
            <Button onClick={() => props.navigate('/subjects?create=card', { replace: true })}>
              과목 만들고 카드 작성
            </Button>
          }
        />
      </>
    );
  return (
    <>
      <ScreenHeader title="카드 만들기" back={() => props.back('/flashcards')} />
      <div className="page-inset pb-8">
        <section>
          <h2 className="mb-3 text-[13px] font-semibold text-muted">카드 종류</h2>
          <div className="grid grid-cols-2 gap-2">
            {(Object.entries(TYPES) as [CardType, (typeof TYPES)[CardType]][]).map(
              ([id, labels]) => (
                <button
                  key={id}
                  aria-pressed={type === id}
                  onClick={() => setType(id)}
                  className={`flex min-h-[76px] flex-col justify-center rounded-2xl px-4 py-3 text-left ${type === id ? 'bg-ink text-white' : 'bg-surface'}`}
                >
                  <span className="flex items-center justify-between text-[15px] font-bold">
                    {labels[0]}
                    {type === id && <Check size={17} />}
                  </span>
                  <span
                    className={`mt-1 text-[12px] ${type === id ? 'text-white/70' : 'text-muted'}`}
                  >
                    {labels[1]}
                  </span>
                </button>
              ),
            )}
          </div>
        </section>
        <div className="mt-6 space-y-5">
          <label className="block text-sm font-semibold">
            담을 과목
            <div className="mt-2">
              <SubjectSelect data={props.data} value={subject} onChange={setSubject} all={false} />
            </div>
          </label>
          {type === 'BLIND' && (
            <div className="space-y-3">
              <input
                ref={fileInput}
                className="hidden"
                type="file"
                disabled={aiAction.busy}
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  if (chosen)
                    void action.run(async () => {
                      validateUploadSize(chosen);
                      setFile(await imageFile(chosen));
                      dispatch({ type: 'reset', masks: [] });
                      masksRef.current = [];
                      setProposal(null);
                      setSelection(null);
                      setHint('');
                    });
                }}
              />
              {!preview ? (
                <button
                  onClick={() => fileInput.current?.click()}
                  className="flex min-h-44 w-full flex-col items-center justify-center gap-3 rounded-[24px] bg-surface"
                >
                  <ImagePlus size={30} />
                  <span className="text-sm font-semibold">가리고 싶은 이미지 선택</span>
                  <span className="text-xs text-muted">교과서, 도표, 수업 필기</span>
                </button>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">이미지 가림 편집</span>
                    <button
                      className="min-h-11 text-xs font-semibold text-muted"
                      disabled={aiAction.busy}
                      onClick={() => fileInput.current?.click()}
                    >
                      이미지 바꾸기
                    </button>
                  </div>
                  <div
                    ref={canvas}
                    onPointerDown={(e) => begin(e)}
                    onPointerMove={moving}
                    onPointerUp={end}
                    onPointerCancel={(e) => end(e, true)}
                    onLostPointerCapture={(e) => end(e, true)}
                    tabIndex={0}
                    aria-label="가림 편집 이미지. 이동 도구로 가림을 선택한 뒤 Delete 키로 삭제할 수 있어요."
                    onKeyDown={(e) => {
                      if (proposal) return;
                      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
                        e.preventDefault();
                        if (e.shiftKey) redo();
                        else undo();
                      } else if (
                        (e.key === 'Delete' || e.key === 'Backspace') &&
                        selection !== null
                      ) {
                        e.preventDefault();
                        replaceMasks(masks.filter((_, i) => i !== selection));
                      }
                    }}
                    className="relative touch-none select-none overflow-hidden rounded-2xl bg-surface"
                    style={{ cursor: tool === 'move' ? 'grab' : 'crosshair' }}
                  >
                    <img
                      ref={image}
                      src={preview}
                      alt="가림 카드 편집 이미지"
                      draggable={false}
                      className="block w-full"
                    />
                    {showMasks &&
                      [...(proposal ?? masks), ...(draft ? [draft] : [])].map((mask, i) => (
                        <div
                          key={i}
                          onPointerDown={(e) => begin(e, i)}
                          role={tool === 'move' && !proposal ? 'button' : undefined}
                          tabIndex={tool === 'move' && !proposal ? 0 : undefined}
                          aria-label={
                            tool === 'move' && !proposal
                              ? `가림 ${i + 1}. 방향키로 이동, Shift와 방향키로 크기 조절`
                              : undefined
                          }
                          onFocus={() => {
                            if (tool === 'move' && !proposal) setSelection(i);
                          }}
                          onKeyDown={(e) => {
                            if (
                              tool !== 'move' ||
                              proposal ||
                              !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
                            )
                              return;
                            e.preventDefault();
                            e.stopPropagation();
                            const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
                            const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
                            const next = e.shiftKey
                              ? {
                                  ...mask,
                                  width: Math.max(1, Math.min(100 - mask.x, mask.width + dx)),
                                  height: Math.max(1, Math.min(100 - mask.y, mask.height + dy)),
                                }
                              : {
                                  ...mask,
                                  x: Math.max(0, Math.min(100 - mask.width, mask.x + dx)),
                                  y: Math.max(0, Math.min(100 - mask.height, mask.y + dy)),
                                };
                            dispatch({
                              type: 'replace',
                              masks: masks.map((item, index) => (index === i ? next : item)),
                            });
                          }}
                          className={`absolute rounded-[3px] bg-brand/95 ${selection === i ? 'outline-2 outline-offset-1 outline-ink' : ''}`}
                          style={{
                            left: `${mask.x}%`,
                            top: `${mask.y}%`,
                            width: `${mask.width}%`,
                            height: `${mask.height}%`,
                            pointerEvents: tool === 'move' ? 'auto' : 'none',
                          }}
                        >
                          {proposal && (
                            <span className="absolute left-0 top-0 flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-full bg-ink px-1 text-[10px] font-bold text-white">
                              {i + 1}
                            </span>
                          )}
                          {selection === i && tool === 'move' && (
                            <span
                              onPointerDown={(e) => begin(e, i, true)}
                              className="absolute -right-2 -bottom-2 h-5 w-5 rounded-full border-2 border-white bg-ink cursor-nwse-resize"
                            />
                          )}
                        </div>
                      ))}
                  </div>
                  {proposal && (
                    <div
                      className="rounded-2xl bg-surface p-4"
                      role="region"
                      aria-label="AI 가림 제안 확인"
                    >
                      <strong className="text-sm">AI가 찾은 가림 {proposal.length}개</strong>
                      <p className="mt-1 text-xs leading-relaxed text-muted">
                        가려진 글자와 위치를 확인해 주세요. 적용 후 박스를 옮기거나 지울 수 있어요.
                      </p>
                      <ol className="my-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                        {proposal.map((item, i) => (
                          <li key={i}>
                            {i + 1}. {item.answer}
                          </li>
                        ))}
                      </ol>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          className="flex-1 !text-xs"
                          onClick={() => {
                            replaceMasks(
                              proposal.map(({ x, y, width, height }) => ({ x, y, width, height })),
                            );
                            if (!front.trim()) setFront('가려진 핵심 용어를 떠올려 보세요.');
                            if (!back.trim())
                              setBack(
                                proposal.map((item, i) => `${i + 1}. ${item.answer}`).join('\n'),
                              );
                            setProposal(null);
                            setTool('move');
                            setHint(
                              '가림 위치와 답을 확인하고 저장해 주세요. 기존 가림은 실행 취소로 되돌릴 수 있어요.',
                            );
                          }}
                        >
                          {masks.length ? '기존 가림을 바꾸고 적용' : '이 가림 적용'}
                        </Button>
                        <Button
                          variant="secondary"
                          className="!text-xs"
                          onClick={() => setProposal(null)}
                        >
                          취소
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="flex gap-1 rounded-2xl bg-surface p-1">
                    {(
                      [
                        { id: 'draw', label: '박스', Icon: Square },
                        { id: 'move', label: '이동', Icon: Move },
                        { id: 'pen', label: '펜', Icon: PenLine },
                        { id: 'erase', label: '지우개', Icon: EraserIcon },
                      ] as const
                    ).map(({ id, label, Icon }) => (
                      <button
                        key={id}
                        disabled={!!proposal}
                        onClick={() => {
                          setTool(id);
                          setShowMasks(true);
                        }}
                        aria-pressed={tool === id}
                        className={`flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-xl text-[12px] font-semibold ${tool === id ? 'bg-ink text-white' : 'text-muted'}`}
                      >
                        <Icon size={17} />
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="flex min-h-11 items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <IconButton
                        label="편집 실행 취소"
                        disabled={!history.past.length || !!proposal}
                        onClick={undo}
                      >
                        <Undo2 size={18} />
                      </IconButton>
                      <IconButton
                        label="편집 다시 실행"
                        disabled={!history.future.length || !!proposal}
                        onClick={redo}
                      >
                        <RotateCw size={18} />
                      </IconButton>
                    </div>
                    <button
                      className="flex min-h-11 items-center gap-1.5 rounded-xl bg-surface px-3 text-xs font-semibold disabled:opacity-40"
                      disabled={selection === null || !!proposal}
                      onClick={() => replaceMasks(masks.filter((_, i) => i !== selection))}
                    >
                      <Trash2 size={15} />
                      선택한 가림 삭제
                    </button>
                  </div>
                  <p className="text-xs leading-relaxed text-muted">
                    {proposal
                      ? 'AI 제안을 먼저 적용하거나 취소하면 직접 편집할 수 있어요.'
                      : tool === 'draw'
                        ? '이미지 위를 드래그해 가릴 영역을 그려 주세요.'
                        : tool === 'move'
                          ? '박스를 눌러 이동하고, 검정 점을 끌어 크기를 바꿔요.'
                          : tool === 'erase'
                            ? '지우개로 누르거나 쓸면 닿은 가림이 지워져요. 실행 취소로 되돌릴 수 있어요.'
                            : '가리고 싶은 부분을 손가락으로 칠해 주세요.'}
                  </p>
                  <Button
                    variant="secondary"
                    className="w-full !text-sm"
                    disabled={aiAction.busy || aiAction.retryIn > 0 || !!proposal}
                    onClick={suggestMasks}
                  >
                    {aiAction.busy ? (
                      <BusyText>AI가 가릴 용어를 찾고 있어요</BusyText>
                    ) : (
                      <>
                        <Sparkles size={17} />
                        {waitingLabel('AI로 가림 위치 찾기', aiAction.retryIn)}
                      </>
                    )}
                  </Button>
                  <ErrorNote error={aiAction.error} />
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      className="flex-1 !px-2 !text-[12px]"
                      onClick={autoMask}
                      disabled={!!proposal}
                    >
                      <ScanLine size={16} />
                      형광펜 자동 감지
                    </Button>
                    <Button
                      variant="secondary"
                      className="flex-1 !px-2 !text-[12px]"
                      onClick={() => setShowMasks((v) => !v)}
                      disabled={!!proposal}
                    >
                      {showMasks ? '원본 미리보기' : '가림 미리보기'}
                    </Button>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span>
                      {proposal
                        ? `AI 제안 ${proposal.length}개 · 적용 전`
                        : `가림 ${masks.length}개 / 최대 100개`}
                    </span>
                    <button
                      className="min-h-11 font-semibold"
                      disabled={!masks.length || !!proposal}
                      onClick={() => {
                        replaceMasks([]);
                      }}
                    >
                      모두 지우기
                    </button>
                  </div>
                  {hint && (
                    <p role="status" className="rounded-2xl bg-surface p-3 text-xs leading-relaxed">
                      {hint}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          <label className="block text-sm font-semibold">
            {TYPES[type][2]}
            <textarea
              className="field mt-2 min-h-28 resize-y"
              value={front}
              onChange={(e) => setFront(e.target.value)}
              maxLength={2000}
              placeholder={
                type === 'BLIND'
                  ? '가려진 부분은 무엇일까요?'
                  : type === 'RELATION'
                    ? '어떤 변화가 시작점인가요?'
                    : type === 'COMPARISON'
                      ? '예: 확산과 삼투의 차이는?'
                      : '예: 삼투 현상이 일어나는 조건은?'
              }
            />
          </label>
          <label className="block text-sm font-semibold">
            {TYPES[type][3]}
            <textarea
              className="field mt-2 min-h-36 resize-y"
              value={back}
              onChange={(e) => setBack(e.target.value)}
              maxLength={4000}
              placeholder="나중의 내가 이해할 수 있도록 적어 주세요"
            />
          </label>
          <ErrorNote error={action.error} />
          <p className="rounded-2xl bg-surface p-4 text-xs leading-relaxed text-muted">
            가림 카드도 다른 카드와 같은 복습 간격을 사용해요. 저장한 뒤 카드 보관함의 ‘복습
            설정’에서 함께 바꿀 수 있어요.
          </p>
          <Button
            className="w-full"
            disabled={
              !subject ||
              !front.trim() ||
              !back.trim() ||
              action.busy ||
              aiAction.busy ||
              !!proposal ||
              action.retryIn > 0 ||
              (type === 'BLIND' && (!file || !masks.length))
            }
            onClick={() =>
              action.run(async () => {
                const upload = type === 'BLIND' && file ? await uploadCardImage(file) : undefined;
                await api('/cards', {
                  subjectId: subject,
                  front: front.trim(),
                  back: back.trim(),
                  type,
                  ...(upload ? { image: upload.url, masks } : {}),
                });
                await props.refresh();
                props.toast('새 카드를 만들었어요');
                setFront('');
                setBack('');
                props.navigate(`/flashcards?subject=${subject}`, { replace: true });
              })
            }
          >
            {action.busy ? (
              <BusyText>카드를 저장하고 있어요</BusyText>
            ) : (
              waitingLabel('카드 저장하기', action.retryIn)
            )}
          </Button>
        </div>
      </div>
    </>
  );
}
