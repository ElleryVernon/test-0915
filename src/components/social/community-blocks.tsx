'use client';

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  ChevronDown,
  Trash2,
  BookOpen,
  Layers,
  FileText,
  ImageIcon,
  PencilLine,
  ListChecks,
  CalendarDays,
  Sigma,
} from '@/components/icons';
import { Button, IconButton, Sheet } from '@/components/ui';
import { Checkbox } from '@/components/ui-choice';
import { useJourneyLayer } from '@/components/journey';
import { AttachmentSheet } from './attachment-sheet';
import {
  initialAttachmentRoute,
  permittedAttachmentTypes,
  attachmentCapacity,
  updateExcerptRange,
  pollInputError,
  createAttachmentRequestGuard,
  insertMathSymbol,
} from '@/lib/attachment-workflow';
import { api } from '@/lib/api';
import { fetchMaterialDetail } from '@/lib/materials';
import type { AppData, Card, Mask, Navigate, Schedule, ToastAction } from '@/lib/contracts';
import type { CommunityBlock, CommunityBlockType } from '@/lib/community-types';
import {
  markFollowed,
  markFollowSuggested,
  maySuggestFollow,
  recordClone,
  solveResultCopy,
} from '@/lib/community-nudges';
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
const BLOCK_ICONS = {
  QUESTION: BookOpen,
  CARD: Layers,
  MATERIAL: FileText,
  PHOTO: ImageIcon,
  ESSAY: PencilLine,
  POLL: ListChecks,
  SCHEDULE: CalendarDays,
  MATH: Sigma,
};
function BlockIcon({ type }: { type: CommunityBlockType }) {
  const Icon = BLOCK_ICONS[type];
  return <Icon size={16} />;
}
export function blockPreviewText(block: CommunityBlock): string {
  const p = block.payload;
  if (block.type === 'SCHEDULE') return `${Array.isArray(p.rows) ? p.rows.length : 0}개의 일정`;
  const value =
    block.type === 'QUESTION' || block.type === 'ESSAY'
      ? p.prompt
      : block.type === 'CARD'
        ? p.front
        : block.type === 'POLL'
          ? p.question
          : block.type === 'PHOTO'
            ? p.caption
            : block.type === 'MATERIAL'
              ? p.title
              : p.text;
  return typeof value === 'string' ? value : '';
}
export function allowedBlockTypes(role: string, comment = false): CommunityBlockType[] {
  return permittedAttachmentTypes(role, comment);
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

type BlockPickerProps = {
  data: AppData;
  open: boolean;
  onClose: () => void;
  onAdd: (block: CommunityBlock) => void;
  remaining: number;
  comment?: boolean;
  photoCount?: number;
  allowedTypes?: CommunityBlockType[];
  initialType?: CommunityBlockType;
  maxAttachments?: number;
};

const TOOL_HELP: Record<CommunityBlockType, string> = {
  QUESTION: '내 문제를 골라 함께 풀어봐요',
  CARD: '복습 카드의 앞면과 뒷면을 공유해요',
  MATERIAL: '내 자료에서 필요한 문장만 발췌해요',
  PHOTO: '사진을 고르고 필요한 부분을 편집해요',
  ESSAY: '직접 작성한 답안에 피드백을 받아요',
  POLL: '선택지 2~4개로 의견을 물어봐요',
  SCHEDULE: '하루 일정 중 공유할 시간만 골라요',
  MATH: '수식과 수학 기호를 입력해요',
};

export function BlockPicker(props: BlockPickerProps) {
  // A dismissed picker owns no parent draft; reopening starts a new attachment.
  return props.open ? <AttachmentPickerSession {...props} /> : null;
}
function AttachmentPickerSession({
  data,
  onClose,
  onAdd,
  remaining,
  comment = false,
  photoCount = 0,
  allowedTypes,
  initialType,
  maxAttachments = comment ? 1 : 5,
}: BlockPickerProps) {
  const types = permittedAttachmentTypes(data.profile.role, comment, allowedTypes);
  const initial = initialAttachmentRoute(types, initialType);
  const [route, setRoute] = useState(initial);
  const [visited, setVisited] = useState<CommunityBlockType[]>(initial.type ? [initial.type] : []);
  const close = useJourneyLayer(true, onClose);
  const backToMenu = useJourneyLayer(!!route.type && route.type !== initial.type, () =>
    setRoute({ type: null, preview: false }),
  );
  const backToList = useJourneyLayer(route.preview, () =>
    setRoute((previous) => ({ ...previous, preview: false })),
  );
  const chooseType = (type: CommunityBlockType) => {
    if (!types.includes(type)) return;
    setVisited((previous) => (previous.includes(type) ? previous : [...previous, type]));
    setRoute({ type, preview: false });
  };
  const type = route.type;
  const title = !type
    ? '첨부하기'
    : route.preview
      ? type === 'MATERIAL'
        ? '공유할 문장 선택'
        : `${BLOCK_LABELS[type]} 확인`
      : `${BLOCK_LABELS[type]} 첨부`;
  return (
    <AttachmentSheet
      open
      flush
      history={false}
      onClose={close}
      title={title}
      closeLabel="첨부 닫기"
      description={!type && remaining > 0 ? `최대 ${remaining}개 더 첨부할 수 있어요` : undefined}
      onBack={route.preview ? backToList : type && type !== initial.type ? backToMenu : undefined}
    >
      {!type && (
        <div className={styles.toolMenu}>
          {remaining <= 0 ? (
            <p className={styles.empty}>
              첨부는 {maxAttachments}개까지예요. 기존 첨부를 하나 빼면 더 넣을 수 있어요.
            </p>
          ) : (
            types.map((kind) => (
              <button
                type="button"
                key={kind}
                className={styles.toolMenuRow}
                disabled={!attachmentCapacity(kind, remaining, photoCount)}
                onClick={() => chooseType(kind)}
              >
                <span className={styles.toolMenuIcon}>
                  <BlockIcon type={kind} />
                </span>
                <span>
                  <strong>{BLOCK_LABELS[kind]}</strong>
                  <small>
                    {kind === 'PHOTO' && photoCount >= 4
                      ? '사진 4장을 모두 첨부했어요'
                      : TOOL_HELP[kind]}
                  </small>
                </span>
                <ChevronRight size={18} />
              </button>
            ))
          )}
          {!types.length && <p className={styles.empty}>이곳에 첨부할 수 있는 항목이 없어요.</p>}
        </div>
      )}
      {visited.map((kind) => (
        <AttachmentTool
          key={kind}
          type={kind}
          data={data}
          active={type === kind}
          preview={type === kind && route.preview}
          onPreview={() => setRoute({ type: kind, preview: true })}
          onChooseType={chooseType}
          canChoosePhoto={
            types.includes('PHOTO') && attachmentCapacity('PHOTO', remaining, photoCount)
          }
          onAdd={onAdd}
          onClose={close}
          remaining={remaining}
          photoCount={photoCount}
          maxAttachments={maxAttachments}
        />
      ))}
    </AttachmentSheet>
  );
}

function AttachmentTool({
  type,
  data,
  active,
  preview,
  onPreview,
  onChooseType,
  canChoosePhoto,
  onAdd,
  onClose,
  remaining,
  photoCount,
  maxAttachments,
}: {
  type: CommunityBlockType;
  data: AppData;
  active: boolean;
  preview: boolean;
  onPreview: () => void;
  onChooseType: (type: CommunityBlockType) => void;
  canChoosePhoto: boolean;
  onAdd: (block: CommunityBlock) => void;
  onClose: () => void;
  remaining: number;
  photoCount: number;
  maxAttachments: number;
}) {
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
  const loadGuard = useRef(createAttachmentRequestGuard());
  const mathField = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  useLayoutEffect(() => {
    if (active && bodyRef.current) bodyRef.current.scrollTop = preview ? 0 : listScroll.current;
  }, [active, preview]);
  useEffect(() => {
    if (!active || !preview) {
      loadGuard.current.cancel();
      setLoading(false);
    }
  }, [active, preview]);
  useEffect(
    () => () => {
      loadGuard.current.cancel();
    },
    [],
  );
  const chooseType = onChooseType;
  const subject = (id: string) => data.subjects.find((s) => s.id === id)?.name ?? '';
  const match = (value: string) =>
    value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const chooseMaterial = async (id: string) => {
    const source = data.materials.find((m) => m.id === id);
    if (!source) return;
    if (candidate?.refId === id) {
      onPreview();
      return;
    }
    const current = loadGuard.current.start();
    onPreview();
    setLoading(true);
    setError('');
    setCandidate(null);
    try {
      const detail = await fetchMaterialDetail(source);
      if (!loadGuard.current.isCurrent(current)) return;
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
      if (!parts.length) setError('이 자료에는 발췌할 본문이 없어요. 다른 자료를 선택해 주세요.');
    } catch (e) {
      if (loadGuard.current.isCurrent(current)) setError(message(e));
    } finally {
      if (loadGuard.current.isCurrent(current)) setLoading(false);
    }
  };
  const scheduleRows = (data.schedules ?? [])
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
  // New poll, math and schedule IDs are generated only when confirming the attachment.
  const valid =
    type === 'MATH'
      ? !!math.trim()
      : type === 'POLL'
        ? !pollInputError(pollQuestion, pollOptions)
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
              onPreview();
              if (candidate?.refId === q.id) return;
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
              select: () => {
                onPreview();
                if (candidate?.refId === c.id) return;
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
                );
              },
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
                    select: () => {
                      onPreview();
                      if (candidate?.refId === e.id) return;
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
                      );
                    },
                  },
                ];
              })
            : [];
  const learning = ['QUESTION', 'CARD', 'MATERIAL', 'ESSAY'].includes(type);
  const capacity = attachmentCapacity(type, remaining, photoCount);
  return (
    <div className={styles.tool} hidden={!active}>
      <div
        className={styles.toolBody}
        ref={bodyRef}
        onScroll={(event) => {
          if (!preview) listScroll.current = event.currentTarget.scrollTop;
        }}
      >
        {remaining <= 0 && (
          <p role="status" className={styles.empty}>
            첨부는 {maxAttachments}개까지예요. 기존 첨부를 하나 빼면 더 넣을 수 있어요.
          </p>
        )}
        {learning && !preview && (
          <>
            <label className={styles.searchField}>
              <span className="sr-only">내 {BLOCK_LABELS[type]} 찾기</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="제목이나 과목으로 검색"
              />
            </label>
            <p className={styles.note}>
              {type === 'ESSAY' ? '직접 제출한 답안만 표시돼요.' : '내 학습에 저장된 항목이에요.'}
            </p>
            <div className={styles.pickList}>
              {rows.map((row) => (
                <button type="button" key={row.id} className={styles.pickRow} onClick={row.select}>
                  <span>
                    <strong>{row.title}</strong>
                    <small>{row.meta}</small>
                  </span>
                  {candidate?.refId === row.id ? <Check size={18} /> : <ChevronRight size={18} />}
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
                {query ? (
                  <button type="button" className={styles.outline} onClick={() => setQuery('')}>
                    검색 지우기
                  </button>
                ) : (
                  canChoosePhoto && (
                    <button
                      type="button"
                      className={styles.outline}
                      onClick={() => chooseType('PHOTO')}
                    >
                      사진으로 대신 첨부
                    </button>
                  )
                )}
              </div>
            )}
          </>
        )}
        {loading && (
          <p role="status" className={styles.loading}>
            자료 본문을 불러오고 있어요.
          </p>
        )}
        {type === 'MATERIAL' && candidate && preview && (
          <div className={styles.group}>
            <div className={styles.selectedSource}>
              <FileText size={18} />
              <strong>{text(candidate.payload.title)}</strong>
            </div>
            <p className={styles.note}>
              공유할 첫 문장과 바로 이어지는 문장을 골라 주세요. 최대 3문장·2,000자까지 첨부되며,
              자료 전체는 공개되지 않아요.
            </p>
            <div className={styles.selectionHeading}>
              <strong aria-live="polite">{selectedSentences.length} / 3문장 선택</strong>
              <button
                type="button"
                disabled={!selectedSentences.length}
                onClick={() => {
                  setSelectedSentences([]);
                  setError('');
                }}
              >
                선택 초기화
              </button>
            </div>
            <div className={styles.sentences}>
              {sentences.map((sentence, index) => (
                <Checkbox
                  key={index}
                  checked={selectedSentences.includes(index)}
                  onChange={(checked) => {
                    const next = updateExcerptRange(selectedSentences, index, checked);
                    setSelectedSentences(next.indices);
                    setError(next.error);
                  }}
                >
                  {sentence}
                </Checkbox>
              ))}
            </div>
            {!!selectedSentences.length && (
              <div className={styles.excerptPreview}>
                <strong>첨부될 내용</strong>
                {excerptSelection(sourceText, selectedSentences) ? (
                  <p>{excerptSelection(sourceText, selectedSentences)}</p>
                ) : (
                  <p className={styles.note}>2,000자를 넘었어요. 선택한 문장을 줄여 주세요.</p>
                )}
              </div>
            )}
          </div>
        )}
        {type === 'PHOTO' &&
          (photoCount >= 4 ? (
            <p className={styles.note}>사진은 최대 4장까지 첨부할 수 있어요.</p>
          ) : (
            <PhotoEditor
              active={active}
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
                ref={mathField}
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
                  onClick={() => {
                    const input = mathField.current;
                    const inserted = insertMathSymbol(
                      math,
                      input?.selectionStart ?? math.length,
                      input?.selectionEnd ?? math.length,
                      token,
                    );
                    setMath(inserted.value);
                    requestAnimationFrame(() => {
                      input?.focus({ preventScroll: true });
                      input?.setSelectionRange(inserted.caret, inserted.caret);
                    });
                  }}
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
            {pollQuestion.trim() &&
              pollOptions.every((option) => option.trim()) &&
              pollInputError(pollQuestion, pollOptions) && (
                <p className={styles.error} role="status">
                  {pollInputError(pollQuestion, pollOptions)}
                </p>
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
            <div className={styles.scheduleChoices}>
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
            </div>
            <p className={styles.note} aria-live="polite">
              {rowIds.length} / 6개 선택
            </p>
            {!scheduleRows.length && (
              <p className={styles.empty}>이 날짜에는 일정이 없어요. 다른 날짜를 선택해 주세요.</p>
            )}
          </div>
        )}

        {candidate && preview && ['QUESTION', 'CARD', 'ESSAY'].includes(type) && (
          <div className={styles.group}>
            <p className={styles.note}>
              아래 내용이 첨부돼요. 다른 항목은 이전 단계에서 고를 수 있어요.
            </p>
            <BlockView
              key={`${candidate.id}-${candidate.hidden}`}
              block={candidate}
              data={data}
              navigate={() => {}}
              toast={() => {}}
              preview
            />
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
      </div>
      {(!learning || preview) && (
        <div className={styles.toolFooter}>
          {type === 'PHOTO' && !valid && capacity && (
            <p className={styles.note}>사진을 고르고 게시될 내용을 확인해 주세요.</p>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={!valid || loading || !capacity}
            onClick={() => {
              if (!capacity || !valid || loading) return;
              const block = build();
              if (block) {
                onAdd(block);
                onClose();
              }
            }}
          >
            {BLOCK_LABELS[type]} 첨부하기
          </Button>
        </div>
      )}
    </div>
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
function PhotoEditor({
  active,
  onReady,
}: {
  active: boolean;
  onReady: (image: string, caption: string) => void;
}) {
  const [image, setImage] = useState('');
  const [original, setOriginal] = useState('');
  const [caption, setCaption] = useState('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rect, setRect] = useState<Rect>({ x: 10, y: 10, width: 30, height: 20 });
  const [tool, setTool] = useState<'redact' | 'crop' | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    if (!active) {
      generation.current++;
      setBusy(false);
    }
  }, [active]);
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
      setTool(null);
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
    if (!image || !tool || busy || rect.width < 1 || rect.height < 1) return;
    setBusy(true);
    setChecked(false);
    notify(image, caption, false);
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
      setTool(null);
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
      <label className={`${styles.photoPicker} ${image ? styles.photoPickerCompact : ''}`}>
        <ImageIcon size={24} />
        <span>
          <strong>{image ? '다른 사진 선택' : '사진 선택'}</strong>
          <small>JPG · PNG · WebP, 최대 10MB</small>
        </span>
        <input
          className={styles.fileInput}
          aria-label="사진 선택"
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
              onClick={() => setTool(tool === 'redact' ? null : 'redact')}
            >
              영역 가리기
            </button>
            <button
              type="button"
              className={styles.outline}
              aria-pressed={tool === 'crop'}
              onClick={() => setTool(tool === 'crop' ? null : 'crop')}
            >
              잘라내기
            </button>
          </div>
          {tool && (
            <p className={styles.note}>
              사진에서 원하는 부분을 드래그한 뒤 {tool === 'crop' ? '자르기' : '가리기'}를 적용해
              주세요.
            </p>
          )}
          <div
            className={`${styles.photoEditor} ${tool ? styles.photoEditing : ''}`}
            onPointerDown={(event) => {
              if (!tool) return;
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
            {tool && (
              <span
                className={styles.selection}
                style={{
                  left: `${rect.x}%`,
                  top: `${rect.y}%`,
                  width: `${rect.width}%`,
                  height: `${rect.height}%`,
                }}
              />
            )}
          </div>
          {tool && (
            <>
              <details className={styles.rectSettings}>
                <summary>위치와 크기로 조절</summary>
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
              </details>
              <div className={styles.inline}>
                <button
                  type="button"
                  className={styles.outline}
                  disabled={
                    busy || rect.width < 1 || rect.height < 1 || rect.x >= 100 || rect.y >= 100
                  }
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
                    setTool(null);
                    setChecked(false);
                    notify(original, caption, false);
                  }}
                >
                  편집 초기화
                </button>
              </div>
            </>
          )}
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
  const recorded =
    Number.isInteger(response.selected) && response.selected! >= 0 ? response.selected! : requested;
  return { selected: recorded, previous: recorded !== requested };
}

export function BlockView({
  block,
  postId,
  messageId,
  data,
  navigate,
  toast,
  onChanged,
  preview = false,
  onFeedback,
  postAuthor,
}: {
  block: CommunityBlock;
  postId?: string;
  messageId?: string;
  data: AppData;
  navigate: Navigate;
  toast: (message: string, action?: ToastAction) => void;
  onChanged?: () => void;
  preview?: boolean;
  onFeedback?: () => void;
  /** Author of the post this block sits in — needed for the rare clone→follow nudge. */
  postAuthor?: { id: string; name: string };
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
  const canAct = !preview && !!(postId || messageId) && data.profile.role !== 'PARENT';
  const endpoint = messageId
    ? `/messages/${encodeURIComponent(messageId)}/blocks/${encodeURIComponent(block.id)}`
    : `/posts/${encodeURIComponent(postId ?? '')}/blocks/${encodeURIComponent(block.id)}`;
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
          <BlockIcon type={block.type} />
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
          {previousSolve && result && (
            <p className={styles.note}>
              이미 참여한 문제예요. 처음 선택한 답과 결과를 보여 드려요.
            </p>
          )}
          {result &&
            (() => {
              const copy = solveResultCopy({
                correct: result.correct,
                attempts: stats?.attempts,
                correctCount: stats?.correct,
                authorSelected: Number.isInteger(p.selected) ? (p.selected as number) : undefined,
              });
              return (
                <div role="status" className={styles.result}>
                  <p>
                    {copy.headline} · 정답 {result.answer + 1}번
                  </p>
                  {copy.detail && <small>{copy.detail}</small>}
                </div>
              );
            })()}
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
                    className={styles.primaryAction}
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
            {result && result.correct && canAct && onFeedback && (
              <button type="button" className={styles.outline} onClick={onFeedback}>
                답변으로 도와주기
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
                    toast('내 오답노트에 담았어요. 공유된 근거와 해설로 복습할 수 있어요.');
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
              {messageId
                ? '이 대화에서 함께 풀어보는 문제예요. 개인 학습 기록에는 남지 않아요.'
                : '이 풀이는 커뮤니티 정답률에만 반영돼요. 개인 학습 기록에는 남지 않아요.'}
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
                    onChanged?.();
                    // Second clone from the same author earns one follow suggestion, ever.
                    const author = postAuthor?.id;
                    if (author && author !== data.profile.id) {
                      const count = recordClone(author);
                      if (count >= 2 && maySuggestFollow(author)) {
                        markFollowSuggested(author);
                        toast(
                          `내 카드 보관함에 담았어요. ${postAuthor!.name}님의 카드가 자주 닿네요`,
                          {
                            label: '팔로우',
                            onClick: () =>
                              api('/follow', { userId: author, following: true })
                                .then(() => {
                                  markFollowed(author, true);
                                  toast(`${postAuthor!.name}님의 새 카드 알림을 받아요`);
                                })
                                .catch((e) => toast((e as Error).message)),
                          },
                        );
                        return;
                      }
                    }
                    toast('내 카드 보관함의 다시 상자에 담았어요.', {
                      label: '카드 열기',
                      onClick: () =>
                        navigate(`/flashcards?subject=${encodeURIComponent(copy.subjectId)}`),
                    });
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
              disabled={busy || selected === null || !(postId || messageId)}
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
              <BlockIcon type={block.type} />
              {BLOCK_LABELS[block.type]}
              {block.payload.subjectName ? ` · ${block.payload.subjectName}` : ''}
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
          {block.type === 'PHOTO' && typeof block.payload.image === 'string' && (
            <img
              className={styles.draftPhoto}
              src={block.payload.image}
              alt={block.payload.caption || '첨부 사진'}
            />
          )}
          <p className={styles.draftText}>{blockPreviewText(block)}</p>
          {block.type === 'QUESTION' && (
            <p className={styles.note}>
              {Array.isArray(block.payload.options)
                ? `${block.payload.options.length}지선다`
                : '문제'}
              {Number.isInteger(block.payload.selected)
                ? ` · 내 답 ${Number(block.payload.selected) + 1}번`
                : ''}
            </p>
          )}
          {block.type !== 'PHOTO' && (
            <details className={styles.draftPreview}>
              <summary>
                첨부 내용 확인
                <ChevronDown size={14} />
              </summary>
              <BlockView block={block} data={data} navigate={() => {}} toast={() => {}} preview />
            </details>
          )}
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
