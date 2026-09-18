'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { Post, ScreenProps } from '@/lib/contracts';
import type { CommunityDraft, CommunityBlockType } from '@/lib/community-types';
import { api } from '@/lib/api';
import { readCommunityDraft, saveCommunityDraft, clearCommunityDraft } from '@/lib/community-draft';
import { Button } from '@/components/ui';
import { CommunityEditorPage } from './community-editor-page';
import { CommunityEditorSettings, type EditorSetting } from './community-editor-settings';
import {
  Plus,
  BookOpen,
  ImageIcon,
  Layers,
  FileText,
  ListChecks,
  ChevronDown,
  UserRound,
} from '@/components/icons';
import { BlockPicker, BlockDraftList } from './community-blocks';
import styles from './community-editor.module.css';
export interface CommunityComposerProps extends ScreenProps {
  onClose: () => void;
  onPublished?: (post: Post) => void;
  scope?: 'all' | 'school';
  initial?: Partial<CommunityDraft>;
  editing?: Post;
  returnToStudy?: boolean;
  autoResume?: boolean;
}
export function CommunityComposer(props: CommunityComposerProps) {
  const { data, editing, initial, onClose, onPublished, returnToStudy } = props;
  const parent = data.profile.role === 'PARENT';
  const source = initial?.sourceRef;
  const draftOwner =
    data.profile.id +
    (source ? `:${source.kind}:${source.questionId || source.cardId || source.essayId}` : '');
  const fresh = (): CommunityDraft => ({
    requestId: crypto.randomUUID(),
    title: editing?.title || '',
    body: editing?.body || '',
    category: editing?.category || '자유',
    anonymous: editing?.anonymous ?? true,
    blocks: editing?.blocks || [],
    tags: editing?.tags || { grade: data.profile.grade },
    scope: editing?.school ? 'school' : props.scope || 'all',
    sourceRef: editing?.sourceRef,
    updatedAt: new Date().toISOString(),
    ...initial,
  });
  const [resume, setResume] = useState(() =>
    editing || props.autoResume ? null : readCommunityDraft(draftOwner),
  );
  const [draft, setDraft] = useState(
    () => (props.autoResume && readCommunityDraft(draftOwner)) || fresh(),
  );
  const [picker, setPicker] = useState(false);
  const [pickerType, setPickerType] = useState<CommunityBlockType>();
  const [moreTools, setMoreTools] = useState(false);
  const [setting, setSetting] = useState<EditorSetting | null>(null);
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [persisted, setPersisted] = useState(true);
  const lock = useRef(false);
  const hasContent = !!draft.title.trim() || !!draft.body.trim() || draft.blocks.length > 0;
  useEffect(() => {
    if (resume || editing) return;
    if (hasContent) setPersisted(saveCommunityDraft(draftOwner, draft));
    else clearCommunityDraft(draftOwner);
  }, [draft, resume, editing, hasContent, draftOwner]);
  function update(patch: Partial<CommunityDraft>) {
    setDraft((d) => ({
      ...d,
      ...patch,
      requestId: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    }));
  }
  async function publish(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    if (!draft.title.trim()) return setError('제목을 적어 주세요.');
    if (!draft.body.trim() && !draft.blocks.length)
      return setError('내용을 적거나 학습 내용을 첨부해 주세요.');
    if (draft.scope === 'school' && !data.profile.school.trim())
      return setError('학교 정보를 먼저 등록해 주세요. 초안은 유지돼요.');
    if (!navigator.onLine)
      return setError('인터넷 연결이 없어요. 초안을 보관했어요. 연결 후 직접 다시 올려 주세요.');
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const post = await api<Post>(
        editing ? `/posts/${editing.id}` : '/posts',
        { ...draft, title: draft.title.trim(), body: draft.body.trim() },
        editing ? 'PATCH' : 'POST',
      );
      if (!editing) clearCommunityDraft(draftOwner);
      props.toast(
        editing
          ? '글을 수정했어요'
          : returnToStudy
            ? '질문을 올렸어요. 답변은 알림에서 확인할 수 있어요.'
            : '글을 올렸어요',
      );
      onPublished?.(post);
      onClose();
      props.refresh().catch(() => props.toast('글은 저장됐어요. 목록은 다시 불러와 주세요.'));
    } catch (e) {
      setError(`${(e as Error).message} 입력한 내용은 유지돼요.`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const tools = parent
    ? [
        { type: 'PHOTO', label: '사진', icon: ImageIcon },
        { type: 'POLL', label: '투표', icon: ListChecks },
      ]
    : [
        { type: 'PHOTO', label: '사진', icon: ImageIcon },
        { type: 'QUESTION', label: '문제', icon: BookOpen },
        { type: 'CARD', label: '카드', icon: Layers },
        { type: 'MATERIAL', label: '자료', icon: FileText },
        { type: 'MORE', label: '더보기', icon: Plus },
      ];
  return (
    <CommunityEditorPage
      onClose={onClose}
      busy={busy}
      title={editing ? '글 수정' : returnToStudy ? '커뮤니티에 물어보기' : '글쓰기'}
      action={
        !resume && (
          <button
            className={styles.submit}
            type="submit"
            form={formId}
            disabled={busy || !draft.title.trim() || (!draft.body.trim() && !draft.blocks.length)}
          >
            {busy ? '저장 중…' : editing ? '저장' : '등록'}
          </button>
        )
      }
      footer={
        !resume && (
          <>
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            <div className={styles.toolbar} aria-label="첨부 도구">
              {tools.map((tool) => (
                <button
                  key={tool.type}
                  type="button"
                  disabled={busy || draft.blocks.length >= 5}
                  aria-label={tool.type === 'MORE' ? '첨부 도구 더보기' : `${tool.label} 첨부`}
                  onClick={() => {
                    setMoreTools(tool.type === 'MORE');
                    setPickerType(
                      tool.type === 'MORE' ? undefined : (tool.type as CommunityBlockType),
                    );
                    setPicker(true);
                  }}
                >
                  <tool.icon size={21} />
                  <span>{tool.label}</span>
                </button>
              ))}
            </div>
            <p className={styles.status} role="status">
              {draft.blocks.length >= 5
                ? '첨부 5/5 · 하나를 빼면 더 넣을 수 있어요.'
                : !persisted
                  ? '초안을 저장하지 못했어요. 닫기 전에 내용을 복사해 주세요.'
                  : returnToStudy
                    ? '등록하거나 닫으면 공부하던 화면으로 돌아가요.'
                    : hasContent && !editing
                      ? '초안 저장됨'
                      : ''}
            </p>
          </>
        )
      }
    >
      {resume ? (
        <div className={styles.resume}>
          <h3>작성하던 글을 이어 쓸까요?</h3>
          <p>
            {resume.scope === 'school' ? '학교 커뮤니티' : '전체 커뮤니티'} ·{' '}
            {new Date(resume.updatedAt).toLocaleDateString('ko-KR')}
          </p>
          <div className={styles.draftPreview}>
            <strong>{resume.title || '제목 없는 글'}</strong>
            <p>{resume.body || `첨부 ${resume.blocks.length}개`}</p>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(resume);
              setResume(null);
            }}
          >
            이어서 쓰기
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              clearCommunityDraft(draftOwner);
              setResume(null);
              setDraft(fresh());
            }}
          >
            초안 지우고 새로 쓰기
          </Button>
        </div>
      ) : (
        <form id={formId} onSubmit={publish} className={styles.form}>
          <fieldset disabled={busy} className="contents">
            <div className={styles.context}>
              <button
                type="button"
                className={styles.contextButton}
                aria-haspopup="dialog"
                aria-label={`게시판 선택: ${draft.scope === 'school' ? '학교 커뮤니티' : '전체 커뮤니티'} · ${draft.category}`}
                onClick={() => setSetting('board')}
              >
                <span className={styles.contextLabel}>게시판</span>
                <strong>
                  {draft.scope === 'school' ? '학교 커뮤니티' : '전체 커뮤니티'} · {draft.category}
                </strong>
                <ChevronDown size={16} />
              </button>
              <div className={styles.metadata}>
                {!parent && (
                  <button
                    type="button"
                    className={styles.metadataButton}
                    aria-haspopup="dialog"
                    aria-label={`과목 선택: ${draft.tags.subjectName || '과목 없음'}`}
                    onClick={() => setSetting('subject')}
                  >
                    <BookOpen size={15} />
                    <span>{draft.tags.subjectName || '과목 추가'}</span>
                    <ChevronDown size={12} />
                  </button>
                )}
                <button
                  type="button"
                  className={styles.metadataButton}
                  aria-haspopup="dialog"
                  aria-label="작성자 표시 설정"
                  onClick={() => setSetting('author')}
                >
                  <UserRound size={15} />
                  <span>
                    {draft.anonymous ? '익명' : data.profile.nickname || '내 닉네임'}
                    {draft.tags.grade ? ` · ${draft.tags.grade} 표시` : ''}
                  </span>
                  <ChevronDown size={12} />
                </button>
              </div>
            </div>
            <input
              aria-label="글 제목"
              autoFocus
              maxLength={120}
              value={draft.title}
              onChange={(e) => update({ title: e.target.value })}
              placeholder="제목"
              className={styles.title}
            />
            <textarea
              aria-label="글 내용"
              maxLength={10000}
              value={draft.body}
              onChange={(e) => update({ body: e.target.value })}
              placeholder={
                draft.category === '질문'
                  ? '어떤 점이 궁금한가요?'
                  : '나누고 싶은 이야기를 적어 주세요.'
              }
              className={styles.text}
            />
            {draft.blocks.length > 0 && (
              <section className={styles.attachments} aria-label="이 글의 첨부">
                <div className={styles.attachmentHeading}>
                  <span>첨부한 내용</span>
                  <span>{draft.blocks.length}/5</span>
                </div>
                <BlockDraftList
                  blocks={draft.blocks}
                  onChange={(blocks) => {
                    const sourceId =
                      draft.sourceRef?.questionId ||
                      draft.sourceRef?.cardId ||
                      draft.sourceRef?.essayId;
                    update({
                      blocks,
                      sourceRef:
                        sourceId && blocks.some((b) => b.refId === sourceId)
                          ? draft.sourceRef
                          : undefined,
                    });
                  }}
                  data={data}
                />
              </section>
            )}
          </fieldset>
        </form>
      )}
      {setting && (
        <CommunityEditorSettings
          key={setting}
          kind={setting}
          draft={draft}
          data={data}
          editing={!!editing}
          onClose={() => setSetting(null)}
          onSave={update}
        />
      )}
      <BlockPicker
        data={data}
        photoCount={draft.blocks.filter((b) => b.type === 'PHOTO').length}
        open={picker}
        initialType={pickerType}
        allowedTypes={moreTools ? ['ESSAY', 'POLL', 'SCHEDULE', 'MATH'] : undefined}
        onClose={() => setPicker(false)}
        remaining={5 - draft.blocks.length}
        onAdd={(block) => {
          update({ blocks: [...draft.blocks, block] });
          setPicker(false);
        }}
      />
    </CommunityEditorPage>
  );
}
