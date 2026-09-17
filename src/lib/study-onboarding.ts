import type { AppData, Material, Subject } from './contracts';

/** A sole subject is unambiguous; multiple subjects always require an explicit choice. */
export function soleUploadSubject(subjects: Subject[], materials?: Material[]): Subject | null {
  if (
    subjects.length === 1 &&
    materials?.some((m) => m.subjectId === subjects[0].id && m.extraction === 'sample') &&
    !materials.some((m) => m.subjectId === subjects[0].id && m.extraction !== 'sample')
  )
    return null;
  return subjects.length === 1 ? subjects[0] : null;
}

/** Actual content determines the next step, including cards made without a source. */
export function studyOnboarding(
  data: Pick<AppData, 'materials' | 'questions' | 'essays' | 'cards'>,
) {
  const usableSources = data.materials.filter((material) => material.contentLength >= 20).length;
  const hasLearning =
    data.questions.length > 0 || data.essays.length > 0 || data.cards.some((card) => !card.deleted);
  const phase = hasLearning
    ? 'ready'
    : usableSources
      ? 'first-study'
      : data.materials.length
        ? 'source-needs-content'
        : 'first-source';
  return { phase, usableSources } as const;
}
