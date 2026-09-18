'use client';

import { useState } from 'react';
import type { AppData } from '@/lib/contracts';
import type { CommunityDraft } from '@/lib/community-types';
import { Button } from '@/components/ui';
import { OptionList, Segmented, Switch } from '@/components/ui-choice';
import { UserRound } from '@/components/icons';
import { AttachmentSheet } from './attachment-sheet';
import { schoolDisplayName } from './helpers';
import styles from './community-editor.module.css';

export type EditorSetting = 'board' | 'author' | 'subject';

export function CommunityEditorSettings({
  kind,
  draft,
  data,
  editing,
  onClose,
  onSave,
}: {
  kind: EditorSetting;
  draft: CommunityDraft;
  data: AppData;
  editing: boolean;
  onClose: () => void;
  onSave: (patch: Partial<CommunityDraft>) => void;
}) {
  const [scope, setScope] = useState(draft.scope);
  const [category, setCategory] = useState(draft.category);
  const [subjectId, setSubjectId] = useState(draft.tags.subjectId || '');
  const [query, setQuery] = useState('');
  const parent = data.profile.role === 'PARENT';
  const categories = parent
    ? ['자유', '공부 팁', '수시', '정시']
    : ['자유', '질문', '공부 팁', '수시', '정시'];
  if (!categories.includes(draft.category)) categories.push(draft.category);
  const title = kind === 'board' ? '게시판 선택' : kind === 'author' ? '작성자 표시' : '과목 선택';
  const save = () => {
    onSave(
      kind === 'board'
        ? { scope, category }
        : {
            tags: {
              ...draft.tags,
              subjectId: subjectId || undefined,
              subjectName: data.subjects.find((s) => s.id === subjectId)?.name,
            },
          },
    );
    onClose();
  };
  return (
    <AttachmentSheet
      open
      title={title}
      onClose={onClose}
      closeLabel={`${title} 닫기`}
      footer={
        <Button variant="secondary" className="w-full" onClick={kind === 'author' ? onClose : save}>
          {kind === 'author' ? '완료' : '적용하기'}
        </Button>
      }
    >
      <div className={styles.settings}>
        {kind === 'board' && (
          <>
            <Segmented
              label="게시할 공간"
              value={scope}
              onChange={setScope}
              options={[
                {
                  value: 'all',
                  label: '전체 커뮤니티',
                  disabled: editing && draft.scope !== 'all',
                },
                {
                  value: 'school',
                  label: '학교 커뮤니티',
                  disabled: (editing && draft.scope !== 'school') || !data.profile.school.trim(),
                },
              ]}
            />
            <p>
              {scope === 'school'
                ? `${schoolDisplayName(data.profile.school)} ${parent ? '학부모' : '학생'}들에게 보여요.`
                : `모든 학교의 ${parent ? '학부모' : '학생'}들이 볼 수 있어요.`}
              {!data.profile.school.trim() && ' 학교를 등록하면 학교 커뮤니티도 선택할 수 있어요.'}
            </p>
            <OptionList
              label="게시판 종류"
              value={category}
              onChange={setCategory}
              options={categories.map((value) => ({ value, label: value }))}
            />
          </>
        )}
        {kind === 'author' && (
          <>
            <div className={styles.authorPreview} aria-live="polite" aria-atomic="true">
              <span className={styles.settingsLabel}>게시글에 이렇게 보여요</span>
              <div className={styles.authorPreviewIdentity}>
                <span className={styles.previewAvatar} aria-hidden="true">
                  <UserRound size={18} />
                </span>
                <strong>{draft.anonymous ? '익명' : data.profile.nickname || '내 닉네임'}</strong>
                {!!draft.tags.grade && (
                  <span className={styles.previewGrade}>{draft.tags.grade}</span>
                )}
              </div>
            </div>
            <div className={styles.authorOptions}>
              <Switch
                label="익명으로 작성"
                description="끄면 닉네임과 프로필이 보여요."
                checked={draft.anonymous}
                onChange={(anonymous) => onSave({ anonymous })}
              />
              {!parent && !!data.profile.grade && (
                <Switch
                  label="학년 표시"
                  description={`이 글에 ${data.profile.grade} 정보를 함께 표시해요.`}
                  checked={!!draft.tags.grade}
                  onChange={(grade) =>
                    onSave({
                      tags: { ...draft.tags, grade: grade ? data.profile.grade : undefined },
                    })
                  }
                />
              )}
            </div>
            <p>이 글에만 적용돼요. 이 글에 남기는 내 댓글도 같은 이름으로 보여요.</p>
          </>
        )}
        {kind === 'subject' && (
          <>
            <input
              className={styles.subjectSearch}
              type="search"
              aria-label="과목 검색"
              placeholder="과목 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <OptionList
              label="글의 과목"
              value={subjectId}
              onChange={setSubjectId}
              options={[
                { value: '', label: '과목 없음' },
                ...data.subjects
                  .filter((subject) => subject.name.includes(query.trim()))
                  .map((subject) => ({ value: subject.id, label: subject.name })),
              ]}
            />
            {query && !data.subjects.some((subject) => subject.name.includes(query.trim())) && (
              <p>검색한 과목이 없어요. 다른 이름으로 찾아보세요.</p>
            )}
          </>
        )}
      </div>
    </AttachmentSheet>
  );
}
