import type { AppData, Question } from './contracts';
import { normalizeCourseName } from './curriculum';

/** Generated links are learning hints, never evidence or official standards. */
export function conceptConnections(question: Question, data: Pick<AppData, 'subjects' | 'profile'>) {
  return ([['past', question.past], ['future', question.future]] as const).flatMap(([kind, raw]) => {
    const text = raw.trim();
    if (!text || text === '-' || text === '없음') return [];
    // A middle dot in a course name (사회·문화) is different from the spaced field separator.
    const [course, ...parts] = text.split(/\s+[·•]\s+|\s*[:：]\s*/);
    const normalized = normalizeCourseName(course);
    const subject = data.subjects.find((s) => normalizeCourseName(s.name) === normalized);
    const learned = data.profile.completedSubjects.some((name) => normalizeCourseName(name) === normalized);
    return [{ kind, text, course, concept: parts.join(' · '), subjectId: subject?.id, learned }];
  });
}
