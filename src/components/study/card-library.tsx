'use client';
import { StudyLibraryAction } from './subjects';
import { useState, type ReactNode } from 'react';
import type { Card, ScreenProps } from '@/lib/contracts';
import { Button, IconButton, Sheet } from '@/components/ui';
import { OptionField } from '@/components/ui-choice';
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  X,
} from '@/components/icons';
import { api } from '@/lib/api';
import { useJourneyState } from '../journey';
import { BUCKETS, TYPES } from './logic';
import { isDue } from '@/lib/srs';
import { nextReviewDay, reviewMinutes, whenLabel } from './insights';
import {
  cardTitle,
  libraryCards,
  permanentlyMastered,
  type CardScope,
  type CardSort,
} from './card-library-model';
import { ErrorNote, GenerationSheet, useAction } from './shared';
import { generationDefault } from '@/lib/study-library';
import { StudyHeader } from './study-header';
import { DiagramCardContent } from './explanation-card';
import { EditCard } from './card-editor';
import { LearningFolders } from './learning-folders';
import { inLearningFolder } from '@/lib/learning-folders';
import { UNFILED_MATERIALS } from '@/lib/material-folders';
import styles from './card-library.module.css';

export function CardLibrary({
  props,
  cards = props.data.cards,
  subjectId,
  initialSubject = '',
  initialTrash = false,
  initialGeneration = false,
  initialMaterial,
  banner,
  sync,
  onReview,
}: {
  props: ScreenProps;
  cards?: Card[];
  subjectId?: string;
  initialSubject?: string;
  initialTrash?: boolean;
  initialGeneration?: boolean;
  initialMaterial?: string;
  banner?: ReactNode;
  sync?: { status: string; online: boolean; run: () => Promise<void> };
  onReview?: (ids: string[], subject: string) => void;
}) {
  const embedded = !!subjectId;
  const key = `card-library.${subjectId || 'all'}`;
  const [chosenSubject, setSubject] = useJourneyState(`${key}.subject`, initialSubject);
  const subject =
    subjectId ||
    (chosenSubject === UNFILED_MATERIALS ||
    props.data.subjects.some((item) => item.id === chosenSubject)
      ? chosenSubject
      : '');
  const [scope, setScope] = useJourneyState<CardScope>(`${key}.scope`, 'all');
  const [query, setQuery] = useJourneyState(`${key}.query`, '');
  const [bucket, setBucket] = useJourneyState(`${key}.bucket`, '');
  const [sort, setSort] = useJourneyState<CardSort>(`${key}.sort`, 'due');
  const [trash, setTrash] = useJourneyState(`${key}.trash`, initialTrash);
  const [menu, setMenu] = useState(false);
  const [create, setCreate] = useState(false);
  const [generation, setGeneration] = useJourneyState(`${key}.generation`, initialGeneration);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [edit, setEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const action = useAction();
  const now = Date.now();
  const folderLanding = !embedded && !subject && !trash;
  const currentSubject = props.data.subjects.find((item) => item.id === subject);
  const subjectName =
    currentSubject?.name || (subject === UNFILED_MATERIALS ? '과목 미지정' : '과목 폴더');
  const scoped = cards.filter((c) => inLearningFolder(c.subjectId, subject, props.data.subjects));
  const live = scoped.filter((c) => !c.deleted);
  const due = libraryCards(
    props.data,
    scoped,
    { subject: '', scope: 'due', query: '', bucket: '', sort: 'due', trash: false },
    now,
  );
  const mastered = live.filter((c) => c.bucket === 'MASTERED');
  const deleted = scoped.filter((c) => c.deleted);
  const visible = libraryCards(
    props.data,
    scoped,
    { subject: '', scope, query, bucket, sort, trash },
    now,
  );
  const next = nextReviewDay(live, new Date(now));
  const preview = scoped.find((c) => c.id === previewId && !c.deleted);
  const groups =
    sort === 'name' || trash
      ? [{ label: trash ? '휴지통' : '이름순', cards: visible }]
      : [
          { label: '오늘 복습', cards: visible.filter((c) => isDue(c, now)) },
          {
            label: '복습 예정',
            cards: visible.filter((c) => !isDue(c, now) && !permanentlyMastered(c)),
          },
          { label: '암기완료', cards: visible.filter(permanentlyMastered) },
        ];
  const typeLabel = (c: Card) => (c.diagram ? '다이어그램' : TYPES[c.type][0]);
  const statusLabel = (c: Card) => BUCKETS.find((b) => b.id === c.bucket)?.label;
  const reset = () => {
    setQuery('');
    setBucket('');
    setScope('all');
  };
  const start = (ids: string[]) => {
    setPreviewId(null);
    if (onReview) onReview(ids, subject === UNFILED_MATERIALS ? '' : subject);
    else
      props.navigate(
        ids.length === 1
          ? `/flashcards?subject=${subject}&card=${ids[0]}`
          : `/flashcards?subject=${subject}&review=1`,
      );
  };
  const materials = props.data.materials.filter((m) =>
    inLearningFolder(m.subjectId, subject, props.data.subjects),
  );
  const generatedFrom = generationDefault(materials, initialMaterial || '');
  const newCard = (blind = false) =>
    props.navigate(
      `/create-card?${new URLSearchParams({ ...(currentSubject ? { subject } : {}), ...(blind ? { type: 'BLIND' } : {}) })}`,
    );
  const openFolder = (id: string) => {
    setSubject(id);
    reset();
  };
  const closePreview = () => {
    setPreviewId(null);
    setDeleting(false);
    setRevealed(false);
  };
  return (
    <>
      {!embedded && (
        <StudyHeader
          title={trash ? '카드 휴지통' : '카드 보관함'}
          back={() => (trash ? setTrash(false) : subject ? openFolder('') : props.back('/study'))}
          action={
            <>
              <StudyLibraryAction props={props} />
              <IconButton label="카드 보관함 메뉴" onClick={() => setMenu(true)}>
                <MoreHorizontal size={22} />
              </IconButton>
            </>
          }
        />
      )}
      <div
        className={`${styles.library}${embedded ? '' : ' page-inset'}`}
        data-card-library={subjectId || 'all'}
      >
        {banner}
        {!embedded && subject && !trash && (
          <nav className={styles.breadcrumb} aria-label="카드 폴더 경로">
            <button type="button" onClick={() => openFolder('')}>
              과목 폴더
            </button>
            <ChevronRight size={14} aria-hidden="true" />
            <strong aria-current="location">{subjectName}</strong>
          </nav>
        )}
        <div className={styles.tools}>
          {embedded || folderLanding || (!trash && subject) ? (
            <strong>{trash ? '카드 휴지통' : folderLanding ? '내 과목 폴더' : '내 카드'}</strong>
          ) : (
            <OptionField
              compact
              label="카드의 과목"
              value={subject}
              onChange={setSubject}
              options={[
                { value: '', label: '모든 과목' },
                ...props.data.subjects.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
          )}
          {!trash && !folderLanding && subject !== UNFILED_MATERIALS && (
            <button className={styles.add} onClick={() => setCreate(true)}>
              <Plus size={17} /> 카드 추가
            </button>
          )}
          {folderLanding && (
            <button
              className={styles.add}
              onClick={() =>
                materials.length ? setGeneration(true) : props.navigate('/subjects?upload=1')
              }
            >
              <Sparkles size={17} />
              AI로 카드 만들기
            </button>
          )}
          {embedded && (
            <IconButton label="이 과목 카드 메뉴" onClick={() => setMenu(true)}>
              <MoreHorizontal size={20} />
            </IconButton>
          )}
          {embedded && trash && (
            <button className={styles.add} onClick={() => setTrash(false)}>
              카드로 돌아가기
            </button>
          )}
        </div>
        {!trash && live.length > 0 && (
          <section
            className={styles.summary}
            aria-label={subject ? '선택 과목 복습 요약' : '전체 과목 복습 요약'}
            data-surface="muted"
          >
            <div>
              <strong>
                {due.length ? `지금 복습 ${due.length}장` : '지금 복습할 카드가 없어요'}
              </strong>
              <p>
                {due.length
                  ? `약 ${reviewMinutes(due.length)}분 · 전체 ${live.length}장`
                  : next
                    ? `다음 복습 ${next.when} · ${next.count}장`
                    : `전체 ${live.length}장 · 예정된 복습이 없어요`}
              </p>
            </div>
            {due.length > 0 && (
              <Button onClick={() => start(due.map((c) => c.id))}>{due.length}장 복습</Button>
            )}
          </section>
        )}
        {folderLanding && (
          <LearningFolders
            data={{ ...props.data, cards }}
            mode="cards"
            onSelect={openFolder}
            onManage={() => props.navigate('/subjects')}
            now={now}
          />
        )}
        {!folderLanding && !trash && live.length > 0 && (
          <div className={styles.tabs} role="group" aria-label="카드 목록 범위">
            {(
              [
                { id: 'all', label: '전체', count: live.length },
                { id: 'due', label: '오늘 복습', count: due.length },
                { id: 'mastered', label: '암기완료', count: mastered.length },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                aria-pressed={scope === t.id}
                onClick={() => {
                  setScope(t.id);
                  setBucket('');
                }}
              >
                {t.label}
                <small> {t.count}</small>
              </button>
            ))}
          </div>
        )}
        {!folderLanding && (live.length > 0 || trash) && (
          <>
            <label className={styles.search}>
              <Search size={18} />
              <input
                aria-label="카드 검색"
                placeholder="카드 제목 또는 과목 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button type="button" aria-label="검색어 지우기" onClick={() => setQuery('')}>
                  <X size={16} />
                </button>
              )}
            </label>
            <div className={styles.filters}>
              <span aria-live="polite">{visible.length}장</span>
              {!trash && scope !== 'mastered' && (
                <OptionField
                  compact
                  label="기억 상태"
                  value={bucket}
                  onChange={setBucket}
                  options={[
                    { value: '', label: '모든 상태' },
                    ...BUCKETS.map((b) => ({ value: b.id, label: b.label })),
                  ]}
                />
              )}
              <OptionField
                compact
                label="카드 정렬"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'due', label: '복습 예정순' },
                  { value: 'name', label: '이름순' },
                ]}
              />
            </div>
            {groups
              .filter((g) => g.cards.length)
              .map((g) => (
                <section key={g.label} className={styles.group} aria-label={g.label}>
                  <h3>
                    {g.label} · {g.cards.length}장
                  </h3>
                  {g.cards.map((c) => (
                    <div key={c.id}>
                      {trash ? (
                        <div className={styles.row}>
                          <span>
                            <strong>{cardTitle(c, props.data)}</strong>
                            <small>{typeLabel(c)}</small>
                          </span>
                          <button
                            disabled={action.busy}
                            className={styles.add}
                            onClick={() =>
                              action.run(async () => {
                                await api(`/cards/${c.id}`, { deleted: false }, 'PATCH');
                                await props.refresh();
                                props.toast('카드를 복원했어요');
                              })
                            }
                          >
                            복원
                          </button>
                        </div>
                      ) : (
                        <button
                          className={styles.row}
                          onClick={() => {
                            setPreviewId(c.id);
                            setRevealed(false);
                            setDeleting(false);
                          }}
                        >
                          <span>
                            <strong>{cardTitle(c, props.data)}</strong>
                            <small>
                              {[
                                !embedded &&
                                  props.data.subjects.find((s) => s.id === c.subjectId)?.name,
                                typeLabel(c),
                                statusLabel(c),
                                !isDue(c, now) && !permanentlyMastered(c) && whenLabel(c, now).text,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </small>
                          </span>
                          <ChevronRight size={17} />
                        </button>
                      )}
                    </div>
                  ))}
                </section>
              ))}
          </>
        )}
        {!folderLanding && !visible.length && (
          <div className={styles.empty}>
            <strong>
              {trash
                ? deleted.length
                  ? '조건에 맞는 카드가 없어요'
                  : '휴지통이 비어 있어요'
                : !live.length
                  ? '아직 카드가 없어요'
                  : scope === 'due' && !query && !bucket
                    ? '오늘 복습할 카드가 없어요'
                    : '조건에 맞는 카드가 없어요'}
            </strong>
            <p>
              {!live.length && !trash
                ? '직접 만들거나 이 과목 자료로 카드를 만들어 보세요.'
                : trash
                  ? '삭제한 카드는 여기서 다시 복원할 수 있어요.'
                  : '검색어나 기억 상태를 바꾸거나 전체 카드를 확인해 보세요.'}
            </p>
            {live.length > 0 && !trash && <button onClick={reset}>전체 카드 보기</button>}
            {trash && query && <button onClick={() => setQuery('')}>검색어 지우기</button>}
            {!live.length && !trash && (
              <Button variant="secondary" onClick={() => setCreate(true)}>
                첫 카드 만들기
              </Button>
            )}
          </div>
        )}
        <ErrorNote error={action.error} />
      </div>
      <Sheet open={menu} onClose={() => setMenu(false)} title="카드 관리">
        <div className="study-options">
          <button
            onClick={() => {
              setMenu(false);
              setTrash(!trash);
              reset();
            }}
          >
            <span>{trash ? '카드 보관함' : '휴지통'}</span>
            <small>{trash ? live.length : deleted.length}장</small>
            <ChevronRight size={18} />
          </button>
          <button onClick={() => props.navigate('/settings/learning')}>
            <span>복습 방식 설정</span>
            <ChevronRight size={18} />
          </button>
          {sync && (
            <button disabled={!sync.online} onClick={() => void sync.run()}>
              <span>기록 동기화</span>
              <small>{sync.status}</small>
            </button>
          )}
        </div>
      </Sheet>
      <Sheet open={create} onClose={() => setCreate(false)} title="카드 추가">
        <div className="study-options">
          <button
            onClick={() => {
              setCreate(false);
              newCard();
            }}
          >
            <span>직접 만들기</span>
            <small>질문과 답을 직접 적어요</small>
            <ChevronRight size={18} />
          </button>
          <button
            onClick={() => {
              setCreate(false);
              newCard(true);
            }}
          >
            <span>이미지 가림 만들기</span>
            <small>그림·사진의 핵심 부분을 가리고 외워요</small>
            <ChevronRight size={18} />
          </button>
          <button
            onClick={() => {
              setCreate(false);
              if (materials.length) setGeneration(true);
              else
                props.navigate(
                  currentSubject ? `/subjects/${subject}?upload=1` : '/subjects?upload=1',
                );
            }}
          >
            <span>{materials.length ? 'AI로 카드 만들기' : 'AI 카드용 자료 올리기'}</span>
            <small>
              {materials.length
                ? 'PDF·사진·필기에서 핵심을 골라 만들어요'
                : '자료를 올린 뒤 AI로 카드를 만들어요'}
            </small>
            <ChevronRight size={18} />
          </button>
        </div>
      </Sheet>
      <Sheet open={!!preview && !edit} onClose={closePreview} title="카드 미리보기">
        {preview && (
          <div className={styles.preview}>
            <p>
              {[
                props.data.subjects.find((s) => s.id === preview.subjectId)?.name,
                typeLabel(preview),
                statusLabel(preview),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <h3>{cardTitle(preview, props.data)}</h3>
            {preview.diagram && <DiagramCardContent card={preview} revealed={revealed} />}
            {preview.type === 'BLIND' && preview.image && !preview.diagram && (
              <div className="recall-image">
                <img src={preview.image} alt={preview.front} draggable={false} />
                {!revealed &&
                  preview.masks?.map((mask, i) => (
                    <span
                      key={i}
                      className="recall-mask"
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
            <details className={styles.answer} onToggle={(e) => setRevealed(e.currentTarget.open)}>
              <summary>
                정답 확인
                <ChevronDown size={17} />
              </summary>
              <p>{preview.back}</p>
            </details>
            <Button className="w-full" onClick={() => start([preview.id])}>
              이 카드 복습하기
            </Button>
            <div className={styles.actions}>
              {!preview.diagram && <button onClick={() => setEdit(true)}>내용 수정</button>}
              <button onClick={() => setDeleting((v) => !v)}>휴지통으로 옮기기</button>
            </div>
            {deleting && (
              <div className={styles.answer}>
                <p>휴지통으로 옮길까요? 나중에 복원할 수 있어요.</p>
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await api(`/cards/${preview.id}`, { deleted: true }, 'PATCH');
                      await props.refresh();
                      closePreview();
                      props.toast('카드를 휴지통으로 옮겼어요');
                    })
                  }
                >
                  옮기기
                </Button>
              </div>
            )}
            <ErrorNote error={action.error} />
          </div>
        )}
      </Sheet>
      {edit && preview && (
        <EditCard
          props={props}
          card={preview}
          onClose={() => {
            setEdit(false);
            setRevealed(false);
          }}
        />
      )}
      <GenerationSheet
        key={subject || 'all'}
        open={generation}
        onClose={() => setGeneration(false)}
        props={props}
        mode="cards"
        initialMaterial={generatedFrom}
      />
    </>
  );
}
