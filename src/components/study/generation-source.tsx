'use client';
import { ChevronRight, FileText } from '@/components/icons';
import type { AppData, Material } from '@/lib/contracts';
import styles from './generation-workspace.module.css';

/** Source context is a readable list; only the change action is a control. */
export function GenerationSource({
  data,
  selected,
  locked,
  onEdit,
}: {
  data: AppData;
  selected: Material[];
  locked?: boolean;
  onEdit?: () => void;
}) {
  return (
    <section className={styles.source} aria-label="선택한 자료">
      <div className={styles.sourceHeader}>
        <h3>
          사용할 자료 <span>{selected.length}개</span>
        </h3>
        {onEdit && (
          <button type="button" disabled={locked} onClick={onEdit}>
            변경 <ChevronRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <ul className={styles.sourceList}>
        {selected.map((material) => (
          <li key={material.id}>
            <span className={styles.fileIcon}>
              <FileText size={19} aria-hidden="true" />
            </span>
            <span className={styles.sourceCopy}>
              <strong>{material.title}</strong>
              <small>
                {data.subjects.find((s) => s.id === material.subjectId)?.name || '과목 미지정'} ·{' '}
                {material.extraction === 'combined' ? '모은 자료' : material.type.toUpperCase()}
              </small>
            </span>
          </li>
        ))}
      </ul>
      {selected.some((material) => material.type.toUpperCase() === 'PDF') && (
        <p className={styles.sourceNote}>
          PDF에서 읽은 본문으로 만들어요. 수식·반응식·입체 구조는 원본과 함께 확인해 주세요.
        </p>
      )}
    </section>
  );
}
