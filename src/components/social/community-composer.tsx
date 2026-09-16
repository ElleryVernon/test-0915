'use client';
import { useEffect, useRef, useState } from 'react';
import type { Post, ScreenProps } from '@/lib/contracts';
import type { CommunityDraft } from '@/lib/community-types';
import { api } from '@/lib/api';
import { readCommunityDraft, saveCommunityDraft, clearCommunityDraft } from '@/lib/community-draft';
import { Button, Sheet } from '@/components/ui';
import { Checkbox, OptionField } from '@/components/ui-choice';
import { Plus } from '@/components/icons';
import { BlockPicker, BlockDraftList } from './community-blocks';
import styles from './community-v3.module.css';
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
    category: editing?.category || (parent ? '자유' : '질문'),
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
  return (
    <Sheet
      open
      fullScreen
      onClose={() => !busy && onClose()}
      title={editing ? '글 수정' : returnToStudy ? '커뮤니티에 물어보기' : '글쓰기'}
    >
      {resume ? (
        <div className="layout-section">
          <div>
            <h3 className="text-lg font-bold">작성하던 글을 이어 쓸까요?</h3>
            <p className="text-sm text-muted mt-2">
              {resume.scope === 'school' ? '학교 커뮤니티' : '전체 커뮤니티'} ·{' '}
              {new Date(resume.updatedAt).toLocaleDateString('ko-KR')}
            </p>
          </div>
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
        <form onSubmit={publish} className={styles.composer}>
          <fieldset disabled={busy} className="contents">
            <div className={styles.composerContext}>
              <span>
                {draft.scope === 'school' ? data.profile.school : '전체 커뮤니티'}에 올려요
              </span>
              <Checkbox
                name="community-anonymous"
                checked={draft.anonymous}
                onChange={(anonymous) => update({ anonymous })}
              >
                익명
              </Checkbox>
            </div>
            <div className={styles.composerFields}>
              <OptionField
                label="글 종류"
                name="community-category"
                compact
                value={draft.category}
                options={(parent
                  ? ['자유', '공부 팁', '수시', '정시']
                  : ['질문', '자유', '공부 팁', '수시', '정시']
                ).map((value) => ({ value, label: value }))}
                onChange={(category) => update({ category })}
              />
              {!parent && (
                <OptionField
                  label="과목"
                  name="community-subject"
                  compact
                  value={draft.tags.subjectId || ''}
                  options={[
                    { value: '', label: '과목 선택' },
                    ...data.subjects.map((s) => ({ value: s.id, label: s.name })),
                  ]}
                  onChange={(subjectId) =>
                    update({
                      tags: {
                        ...draft.tags,
                        subjectId,
                        subjectName: data.subjects.find((s) => s.id === subjectId)?.name,
                      },
                    })
                  }
                />
              )}
              {!parent && !!data.profile.grade && (
                <Checkbox
                  name="community-grade"
                  checked={!!draft.tags.grade}
                  onChange={(show) =>
                    update({
                      tags: { ...draft.tags, grade: show ? data.profile.grade : undefined },
                    })
                  }
                >
                  {data.profile.grade} 표시
                </Checkbox>
              )}
            </div>
            <input
              aria-label="글 제목"
              autoFocus
              maxLength={120}
              value={draft.title}
              onChange={(e) => update({ title: e.target.value })}
              placeholder={
                draft.category === '질문' ? '무엇이 막혔나요?' : '어떤 이야기를 나누고 싶나요?'
              }
              className="compose-title"
            />
            <textarea
              aria-label="글 내용"
              maxLength={10000}
              value={draft.body}
              onChange={(e) => update({ body: e.target.value })}
              placeholder="아는 데까지 적고, 문제나 카드를 붙여 주세요"
              className={styles.composeBody}
            />
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
            <div className={styles.attachRow}>
              <Button
                variant="outline"
                size="compact"
                type="button"
                disabled={draft.blocks.length >= 5}
                onClick={() => setPicker(true)}
              >
                <Plus size={18} /> {parent ? '사진·투표 첨부' : '학습 내용 첨부'}
              </Button>
              <span>첨부 {draft.blocks.length}/5</span>
            </div>
            {draft.blocks.length >= 5 && (
              <p className="text-sm text-muted">첨부는 5개까지예요. 하나 빼면 더 넣을 수 있어요.</p>
            )}
            {!data.posts.some((p) => p.isMine) && (
              <p className="text-xs text-muted">
                익명이어도 신고되면 운영팀이 확인해요. 자료에 이름·얼굴·학교 정보가 없는지 확인해
                주세요.
              </p>
            )}
          </fieldset>
          <div className={styles.publishBar}>
            <p className="text-xs text-muted" role="status">
              {editing
                ? '수정한 내용은 저장해야 반영돼요.'
                : persisted
                  ? '닫아도 초안은 이 기기에 7일간 남아요.'
                  : '기기 저장 공간이 부족해요. 닫기 전에 내용을 복사해 주세요.'}
            </p>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={busy || !draft.title.trim() || (!draft.body.trim() && !draft.blocks.length)}
            >
              {busy
                ? '저장 중…'
                : editing
                  ? '수정 저장'
                  : returnToStudy
                    ? '질문 올리고 학습으로 돌아가기'
                    : draft.category === '질문'
                      ? '질문 올리기'
                      : '이야기 올리기'}
            </Button>
          </div>
        </form>
      )}
      <BlockPicker
        data={data}
        photoCount={draft.blocks.filter((b) => b.type === 'PHOTO').length}
        open={picker}
        onClose={() => setPicker(false)}
        remaining={5 - draft.blocks.length}
        onAdd={(block) => {
          update({ blocks: [...draft.blocks, block] });
          setPicker(false);
        }}
      />
    </Sheet>
  );
}
