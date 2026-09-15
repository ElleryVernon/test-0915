import type { AppData, Material } from './contracts';
import type { EssayDraft } from './study-drafts';
import { essayRevision } from './study-drafts';

export const seoulDateKey = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(date);
export function homeWeek(weekly: number[], now: Date) {
  const today = seoulDateKey(now);
  const day = new Date(`${today}T12:00:00+09:00`);
  const dayIndex = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const counts = new Map(
    Array.from({ length: 7 }, (_, i) => [
      seoulDateKey(new Date(day.getTime() - (6 - i) * 86400000)),
      weekly[i] || 0,
    ]),
  );
  return Array.from({ length: 7 }, (_, i) => {
    const date = seoulDateKey(new Date(day.getTime() + (i - dayIndex) * 86400000));
    return { date, done: (counts.get(date) || 0) > 0, today: date === today, future: date > today };
  });
}
export function homeAgenda(data: Pick<AppData, 'schedules'>, now: Date) {
  const today = seoulDateKey(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const schedules = data.schedules
    .filter((s) => s.date.slice(0, 10) === today)
    .sort((a, b) => a.start.localeCompare(b.start));
  const next = schedules.find((s) => !s.done && s.end > time);
  const done = schedules.filter((s) => s.done).length;
  const start = next?.start.split(':').map(Number);
  const end = next?.end.split(':').map(Number);
  const duration = start && end ? end[0] * 60 + end[1] - (start[0] * 60 + start[1]) : 0;
  const startLabel = start
    ? `${start[0] < 12 ? '오전' : '오후'} ${start[0] % 12 || 12}:${String(start[1]).padStart(2, '0')}`
    : '';
  return {
    next,
    done,
    total: schedules.length,
    duration,
    label: next
      ? `${startLabel} · ${next.start <= time ? '지금 할 공부' : '다음 시간표'}`
      : '오늘의 시간표',
  };
}
export function remainingMaterialQuestions(
  data: Pick<AppData, 'questions' | 'attempts'>,
  materialId: string,
) {
  const answered = new Set(data.attempts.map((a) => a.questionId).filter(Boolean));
  return data.questions.filter((q) => q.materialId === materialId && !answered.has(q.id));
}
export interface Continuation {
  kind: 'quiz' | 'essay';
  id: string;
  title: string;
  description: string;
  progress: string;
  href: string;
  updatedAt: string;
}
export function homeContinuations(data: AppData, drafts: EssayDraft[]): Continuation[] {
  const quiz = data.materials
    .flatMap((material) => {
      const questions = data.questions.filter((q) => q.materialId === material.id);
      const remaining = remainingMaterialQuestions(data, material.id);
      if (!remaining.length || remaining.length === questions.length) return [];
      const ids = new Set(questions.map((q) => q.id));
      const latest = data.attempts
        .filter((a) => a.questionId && ids.has(a.questionId))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      const done = questions.length - remaining.length;
      return [
        {
          kind: 'quiz' as const,
          id: material.id,
          title: material.title,
          description: `문제 ${done} / ${questions.length} 완료`,
          progress: `${Math.round((done / questions.length) * 100)}%`,
          href: `/quiz?material=${encodeURIComponent(material.id)}&resume=1`,
          updatedAt: latest.createdAt,
        },
      ];
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 1);
  const essay = drafts
    .flatMap((draft) => {
      const item = data.essays.find(
        (e) => e.id === draft.essayId && essayRevision(e) === draft.revision,
      );
      if (
        !item ||
        data.attempts.some(
          (a) => a.essayId === item.id && Date.parse(a.createdAt) >= Date.parse(draft.updatedAt),
        )
      )
        return [];
      const stages = ['키워드 선택 중', '순서 연결 중', '도식 힌트 확인 중', '답안 작성 중'];
      return [
        {
          kind: 'essay' as const,
          id: item.id,
          title: `서술형 · ${item.prompt}`,
          description: `${draft.stage}단계 ${stages[draft.stage - 1]} · ${draft.stage === 4 ? `${draft.answer.length}자 작성` : `키워드 ${draft.selected.length}개 선택`}`,
          progress: `${draft.stage}/4`,
          href: `/essay?essay=${encodeURIComponent(item.id)}`,
          updatedAt: draft.updatedAt,
        },
      ];
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 1);
  return [...quiz, ...essay];
}
export function recentMaterials(materials: Material[]) {
  return [...materials]
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .slice(0, 2);
}
export const materialHref = (material: Material) =>
  `/subjects/${encodeURIComponent(material.subjectId)}?material=${encodeURIComponent(material.id)}`;
export function materialMeta(data: AppData, material: Material) {
  const questions = data.questions.filter((q) => q.materialId === material.id).length;
  const essays = data.essays.filter((e) => e.materialId === material.id).length;
  return [
    data.subjects.find((s) => s.id === material.subjectId)?.name || '내 과목',
    questions ? `문제 ${questions}` : '',
    essays ? `서술형 ${essays}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
