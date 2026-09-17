import type { AppData, Subject } from './contracts';
import { isDue } from './srs';
import { UNFILED_MATERIALS } from './material-folders';
import { latestAttempts, wrongEssays, wrongQuestions } from '../components/study/logic';

export type LearningFolderMode = 'materials' | 'cards' | 'quiz' | 'notes';
export type LearningFolderData = Pick<
  AppData,
  'subjects' | 'materials' | 'cards' | 'questions' | 'essays' | 'attempts'
>;
export interface LearningFolder {
  id: string;
  name: string;
  semester: string;
  total: number;
  materials: number;
  cards: number;
  questions: number;
  essays: number;
  due: number;
  newCount: number;
  weakCount: number;
}

/** A missing subject must never make already loaded learning content disappear. */
export function inLearningFolder(subjectId: string, folderId: string, subjects: Subject[]) {
  return (
    !folderId ||
    (folderId === UNFILED_MATERIALS
      ? !subjects.some((subject) => subject.id === subjectId)
      : subjectId === folderId)
  );
}

/** Counts come from the same records rendered by each library, never cached subject counters. */
export function learningFolders(
  data: LearningFolderData,
  mode: LearningFolderMode,
  now = Date.now(),
): LearningFolder[] {
  const known = new Set(data.subjects.map((subject) => subject.id));
  const folders = new Map<string, LearningFolder>(
    data.subjects.map((subject) => [
      subject.id,
      {
        id: subject.id,
        name: subject.name,
        semester: subject.semester,
        total: 0,
        materials: 0,
        cards: 0,
        questions: 0,
        essays: 0,
        due: 0,
        newCount: 0,
        weakCount: 0,
      },
    ]),
  );
  const folder = (subjectId: string) => {
    const id = known.has(subjectId) ? subjectId : UNFILED_MATERIALS;
    if (!folders.has(id))
      folders.set(id, {
        id,
        name: '과목 미지정',
        semester: '',
        total: 0,
        materials: 0,
        cards: 0,
        questions: 0,
        essays: 0,
        due: 0,
        newCount: 0,
        weakCount: 0,
      });
    return folders.get(id)!;
  };
  for (const material of data.materials) folder(material.subjectId).materials++;
  for (const card of data.cards) {
    if (card.deleted) continue;
    const entry = folder(card.subjectId);
    entry.cards++;
    if (isDue(card, now)) entry.due++;
  }
  const attempted = latestAttempts(data.attempts || [], 'questionId');
  for (const question of data.questions) {
    const entry = folder(question.subjectId);
    entry.questions++;
    if (!attempted.has(question.id)) entry.newCount++;
  }
  for (const essay of data.essays || []) folder(essay.subjectId).essays++;
  const attempts = data.attempts || [];
  for (const question of wrongQuestions({ questions: data.questions, attempts }))
    folder(question.subjectId).weakCount++;
  for (const essay of wrongEssays({ essays: data.essays || [], attempts }))
    folder(essay.subjectId).weakCount++;
  const counts = {
    materials: 'materials',
    cards: 'cards',
    quiz: 'questions',
    notes: 'weakCount',
  } as const;
  return [...folders.values()]
    .map((entry) => ({ ...entry, total: entry[counts[mode]] }))
    .filter((entry) => entry.id !== UNFILED_MATERIALS || entry.total > 0)
    .sort(
      (a, b) =>
        Number(a.id === UNFILED_MATERIALS) - Number(b.id === UNFILED_MATERIALS) ||
        (mode === 'cards' || mode === 'materials'
          ? Number(b.due > 0) - Number(a.due > 0)
          : mode === 'notes'
            ? Number(b.weakCount > 0) - Number(a.weakCount > 0)
            : 0) ||
        a.name.localeCompare(b.name, 'ko', { numeric: true }) ||
        a.id.localeCompare(b.id),
    );
}
