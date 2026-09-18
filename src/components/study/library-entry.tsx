'use client';
import { ChevronRight, FolderOpen } from '@/components/icons';
import library from './study-library.module.css';

/** Subject and source management remains inside the study hub. */
export function StudyLibraryEntry({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <section className={className} aria-label="과목과 자료 관리">
      <button type="button" className={library.libraryEntry} onClick={onClick}>
        <FolderOpen size={24} aria-hidden="true" />
        <span>
          <strong>내 과목·자료</strong>
          <small>과목을 추가하고 학습 자료를 정리해요</small>
        </span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    </section>
  );
}
