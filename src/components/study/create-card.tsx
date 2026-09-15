'use client';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  Check,
  ImagePlus,
  Move,
  PenLine,
  Plus,
  ScanLine,
  Square,
  Trash2,
  Undo2,
} from '@/components/icons';
import type { CardType, Mask, ScreenProps } from '@/lib/contracts';
import { Button, EmptyState, IconButton, ScreenHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { detectHighlights, normalizeMask, TYPES } from './logic';
import {
  BusyText,
  ErrorNote,
  imageFile,
  params,
  SubjectSelect,
  uploadFile,
  useAction,
  validateUploadSize,
} from './shared';

export function CreateCard(props: ScreenProps) {
  const [type, setType] = useState<CardType>('CONCEPT');
  const [subject, setSubject] = useState(
    params(props.path).get('subject') || props.data.subjects[0]?.id || '',
  );
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [masks, setMasks] = useState<Mask[]>([]);
  const [tool, setTool] = useState<'draw' | 'move' | 'pen'>('draw');
  const [selection, setSelection] = useState<number | null>(null);
  const [showMasks, setShowMasks] = useState(true);
  const [hint, setHint] = useState('');
  const [draft, setDraft] = useState<Mask | null>(null);
  const drag = useRef<{
    mode: 'draw' | 'move' | 'resize' | 'pen';
    start: { x: number; y: number };
    index?: number;
    original?: Mask;
  } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const action = useAction();
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
    if (!canvas.current || !showMasks) return;
    e.preventDefault();
    e.stopPropagation();
    canvas.current.setPointerCapture(e.pointerId);
    const point = position(e);
    if (index !== undefined && tool === 'move') {
      setSelection(index);
      drag.current = {
        mode: resize ? 'resize' : 'move',
        start: point,
        index,
        original: masks[index],
      };
    } else if (tool === 'draw' || tool === 'pen') {
      setSelection(null);
      drag.current = { mode: tool, start: point };
      if (tool === 'pen')
        setMasks((current) => [
          ...current,
          {
            x: Math.max(0, point.x - 2),
            y: Math.max(0, point.y - 1),
            width: Math.min(4, 100 - point.x + 2),
            height: Math.min(2, 100 - point.y + 1),
          },
        ]);
    }
  }
  function moving(e: PointerEvent) {
    const active = drag.current;
    if (!active) return;
    const point = position(e);
    if (active.mode === 'draw') setDraft(normalizeMask(active.start, point));
    else if (active.mode === 'pen') {
      setMasks((current) =>
        current.length >= 100
          ? current
          : [
              ...current,
              {
                x: Math.max(0, point.x - 2),
                y: Math.max(0, point.y - 1.5),
                width: Math.min(4, 100 - Math.max(0, point.x - 2)),
                height: Math.min(3, 100 - Math.max(0, point.y - 1.5)),
              },
            ],
      );
    } else if (active.index !== undefined && active.original) {
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
      setMasks((current) => current.map((mask, i) => (i === active.index ? next : mask)));
    }
  }
  function end(e: PointerEvent) {
    if (drag.current?.mode === 'draw') {
      const mask = normalizeMask(drag.current.start, position(e));
      if (mask) setMasks((current) => (current.length < 100 ? [...current, mask] : current));
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
      setMasks(found);
      setShowMasks(true);
      setHint(
        `${masks.length ? '기존 가림을 바꾸고 ' : ''}형광펜 영역 ${found.length}곳을 가렸어요. 필요한 부분만 조정해 주세요.`,
      );
    } else setHint('뚜렷한 형광펜 영역을 찾지 못했어요. 박스를 그려 직접 가려 주세요.');
  }
  if (!props.data.subjects.length)
    return (
      <>
        <ScreenHeader title="카드 만들기" back={() => props.navigate('/flashcards')} />
        <EmptyState
          title="카드를 담을 과목이 필요해요"
          description="학습에서 과목을 하나 만든 뒤 카드를 추가해 주세요."
          action={<Button onClick={() => props.navigate('/subjects')}>과목 만들러 가기</Button>}
        />
      </>
    );
  return (
    <>
      <ScreenHeader title="카드 만들기" back={() => props.navigate('/flashcards')} />
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
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  if (chosen)
                    void action.run(async () => {
                      validateUploadSize(chosen);
                      setFile(await imageFile(chosen));
                      setMasks([]);
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
                    onPointerCancel={end}
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
                      [...masks, ...(draft ? [draft] : [])].map((mask, i) => (
                        <div
                          key={i}
                          onPointerDown={(e) => begin(e, i)}
                          className={`absolute rounded-[3px] bg-brand/95 ${selection === i ? 'outline-2 outline-offset-1 outline-ink' : ''}`}
                          style={{
                            left: `${mask.x}%`,
                            top: `${mask.y}%`,
                            width: `${mask.width}%`,
                            height: `${mask.height}%`,
                            pointerEvents: tool === 'move' ? 'auto' : 'none',
                          }}
                        >
                          {selection === i && tool === 'move' && (
                            <span
                              onPointerDown={(e) => begin(e, i, true)}
                              className="absolute -right-2 -bottom-2 h-5 w-5 rounded-full border-2 border-white bg-ink cursor-nwse-resize"
                            />
                          )}
                        </div>
                      ))}
                  </div>
                  <div className="flex gap-1 rounded-2xl bg-surface p-1">
                    {(
                      [
                        { id: 'draw', label: '박스', Icon: Square },
                        { id: 'move', label: '이동', Icon: Move },
                        { id: 'pen', label: '펜', Icon: PenLine },
                      ] as const
                    ).map(({ id, label, Icon }) => (
                      <button
                        key={id}
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
                    <IconButton
                      label="마지막 가림 지우기"
                      disabled={!masks.length}
                      onClick={() => {
                        setMasks((current) => current.slice(0, -1));
                        setSelection(null);
                      }}
                    >
                      <Undo2 size={18} />
                    </IconButton>
                  </div>
                  <p className="text-xs leading-relaxed text-muted">
                    {tool === 'draw'
                      ? '이미지 위를 드래그해 가릴 영역을 그려 주세요.'
                      : tool === 'move'
                        ? '박스를 눌러 이동하고, 검정 점을 끌어 크기를 바꿔요.'
                        : '가리고 싶은 부분을 손가락으로 칠해 주세요.'}
                  </p>
                  {selection !== null && (
                    <button
                      className="min-h-11 text-xs font-semibold"
                      onClick={() => {
                        setMasks((current) => current.filter((_, i) => i !== selection));
                        setSelection(null);
                      }}
                    >
                      <Trash2 size={14} className="mr-1 inline" />
                      선택한 가림 삭제
                    </button>
                  )}
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      className="flex-1 !px-2 !text-[12px]"
                      onClick={autoMask}
                    >
                      <ScanLine size={16} />
                      형광펜 자동 감지
                    </Button>
                    <Button
                      variant="secondary"
                      className="flex-1 !px-2 !text-[12px]"
                      onClick={() => setShowMasks((v) => !v)}
                    >
                      {showMasks ? '원본 미리보기' : '가림 미리보기'}
                    </Button>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span>가림 {masks.length}개 / 최대 100개</span>
                    <button
                      className="min-h-11 font-semibold"
                      disabled={!masks.length}
                      onClick={() => {
                        setMasks([]);
                        setSelection(null);
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
          <Button
            className="w-full"
            disabled={
              !subject ||
              !front.trim() ||
              !back.trim() ||
              action.busy ||
              (type === 'BLIND' && (!file || !masks.length))
            }
            onClick={() =>
              action.run(async () => {
                const upload = type === 'BLIND' && file ? await uploadFile(file) : undefined;
                await api('/cards', {
                  subjectId: subject,
                  front: front.trim(),
                  back: back.trim(),
                  type,
                  ...(upload ? { image: upload.url, masks } : {}),
                });
                await props.refresh();
                props.toast('새 카드를 만들었어요');
                props.navigate(`/flashcards?subject=${subject}`);
              })
            }
          >
            {action.busy ? <BusyText>카드를 저장하고 있어요</BusyText> : '카드 저장하기'}
          </Button>
        </div>
      </div>
    </>
  );
}
