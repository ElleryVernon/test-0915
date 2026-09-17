'use client';
import { ChevronRight, FolderOpen, Plus } from '@/components/icons';
import {
  learningFolders,
  type LearningFolderData,
  type LearningFolderMode,
} from '@/lib/learning-folders';
import styles from './learning-folders.module.css';

export function LearningFolders({
  data,
  mode,
  onSelect,
  onManage,
  now,
  semester,
}: {
  data: LearningFolderData;
  mode: LearningFolderMode;
  onSelect: (subjectId: string) => void;
  onManage?: () => void;
  now?: number;
  semester?: string;
}) {
  const folders = learningFolders(data, mode, now).filter(
    (folder) => !semester || folder.semester === semester,
  );
  const itemName = { cards: '카드', materials: '자료', quiz: '문제', notes: '취약 문제' }[mode];
  const unit = mode === 'cards' ? '장' : '개';
  return (
    <div className={styles.folders} data-learning-folders={mode}>
      <p className={styles.hint}>
        {folders.length
          ? `폴더 ${folders.length}개 · ${mode === 'cards' || mode === 'materials' ? '복습할 폴더부터' : mode === 'notes' ? '취약 문제가 있는 폴더부터' : '과목 이름순'}`
          : '과목이 자료·문제·카드를 담는 폴더가 돼요.'}
      </p>
      {folders.map((folder) => (
        <button
          key={folder.id}
          type="button"
          className={styles.folder}
          onClick={() => onSelect(folder.id)}
        >
          <span className={styles.icon}>
            <FolderOpen size={25} aria-hidden="true" />
          </span>
          <span className={styles.copy}>
            <strong>{folder.name}</strong>
            <small>
              {mode === 'materials'
                ? `자료 ${folder.materials} · 문제 ${folder.questions + folder.essays} · 카드 ${folder.cards}`
                : `${itemName} ${folder.total}${unit}${mode === 'quiz' && folder.newCount ? ` · 새 문제 ${folder.newCount}` : ''}`}
              {folder.semester ? ` · ${folder.semester}` : ''}
            </small>
          </span>
          {(mode === 'cards' || mode === 'materials') && folder.due > 0 && (
            <span className={styles.due}>
              지금 복습 <b>{folder.due}</b>
            </span>
          )}
          {mode === 'notes' && folder.weakCount > 0 && (
            <span className={styles.due}>
              다시 확인 <b>{folder.weakCount}</b>
            </span>
          )}
          <ChevronRight size={17} className={styles.chevron} aria-hidden="true" />
        </button>
      ))}
      {!folders.length && (
        <div className={styles.empty}>
          <FolderOpen size={28} />
          <strong>아직 과목 폴더가 없어요</strong>
          <p>공부할 과목을 만들고 그 안에서 {itemName}를 추가해 보세요.</p>
        </div>
      )}
      {onManage && (
        <button className={styles.manage} type="button" onClick={onManage}>
          <Plus size={18} />
          과목 폴더 관리
        </button>
      )}
    </div>
  );
}
