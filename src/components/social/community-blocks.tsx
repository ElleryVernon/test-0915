'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronRight, Trash2 } from '@/components/icons';
import { Button, IconButton, Sheet } from '@/components/ui';
import { Checkbox } from '@/components/ui-choice';
import { api } from '@/lib/api';
import { fetchMaterialDetail } from '@/lib/materials';
import type { AppData, Card, Mask, Navigate, Schedule } from '@/lib/contracts';
import type { CommunityBlock, CommunityBlockType } from '@/lib/community-types';
import { DiagramCardContent } from '../study/explanation-card';
import styles from './community-blocks.module.css';

export const BLOCK_LABELS: Record<CommunityBlockType, string> = {
  QUESTION: '문제',
  CARD: '복습 카드',
  MATERIAL: '자료 발췌',
  PHOTO: '사진 · 필기',
  ESSAY: '서술형 답안',
  POLL: '투표',
  SCHEDULE: '시간표',
  MATH: '수식',
};
export function allowedBlockTypes(role: string, comment = false): CommunityBlockType[] {
  if (role === 'PARENT') return comment ? ['PHOTO'] : ['PHOTO', 'POLL'];
  return comment
    ? ['QUESTION', 'CARD', 'PHOTO', 'MATH']
    : (Object.keys(BLOCK_LABELS) as CommunityBlockType[]);
}
export function blockSummary(blocks: CommunityBlock[] = []) {
  const counts = new Map<CommunityBlockType, number>();
  for (const b of blocks) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => `${BLOCK_LABELS[type]} ${count}`).join(' · ');
}
/** Uses real sentence boundaries, including Korean punctuation, rather than clipping an excerpt. */
export function excerptSentences(text: string): string[] {
  return [...new Intl.Segmenter('ko', { granularity: 'sentence' }).segment(text)]
    .flatMap(({ segment }) => segment.split(/\n+/))
    .map((s) => s.trim())
    .filter(Boolean);
}
export function excerptSelection(source: string, indices: number[]): string {
  const parts = excerptSentences(source);
  const selected = [...new Set(indices)].sort((a, b) => a - b);
  if (
    !selected.length ||
    selected.length > 3 ||
    selected.some((n, i) => n < 0 || n >= parts.length || (i > 0 && n !== selected[i - 1] + 1))
  )
    return '';
  let offset = 0,
    start = -1,
    end = -1;
  for (let i = 0; i <= selected[selected.length - 1]; i++) {
    const found = source.indexOf(parts[i], offset);
    if (found < 0) return '';
    if (i === selected[0]) start = found;
    offset = found + parts[i].length;
    if (i === selected[selected.length - 1]) end = offset;
  }
  const excerpt = source.slice(start, end);
  return excerpt.length <= 2000 ? excerpt : '';
}
export function safeScheduleRows(rows: Schedule[]) {
  return rows.map(({ title, start, end, kind, date }) => ({
    title: kind === 'FIXED' ? '학교' : title,
    start,
    end,
    kind,
    date,
  }));
}
export function photoFileError(file: Pick<File, 'size' | 'type'>): string {
  if (file.size > 10 * 1024 * 1024) return '사진은 10MB 이하로 선택해 주세요.';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    return 'JPG, PNG, WebP 사진을 선택해 주세요.';
  return '';
}
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const message = (error: unknown) =>
  error instanceof Error ? error.message : '잠시 후 다시 시도해 주세요.';
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const makeBlock = (
  type: CommunityBlockType,
  payload: CommunityBlock['payload'],
  refId?: string,
): CommunityBlock => ({
  id: crypto.randomUUID(),
  type,
  payload,
  ...(refId ? { refId } : {}),
  hidden: type === 'QUESTION' || type === 'CARD',
});

export function BlockPicker({
  data,
  open,
  onClose,
  onAdd,
  remaining,
  comment = false,
  photoCount = 0,
}: {
  data: AppData;
  open: boolean;
  onClose: () => void;
  onAdd: (block: CommunityBlock) => void;
  remaining: number;
  comment?: boolean;
  photoCount?: number;
}) {
  const types = allowedBlockTypes(data.profile.role, comment);
  const [type, setType] = useState<CommunityBlockType>(types[0]);
  const [candidate, setCandidate] = useState<CommunityBlock | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sentences, setSentences] = useState<string[]>([]);
  const [sourceText, setSourceText] = useState('');
  const [selectedSentences, setSelectedSentences] = useState<number[]>([]);
  const [math, setMath] = useState('');
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);
  const [date, setDate] = useState(today);
  const [rowIds, setRowIds] = useState<string[]>([]);
  const loadId = useRef(0);
  useEffect(() => {
    if (!open) {
      loadId.current++;
      setCandidate(null);
      setError('');
      setLoading(false);
    }
  }, [open]);
  const chooseType = (next: CommunityBlockType) => {
    loadId.current++;
    setType(next);
    setCandidate(null);
    setQuery('');
    setError('');
    setLoading(false);
    setSentences([]);
    setSelectedSentences([]);
    setRowIds([]);
  };
  const subject = (id: string) => data.subjects.find((s) => s.id === id)?.name ?? '';
  const match = (value: string) =>
    value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const chooseMaterial = async (id: string) => {
    const source = data.materials.find((m) => m.id === id);
    if (!source) return;
    const current = ++loadId.current;
    setLoading(true);
    setError('');
    setCandidate(null);
    try {
      const detail = await fetchMaterialDetail(source);
      if (loadId.current !== current) return;
      const parts = excerptSentences(detail.content);
      setSentences(parts);
      setSourceText(detail.content);
      setSelectedSentences([]);
      setCandidate(
        makeBlock(
          'MATERIAL',
          { title: source.title, text: '', subjectName: subject(source.subjectId) },
          id,
        ),
      );
      if (!parts.length) setError('이 자료에는 발췌할 본문이 없어요. 사진으로 첨부할 수 있어요.');
    } catch (e) {
      if (loadId.current === current) setError(message(e));
    } finally {
      if (loadId.current === current) setLoading(false);
    }
  };
  const scheduleRows = data.schedules
    .filter((row) => row.date === date)
    .sort((a, b) => a.start.localeCompare(b.start));
  const build = (): CommunityBlock | null => {
    if (type === 'MATH') return math.trim() ? makeBlock('MATH', { text: math.trim() }) : null;
    if (type === 'POLL') {
      const options = pollOptions.map((o) => o.trim());
      return pollQuestion.trim() &&
        options.every(Boolean) &&
        new Set(options).size === options.length
        ? makeBlock('POLL', {
            question: pollQuestion.trim(),
            options,
            closesAt: new Date(Date.now() + 86400000).toISOString(),
          })
        : null;
    }
    if (type === 'SCHEDULE')
      return rowIds.length
        ? makeBlock('SCHEDULE', {
            rows: safeScheduleRows(scheduleRows.filter((r) => rowIds.includes(r.id))),
          })
        : null;
    if (type === 'MATERIAL' && candidate)
      return selectedSentences.length
        ? {
            ...candidate,
            payload: {
              ...candidate.payload,
              text: excerptSelection(sourceText, selectedSentences),
            },
          }
        : null;
    return candidate;
  };
  // Building a block generates its durable ID only at confirmation, not on every render.
  const valid =
    type === 'MATH'
      ? !!math.trim()
      : type === 'POLL'
        ? !!pollQuestion.trim() &&
          pollOptions.every((o) => o.trim()) &&
          new Set(pollOptions.map((o) => o.trim())).size === pollOptions.length
        : type === 'SCHEDULE'
          ? rowIds.length > 0
          : type === 'MATERIAL'
            ? !!excerptSelection(sourceText, selectedSentences)
            : !!candidate;
  const rows: { id: string; title: string; meta: string; select: () => void }[] =
    type === 'QUESTION'
      ? data.questions
          .filter((q) => match(q.prompt + subject(q.subjectId)))
          .map((q) => ({
            id: q.id,
            title: q.prompt,
            meta: subject(q.subjectId),
            select: () => {
              const attempt = data.attempts
                .filter((a) => a.questionId === q.id)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
              const selected =
                attempt && /^\d+$/.test(attempt.answer) ? Number(attempt.answer) : undefined;
              setCandidate(
                makeBlock(
                  'QUESTION',
                  {
                    prompt: q.prompt,
                    options: q.options,
                    answer: q.answer,
                    explanation: q.explanation,
                    citation: q.citation,
                    subjectName: subject(q.subjectId),
                    ...(selected === undefined ? {} : { selected }),
                  },
                  q.id,
                ),
              );
            },
          }))
      : type === 'CARD'
        ? data.cards
            .filter((c) => !c.deleted && match(c.front + subject(c.subjectId)))
            .map((c) => ({
              id: c.id,
              title: c.front,
              meta: `${subject(c.subjectId)} · ${c.diagram || c.type === 'BLIND' ? '가림 카드' : '복습 카드'}`,
              select: () =>
                setCandidate(
                  makeBlock(
                    'CARD',
                    {
                      front: c.front,
                      back: c.back,
                      type: c.type,
                      diagram: c.diagram,
                      maskedNodeIds: c.maskedNodeIds,
                      image: c.image,
                      masks: c.masks,
                      subjectName: subject(c.subjectId),
                    },
                    c.id,
                  ),
                ),
            }))
        : type === 'MATERIAL'
          ? data.materials
              .filter((m) => match(m.title + subject(m.subjectId)))
              .map((m) => ({
                id: m.id,
                title: m.title,
                meta: subject(m.subjectId),
                select: () => void chooseMaterial(m.id),
              }))
          : type === 'ESSAY'
            ? data.essays.flatMap((e) => {
                const attempt = data.attempts
                  .filter((a) => a.essayId === e.id)
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
                if (!attempt || !match(e.prompt + subject(e.subjectId))) return [];
                return [
                  {
                    id: e.id,
                    title: e.prompt,
                    meta: `${subject(e.subjectId)} · 내 답안 ${attempt.answer.length}자`,
                    select: () =>
                      setCandidate(
                        makeBlock(
                          'ESSAY',
                          {
                            prompt: e.prompt,
                            answer: attempt.answer,
                            score: attempt.score,
                            subjectName: subject(e.subjectId),
                          },
                          e.id,
                        ),
                      ),
                  },
                ];
              })
            : [];
  const learning = ['QUESTION', 'CARD', 'MATERIAL', 'ESSAY'].includes(type);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={comment ? '댓글에 첨부하기' : '내 공부 첨부하기'}
      description={`첨부 ${Math.max(0, (comment ? 1 : 5) - remaining)} / ${comment ? 1 : 5}`}
      fullScreen
    >
      <div className={styles.picker}>
        <div className={styles.typeGrid} role="group" aria-label="첨부 종류">
          {types.map((kind) => (
            <button
              className={styles.typeButton}
              type="button"
              key={kind}
              aria-pressed={type === kind}
              onClick={() => chooseType(kind)}
            >
              {BLOCK_LABELS[kind]}
            </button>
          ))}
        </div>
        {remaining <= 0 && (
          <p role="status" className={styles.note}>
            첨부는 {comment ? '1개' : '5개'}까지예요. 기존 첨부를 하나 빼면 더 넣을 수 있어요.
          </p>
        )}
        {learning && (
          <>
            <label className={styles.field}>
              내 {BLOCK_LABELS[type]} 찾기
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="제목이나 과목으로 검색"
              />
            </label>
            <div className={styles.pickList}>
              {rows.map((row) => (
                <button
                  type="button"
                  key={row.id}
                  className={styles.pickRow}
                  aria-pressed={candidate?.refId === row.id}
                  onClick={row.select}
                >
                  <span>
                    <strong>{row.title}</strong>
                    <small>{row.meta}</small>
                  </span>
                  {candidate?.refId === row.id ? <Check size={20} /> : <ChevronRight size={20} />}
                </button>
              ))}
            </div>
            {!rows.length && (
              <div className={styles.empty}>
                <p>
                  {query
                    ? '검색 결과가 없어요.'
                    : type === 'ESSAY'
                      ? '제출한 서술형 답안이 아직 없어요.'
                      : `아직 내 ${BLOCK_LABELS[type]}가 없어요.`}
                </p>
                <button
                  type="button"
                  className={styles.outline}
                  onClick={() => chooseType('PHOTO')}
                >
                  사진으로 대신 첨부
                </button>
              </div>
            )}
          </>
        )}
        {loading && (
          <p role="status" className={styles.note}>
            자료 본문을 불러오고 있어요.
          </p>
        )}
        {type === 'MATERIAL' && candidate && (
          <div className={styles.group}>
            <strong>공유할 연속 문장 선택 · {selectedSentences.length} / 3</strong>
            <p className={styles.note}>
              연속된 문장 최대 3개 · 2,000자까지 공개돼요. 원본 자료는 나만 열 수 있어요.
            </p>
            <div className={styles.sentences}>
              {sentences.map((sentence, i) => (
                <Checkbox
                  key={i}
                  checked={selectedSentences.includes(i)}
                  disabled={selectedSentences.length === 3 && !selectedSentences.includes(i)}
                  onChange={(checked) => {
                    setError('');
                    setSelectedSentences((previous) => {
                      if (!checked) return previous.filter((n) => n < i);
                      if (!previous.length) return [i];
                      const low = Math.min(...previous, i),
                        high = Math.max(...previous, i);
                      return high - low < 3
                        ? Array.from({ length: high - low + 1 }, (_, n) => low + n)
                        : [i];
                    });
                  }}
                >
                  {sentence}
                </Checkbox>
              ))}
            </div>
            {selectedSentences.length > 0 && !excerptSelection(sourceText, selectedSentences) && (
              <p className={styles.note}>선택한 내용이 2,000자를 넘어요. 더 짧게 선택해 주세요.</p>
            )}
          </div>
        )}
        {type === 'PHOTO' &&
          (photoCount >= 4 ? (
            <p className={styles.note}>사진은 한 글에 4장까지 첨부할 수 있어요.</p>
          ) : (
            <PhotoEditor
              onReady={(image, caption) =>
                setCandidate(image ? makeBlock('PHOTO', { image, caption }) : null)
              }
            />
          ))}
        {type === 'MATH' && (
          <div className={styles.group}>
            <label className={styles.field}>
              수식
              <textarea
                value={math}
                maxLength={2000}
                rows={4}
                onChange={(e) => setMath(e.target.value)}
                placeholder="예: f′(a) = lim (h → 0) [f(a+h) − f(a)] / h"
              />
            </label>
            <div className={styles.tokens} aria-label="수학 기호">
              {['( ) / ( )', '²', '√( )', 'lim', '→', '∑', 'π', '∞'].map((token) => (
                <button
                  type="button"
                  className={styles.outline}
                  key={token}
                  onClick={() => setMath((s) => `${s}${token}`)}
                >
                  {token}
                </button>
              ))}
            </div>
            <p className={styles.note}>
              수학 기호를 그대로 표시해요. LaTeX 명령어 변환은 지원하지 않아요.
            </p>
            {math && <pre className={styles.math}>{math}</pre>}
          </div>
        )}
        {type === 'POLL' && (
          <div className={styles.group}>
            <label className={styles.field}>
              투표 질문
              <input
                value={pollQuestion}
                maxLength={200}
                onChange={(e) => setPollQuestion(e.target.value)}
                placeholder="어떤 의견이 궁금한가요?"
              />
            </label>
            {pollOptions.map((option, i) => (
              <div key={i} className={styles.inline}>
                <label className={styles.field}>
                  선택지 {i + 1}
                  <input
                    maxLength={100}
                    value={option}
                    onChange={(e) =>
                      setPollOptions((values) =>
                        values.map((v, n) => (n === i ? e.target.value : v)),
                      )
                    }
                  />
                </label>
                {pollOptions.length > 2 && (
                  <IconButton
                    label={`선택지 ${i + 1} 삭제`}
                    onClick={() => setPollOptions((values) => values.filter((_, n) => n !== i))}
                  >
                    <Trash2 size={18} />
                  </IconButton>
                )}
              </div>
            ))}
            {pollOptions.length < 4 && (
              <button
                type="button"
                className={styles.outline}
                onClick={() => setPollOptions((s) => [...s, ''])}
              >
                선택지 추가
              </button>
            )}
            <p className={styles.note}>
              서로 다른 선택지 2~4개 · 게시 후 24시간 동안 1인 1표예요. 투표한 뒤 결과를 볼 수
              있어요.
            </p>
          </div>
        )}
        {type === 'SCHEDULE' && (
          <div className={styles.group}>
            <label className={styles.field}>
              가져올 날짜
              <input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setRowIds([]);
                }}
              />
            </label>
            <p className={styles.note}>
              최대 6개 선택 · 고정 일정 이름은 ‘학교’로 바뀌어요. 읽는 사람은 자율 일정만 담을 수
              있어요.
            </p>
            {scheduleRows.map((row) => (
              <Checkbox
                key={row.id}
                checked={rowIds.includes(row.id)}
                disabled={rowIds.length >= 6 && !rowIds.includes(row.id)}
                onChange={(checked) =>
                  setRowIds((ids) =>
                    checked ? [...ids, row.id].slice(0, 6) : ids.filter((id) => id !== row.id),
                  )
                }
              >
                {row.start}–{row.end} · {row.kind === 'FIXED' ? '학교' : row.title}
              </Checkbox>
            ))}
            {!scheduleRows.length && (
              <p className={styles.empty}>이 날짜에는 일정이 없어요. 다른 날짜를 선택해 주세요.</p>
            )}
          </div>
        )}
        {candidate && type !== 'PHOTO' && type !== 'MATERIAL' && (
          <div className={styles.group}>
            <p className={styles.note}>첨부 미리보기</p>
            <BlockView block={candidate} data={data} navigate={() => {}} toast={() => {}} preview />
            {['QUESTION', 'CARD'].includes(candidate.type) && (
              <Checkbox
                checked={candidate.hidden}
                onChange={(hidden) => setCandidate({ ...candidate, hidden })}
              >
                정답을 가려서 올리기
              </Checkbox>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={!valid || loading || remaining <= 0 || (type === 'PHOTO' && photoCount >= 4)}
          onClick={() => {
            const block = build();
            if (block) {
              onAdd(block);
              setCandidate(null);
              setMath('');
              setPollQuestion('');
              setPollOptions(['', '']);
              onClose();
            }
          }}
        >
          {BLOCK_LABELS[type]} 1개 첨부하기
        </Button>
      </div>
    </Sheet>
  );
}

type Rect = { x: number; y: number; width: number; height: number };
async function decodeImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}
function encodePhoto(canvas: HTMLCanvasElement): string {
  for (let resize = 0; resize < 4; resize++) {
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const encoded = canvas.toDataURL('image/jpeg', quality);
      if (encoded.length <= 600_000) return encoded;
    }
    const reduced = document.createElement('canvas');
    reduced.width = Math.max(1, Math.floor(canvas.width * 0.75));
    reduced.height = Math.max(1, Math.floor(canvas.height * 0.75));
    const ctx = reduced.getContext('2d');
    if (!ctx) throw new Error('사진을 처리할 수 없어요.');
    ctx.drawImage(canvas, 0, 0, reduced.width, reduced.height);
    canvas = reduced;
  }
  throw new Error('사진 용량을 줄이지 못했어요. 더 작은 사진을 선택해 주세요.');
}
async function compressedPhoto(file: File) {
  const source = URL.createObjectURL(file);
  try {
    const image = await decodeImage(source);
    if (image.naturalWidth * image.naturalHeight > 80_000_000)
      throw new Error('사진 해상도가 너무 커요. 작은 크기로 저장해 주세요.');
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('사진을 처리할 수 없어요.');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Re-encoding strips EXIF/location metadata; only the flattened result is sent with the post.
    return encodePhoto(canvas);
  } finally {
    URL.revokeObjectURL(source);
  }
}
function PhotoEditor({ onReady }: { onReady: (image: string, caption: string) => void }) {
  const [image, setImage] = useState('');
  const [original, setOriginal] = useState('');
  const [caption, setCaption] = useState('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rect, setRect] = useState<Rect>({ x: 10, y: 10, width: 30, height: 20 });
  const [tool, setTool] = useState<'redact' | 'crop'>('redact');
  const start = useRef<{ x: number; y: number } | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const notify = (nextImage: string, nextCaption: string, verified: boolean) =>
    onReady(verified ? nextImage : '', nextCaption);
  const pick = async (file?: File) => {
    if (!file) return;
    const validation = photoFileError(file);
    if (validation) {
      setError(validation);
      return;
    }
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setChecked(false);
    onReady('', caption);
    try {
      const result = await compressedPhoto(file);
      if (current !== generation.current) return;
      setImage(result);
      setOriginal(result);
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100)),
    };
  };
  const apply = async () => {
    if (!image || busy || rect.width < 1 || rect.height < 1) return;
    setBusy(true);
    setError('');
    const current = ++generation.current;
    try {
      const source = await decodeImage(image);
      const canvas = document.createElement('canvas');
      const x = Math.round((source.width * rect.x) / 100),
        y = Math.round((source.height * rect.y) / 100);
      const width = Math.max(
        1,
        Math.round((source.width * Math.min(rect.width, 100 - rect.x)) / 100),
      );
      const height = Math.max(
        1,
        Math.round((source.height * Math.min(rect.height, 100 - rect.y)) / 100),
      );
      canvas.width = tool === 'crop' ? width : source.width;
      canvas.height = tool === 'crop' ? height : source.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('사진을 처리할 수 없어요.');
      if (tool === 'crop') ctx.drawImage(source, x, y, width, height, 0, 0, width, height);
      else {
        ctx.drawImage(source, 0, 0);
        ctx.fillStyle = '#222';
        ctx.fillRect(x, y, width, height);
      }
      const result = encodePhoto(canvas);
      if (current !== generation.current) return;
      setImage(result);
      setChecked(false);
      notify(result, caption, false);
    } catch (e) {
      if (current === generation.current) setError(message(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  return (
    <div className={styles.group}>
      <label className={styles.field}>
        사진 선택
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>
      <p className={styles.note}>
        10MB 이하 · 사진에서 이름·얼굴·학번을 직접 확인하고 필요한 곳을 가려 주세요.
      </p>
      {image && (
        <>
          <div className={styles.inline}>
            <button
              type="button"
              className={styles.outline}
              aria-pressed={tool === 'redact'}
              onClick={() => setTool('redact')}
            >
              영역 가리기
            </button>
            <button
              type="button"
              className={styles.outline}
              aria-pressed={tool === 'crop'}
              onClick={() => setTool('crop')}
            >
              잘라내기
            </button>
          </div>
          <p className={styles.note}>
            사진 위에서 영역을 드래그하거나 아래 위치·크기를 조절한 뒤 적용해 주세요.
          </p>
          <div
            className={styles.photoEditor}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              start.current = point(event);
              setRect({ ...start.current, width: 0, height: 0 });
            }}
            onPointerMove={(event) => {
              if (!start.current) return;
              const p = point(event),
                origin = start.current;
              setRect({
                x: Math.min(origin.x, p.x),
                y: Math.min(origin.y, p.y),
                width: Math.abs(p.x - origin.x),
                height: Math.abs(p.y - origin.y),
              });
            }}
            onPointerUp={() => {
              start.current = null;
            }}
            onPointerCancel={() => {
              start.current = null;
            }}
          >
            <img src={image} alt="게시할 사진 미리보기" draggable={false} />
            <span
              className={styles.selection}
              style={{
                left: `${rect.x}%`,
                top: `${rect.y}%`,
                width: `${rect.width}%`,
                height: `${rect.height}%`,
              }}
            />
          </div>
          <div className={styles.rectFields}>
            {(['x', 'y', 'width', 'height'] as const).map((key, i) => (
              <label className={styles.field} key={key}>
                {['왼쪽 %', '위쪽 %', '너비 %', '높이 %'][i]}
                <input
                  type="number"
                  min={key === 'x' || key === 'y' ? 0 : 1}
                  max={100}
                  value={Math.round(rect[key])}
                  onChange={(e) =>
                    setRect({
                      ...rect,
                      [key]: Math.max(
                        key === 'x' || key === 'y' ? 0 : 1,
                        Math.min(100, Number(e.target.value)),
                      ),
                    })
                  }
                />
              </label>
            ))}
          </div>
          <div className={styles.inline}>
            <button
              type="button"
              className={styles.outline}
              disabled={busy || rect.width < 1 || rect.height < 1 || rect.x >= 100 || rect.y >= 100}
              onClick={() => void apply()}
            >
              {tool === 'redact' ? '선택 영역 가리기' : '선택 영역으로 자르기'}
            </button>
            <button
              type="button"
              className={styles.outline}
              disabled={busy}
              onClick={() => {
                setImage(original);
                setChecked(false);
                notify(original, caption, false);
              }}
            >
              편집 초기화
            </button>
          </div>
          <label className={styles.field}>
            사진 설명
            <input
              value={caption}
              maxLength={200}
              onChange={(e) => {
                setCaption(e.target.value);
                notify(image, e.target.value, checked);
              }}
              placeholder="어떤 사진인지 알려 주세요"
            />
          </label>
          <Checkbox
            checked={checked}
            disabled={busy}
            onChange={(value) => {
              setChecked(value);
              notify(image, caption, value);
            }}
          >
            게시될 사진을 확인했어요
          </Checkbox>
        </>
      )}
      {busy && (
        <p role="status" className={styles.note}>
          사진을 처리하고 있어요.
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}

export function recordedSolveSelection(response: { selected?: number }, requested: number | null) {
  const recorded = Number.isInteger(response.selected) && response.selected! >= 0 ? response.selected! : requested;
  return { selected: recorded, previous: recorded !== requested };
}

export function BlockView({
  block,
  postId,
  data,
  navigate,
  toast,
  onChanged,
  preview = false,
  onFeedback,
}: {
  block: CommunityBlock;
  postId?: string;
  data: AppData;
  navigate: Navigate;
  toast: (message: string) => void;
  onChanged?: () => void;
  preview?: boolean;
  onFeedback?: () => void;
}) {
  const p = block.payload;
  const [revealed, setRevealed] = useState(!block.hidden);
  const [trying, setTrying] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [result, setResult] = useState<{
    correct: boolean;
    answer: number;
    explanation: string;
  } | null>(null);
  const [stats, setStats] = useState(block.stats);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [cloned, setCloned] = useState<{ id: string; subjectId: string } | null>(null);
  const [questionSaved, setQuestionSaved] = useState(false);
  const [previousSolve, setPreviousSolve] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState(today);
  const [scheduleResult, setScheduleResult] = useState<{ created: number; skipped: number } | null>(
    null,
  );
  const [photoOpen, setPhotoOpen] = useState(false);
  const canAct = !preview && !!postId && data.profile.role !== 'PARENT';
  const endpoint = `/posts/${encodeURIComponent(postId ?? '')}/blocks/${encodeURIComponent(block.id)}`;
  useEffect(() => {
    setStats(block.stats);
  }, [block.stats]);
  useEffect(() => {
    setRevealed(!block.hidden);
    setResult(null);
    setTrying(false);
    setSelected(null);
  }, [block.id, block.hidden]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const options = Array.isArray(p.options)
    ? p.options.filter((v): v is string => typeof v === 'string')
    : [];
  const answer = result?.answer ?? Number(p.answer);
  const explanation = result?.explanation ?? text(p.explanation);
  const material =
    !block.sourceDeleted && block.refId
      ? data.materials.find((m) => m.id === block.refId)
      : undefined;
  const rows = Array.isArray(p.rows) ? (p.rows as ReturnType<typeof safeScheduleRows>) : [];
  const flexible = rows.filter((row) => row.kind === 'FLEXIBLE');
  const voted = stats?.voted != null && stats.voted >= 0;
  const closed = typeof p.closesAt === 'string' && Date.parse(p.closesAt) <= Date.now();
  const votes = stats?.votes ?? [];
  const voteTotal = votes.reduce((a, b) => a + b, 0);
  const showVotes = voted || closed;
  const image = text(p.image);
  const photoAllowed = /^data:image\/(jpeg|png|webp);base64,/.test(image);
  return (
    <section className={styles.block} aria-label={`${BLOCK_LABELS[block.type]} 첨부`}>
      <div className={styles.meta}>
        <span>
          {BLOCK_LABELS[block.type]}
          {p.subjectName ? ` · ${p.subjectName}` : ''}
        </span>
        {block.hidden && !revealed && <span>정답 가림</span>}
      </div>
      {block.type === 'QUESTION' && (
        <>
          <h3 className={styles.title}>{text(p.prompt)}</h3>
          {(trying || revealed) && (
            <div role="group" aria-label="문제 선택지" className={styles.group}>
              {options.map((option, i) => (
                <button
                  className={styles.option}
                  type="button"
                  key={i}
                  disabled={!trying || !!result || busy || revealed}
                  aria-pressed={selected === i}
                  onClick={() => setSelected(i)}
                >
                  <span className={styles.number}>{i + 1}</span>
                  <span>
                    {option}
                    {revealed && answer === i && (
                      <strong className={styles.answerLabel}>정답</strong>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
          {trying && !revealed && (
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={selected === null || busy || !canAct}
              onClick={() =>
                void run(async () => {
                  const response = await api<{
                    selected: number;
                    correct: boolean;
                    answer: number;
                    explanation: string;
                    stats: CommunityBlock['stats'];
                  }>(`${endpoint}/solve`, { selected });
                  const recorded = recordedSolveSelection(response, selected);
                  setSelected(recorded.selected);
                  setPreviousSolve(recorded.previous);
                  setResult(response);
                  setStats(response.stats);
                  setRevealed(true);
                  onChanged?.();
                })
              }
            >
              {busy ? '확인 중…' : '정답 확인'}
            </Button>
          )}
          {previousSolve && result && <p className={styles.note}>이미 참여한 문제예요. 처음 선택한 답과 결과를 보여 드려요.</p>}
          {result && (
            <p role="status" className={styles.result}>
              {result.correct ? '맞았어요' : '이 부분을 다시 확인해 봐요'} · 정답{' '}
              {result.answer + 1}번
            </p>
          )}
          {revealed && (
            <div className={styles.answer}>
              <strong>정답 · {options[answer] ?? `${answer + 1}번`}</strong>
              {explanation && <p>{explanation}</p>}
              {text(p.citation) && (
                <details>
                  <summary>첨부에 포함된 자료 근거</summary>
                  <p>{p.citation}</p>
                </details>
              )}
            </div>
          )}
          <div className={styles.actions}>
            {!revealed && (
              <>
                {!trying && canAct && (
                  <button
                    type="button"
                    className={styles.outline}
                    onClick={() => {
                      setTrying(true);
                      setSelected(null);
                    }}
                  >
                    나도 풀어보기
                  </button>
                )}
                <button
                  type="button"
                  className={styles.outline}
                  onClick={() => {
                    setRevealed(true);
                    setTrying(false);
                  }}
                >
                  정답 보기
                </button>
              </>
            )}
            {revealed && (
              <button
                type="button"
                className={styles.outline}
                onClick={() => {
                  setRevealed(false);
                  setTrying(false);
                  setResult(null);
                  setSelected(null);
                }}
              >
                정답 접기
              </button>
            )}
            {result && !result.correct && canAct && (
              <button
                type="button"
                className={styles.outline}
                disabled={busy || questionSaved}
                onClick={() =>
                  void run(async () => {
                    await api(`${endpoint}/save-question`, {});
                    setQuestionSaved(true);
                    toast('내 오답노트에 담았어요. 해설은 원 글의 근거와 답변을 확인해 주세요.');
                    onChanged?.();
                  })
                }
              >
                {questionSaved ? '오답노트에 담았어요' : '내 오답노트에 담기'}
              </button>
            )}
          </div>
          <p className={styles.note}>
            {Number.isInteger(p.selected) && `작성자 답 ${p.selected + 1}번 · `}
            {stats?.attempts
              ? `${stats.attempts}명 참여 · 정답률 ${Math.round((stats.correct / stats.attempts) * 100)}%`
              : '아직 풀이 참여가 없어요'}
          </p>
          {trying && (
            <p className={styles.note}>
              이 풀이는 커뮤니티 정답률에만 반영돼요. 개인 학습 기록에는 남지 않아요.
            </p>
          )}
        </>
      )}
      {block.type === 'CARD' && (
        <>
          <h3 className={styles.title}>{text(p.front)}</h3>
          {p.diagram && (
            <DiagramCardContent
              card={
                {
                  ...p,
                  id: block.id,
                  subjectId: '',
                  bucket: 'AGAIN',
                  consecutiveEasy: 0,
                  nextReviewAt: '',
                  deleted: false,
                } as Card
              }
              revealed={revealed}
            />
          )}
          {image && (photoAllowed || image.startsWith('/api/uploads/')) && (
            <div className={styles.cardImage}>
              <img src={image} alt={text(p.front) || '복습 카드'} />
              {!revealed &&
                Array.isArray(p.masks) &&
                p.masks.map((mask: Mask, i: number) => (
                  <span
                    key={i}
                    className={styles.mask}
                    style={{
                      left: `${mask.x}%`,
                      top: `${mask.y}%`,
                      width: `${mask.width}%`,
                      height: `${mask.height}%`,
                    }}
                  >
                    ?
                  </span>
                ))}
            </div>
          )}
          {revealed && <p className={styles.answer}>{text(p.back)}</p>}
          <div className={styles.actions}>
            <button type="button" className={styles.outline} onClick={() => setRevealed(!revealed)}>
              {revealed ? '뒷면 접기' : '뒷면 보기'}
            </button>
            {canAct && (
              <button
                type="button"
                className={styles.outline}
                disabled={busy || !!cloned}
                onClick={() =>
                  void run(async () => {
                    const copy = await api<{ id: string; subjectId: string }>(
                      `${endpoint}/clone`,
                      {},
                    );
                    setCloned(copy);
                    toast('내 카드 보관함의 다시 상자에 담았어요.');
                    onChanged?.();
                  })
                }
              >
                {cloned ? '내 카드에 담았어요' : busy ? '담는 중…' : '내 카드에 담기'}
              </button>
            )}
            {cloned && (
              <button
                type="button"
                className={styles.outline}
                onClick={() =>
                  navigate(`/flashcards?subject=${encodeURIComponent(cloned.subjectId)}`)
                }
              >
                카드 보관함 열기
              </button>
            )}
          </div>
        </>
      )}
      {block.type === 'MATERIAL' && (
        <>
          <h3 className={styles.title}>
            {text(p.title)}
            {p.page ? ` · ${p.page}쪽` : ''}
          </h3>
          <blockquote className={styles.quote}>{text(p.text)}</blockquote>
          {material && !preview ? (
            <button
              type="button"
              className={styles.outline}
              onClick={() =>
                navigate(
                  `/subjects/${encodeURIComponent(material.subjectId)}?material=${encodeURIComponent(material.id)}`,
                )
              }
            >
              내 원본 자료 보기
            </button>
          ) : (
            <p className={styles.note}>
              글에 첨부한 발췌문만 공개돼요. 원본은 자료 주인만 볼 수 있어요.
            </p>
          )}
        </>
      )}
      {block.type === 'PHOTO' && (
        <>
          {photoAllowed ? (
            <button
              type="button"
              className={styles.photoButton}
              onClick={() => setPhotoOpen(true)}
              aria-label="첨부 사진 크게 보기"
            >
              <img src={image} alt={text(p.caption) || '첨부한 사진'} />
              <span>사진 크게 보기</span>
            </button>
          ) : (
            <p className={styles.note}>사진을 표시할 수 없어요.</p>
          )}
          {text(p.caption) && <p>{p.caption}</p>}
          <Sheet open={photoOpen} onClose={() => setPhotoOpen(false)} title="첨부 사진" fullScreen>
            {photoAllowed && (
              <img
                className={styles.fullPhoto}
                src={image}
                alt={text(p.caption) || '첨부한 사진'}
              />
            )}
            {text(p.caption) && <p>{p.caption}</p>}
          </Sheet>
        </>
      )}
      {block.type === 'ESSAY' && (
        <>
          <h3 className={styles.title}>{text(p.prompt)}</h3>
          <p className={styles.answer}>{text(p.answer)}</p>
          {typeof p.score === 'number' && (
            <p className={styles.note}>작성자가 제출한 답안 · {p.score}점</p>
          )}
          {!preview && onFeedback && (
            <button type="button" className={styles.outline} onClick={onFeedback}>
              이 답안에 피드백 남기기
            </button>
          )}
        </>
      )}
      {block.type === 'POLL' && (
        <>
          <h3 className={styles.title}>{text(p.question)}</h3>
          <div className={styles.group} role="group" aria-label="투표 선택지">
            {options.map((option, i) =>
              showVotes ? (
                <div className={styles.voteRow} key={i}>
                  <div className={styles.inline}>
                    <span>
                      {option}
                      {stats?.voted === i && ' · 내 선택'}
                    </span>
                    <strong>{votes[i] ?? 0}표</strong>
                  </div>
                  <div className={styles.voteTrack}>
                    <span
                      style={{ width: `${voteTotal ? ((votes[i] ?? 0) / voteTotal) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  key={i}
                  className={styles.option}
                  aria-pressed={selected === i}
                  disabled={busy || preview}
                  onClick={() => setSelected(i)}
                >
                  <span className={styles.number}>{i + 1}</span>
                  {option}
                </button>
              ),
            )}
          </div>
          {!showVotes && !preview && (
            <button
              type="button"
              className={styles.outline}
              disabled={busy || selected === null || !postId}
              onClick={() =>
                void run(async () => {
                  const response = await api<{ stats: CommunityBlock['stats'] }>(
                    `${endpoint}/vote`,
                    { selected },
                  );
                  setStats(response.stats);
                  onChanged?.();
                })
              }
            >
              {busy ? '투표 중…' : '투표하기'}
            </button>
          )}
          <p className={styles.note}>
            {closed ? '투표 마감' : '게시 후 24시간 · 1인 1표'}
            {showVotes ? ` · ${voteTotal}명 참여` : ' · 투표 후 결과 공개'}
          </p>
        </>
      )}
      {block.type === 'SCHEDULE' && (
        <>
          <ul className={styles.schedule}>
            {rows.map((row, i) => (
              <li key={i}>
                <span>
                  {row.start}–{row.end}
                </span>
                <strong>{row.kind === 'FIXED' ? '학교' : row.title}</strong>
                {row.kind === 'FIXED' && <small>고정</small>}
              </li>
            ))}
          </ul>
          <p className={styles.note}>
            자율 일정 {flexible.length}개만 담을 수 있어요. 겹치는 시간은 제외하며 기존 일정은
            그대로 유지해요.
          </p>
          {canAct && (
            <button
              type="button"
              className={styles.outline}
              disabled={!flexible.length}
              onClick={() => {
                setScheduleOpen(true);
                setError('');
              }}
            >
              내 시간표에 담기
            </button>
          )}
          <Sheet
            open={scheduleOpen}
            onClose={() => setScheduleOpen(false)}
            title="어느 날에 담을까요?"
            description="선택한 날짜에 같은 시간으로 담아요. 겹치는 일정은 건너뛰어요."
          >
            <div className={styles.group}>
              <label className={styles.field}>
                담을 날짜
                <input
                  type="date"
                  min={today()}
                  value={scheduleDate}
                  onChange={(e) => {
                    setScheduleDate(e.target.value);
                    setScheduleResult(null);
                  }}
                />
              </label>
              <ul className={styles.schedule}>
                {flexible.map((row, i) => (
                  <li key={i}>
                    <span>
                      {row.start}–{row.end}
                    </span>
                    <strong>{row.title}</strong>
                  </li>
                ))}
              </ul>
              {scheduleResult && (
                <p role="status" className={styles.result}>
                  {scheduleResult.created}개 담았어요
                  {scheduleResult.skipped > 0
                    ? ` · 고정·중복·겹치는 일정 ${scheduleResult.skipped}개는 제외했어요`
                    : ''}
                  .
                </p>
              )}
              {error && (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !scheduleDate || scheduleDate < today() || !!scheduleResult}
                onClick={() =>
                  void run(async () => {
                    const response = await api<{ created: number; skipped: number }>(
                      `${endpoint}/schedule`,
                      { date: scheduleDate },
                    );
                    setScheduleResult(response);
                    toast(`${response.created}개 일정을 담았어요.`);
                    onChanged?.();
                  })
                }
              >
                {busy ? '일정 확인 중…' : scheduleResult ? '담기 완료' : '이 날짜에 담기'}
              </Button>
              {scheduleResult && (
                <button
                  className={styles.outline}
                  type="button"
                  onClick={() => navigate(`/planner?date=${scheduleDate}`)}
                >
                  시간표 확인하기
                </button>
              )}
            </div>
          </Sheet>
        </>
      )}
      {block.type === 'MATH' && (
        <>
          <pre className={styles.math}>{text(p.text)}</pre>
          {!preview && (
            <button
              type="button"
              className={styles.outline}
              onClick={() =>
                void run(async () => {
                  await navigator.clipboard.writeText(text(p.text));
                  toast('수식을 복사했어요.');
                })
              }
            >
              수식 복사
            </button>
          )}
        </>
      )}
      {block.sourceDeleted && (
        <p className={styles.note}>작성자가 원본을 지웠어요. 글에 남긴 부분만 보여요.</p>
      )}
      {error && !scheduleOpen && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  );
}

export function BlockDraftList({
  blocks,
  onChange,
  data,
}: {
  blocks: CommunityBlock[];
  onChange: (blocks: CommunityBlock[]) => void;
  data: AppData;
}) {
  const move = (index: number, direction: number) => {
    const next = [...blocks],
      target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return (
    <div className={styles.draftList}>
      {blocks.map((block, index) => (
        <div className={styles.draft} key={block.id}>
          <div className={styles.draftHeading}>
            <strong>
              첨부 {index + 1} · {BLOCK_LABELS[block.type]}
            </strong>
            <div className={styles.inline}>
              {blocks.length > 1 && (
                <>
                  <IconButton
                    label={`첨부 ${index + 1} 위로 이동`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={18} />
                  </IconButton>
                  <IconButton
                    label={`첨부 ${index + 1} 아래로 이동`}
                    disabled={index === blocks.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={18} />
                  </IconButton>
                </>
              )}
              <IconButton
                label={`첨부 ${index + 1} 삭제`}
                onClick={() => onChange(blocks.filter((_, i) => i !== index))}
              >
                <Trash2 size={18} />
              </IconButton>
            </div>
          </div>
          <BlockView block={block} data={data} navigate={() => {}} toast={() => {}} preview />
          {['QUESTION', 'CARD'].includes(block.type) && (
            <Checkbox
              checked={block.hidden}
              onChange={(hidden) =>
                onChange(blocks.map((b, i) => (i === index ? { ...b, hidden } : b)))
              }
            >
              정답을 가려서 올리기
            </Checkbox>
          )}
        </div>
      ))}
    </div>
  );
}
