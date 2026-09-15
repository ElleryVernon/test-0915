import type { Bucket, Schedule } from '../contracts';
import { findFreeSlot, freeWindows, minutes, STUDY_DAY } from '../schedule';

export type Rating = Exclude<Bucket, 'MASTERED'>;
export function nextReview(consecutiveEasy: number, rating: Rating, now = new Date()) {
  if (!['AGAIN', 'HARD', 'GOOD', 'EASY'].includes(rating)) throw new Error('Invalid rating');
  const streak = rating === 'EASY' ? consecutiveEasy + 1 : 0;
  const minutes = { AGAIN: 10, HARD: 1440, GOOD: 4320, EASY: 10080 }[rating];
  return { consecutiveEasy: streak, bucket: (streak >= 2 ? 'MASTERED' : rating) as Bucket, nextReviewAt: new Date(now.getTime() + minutes * 60_000) };
}

export function normalized(text: string) { return text.normalize('NFKC').replace(/\s+/g, ' ').trim(); }
export function hasCitation(source: string, citation: string) {
  const needle = normalized(citation);
  return needle.length >= 8 && normalized(source).includes(needle);
}

// A transparent practice rubric, not a claim of semantic AI evaluation.
export function gradeEssay(answer: string, keywords: string[], modelAnswer: string) {
  const text = normalized(answer);
  const positions = keywords.map(word => text.indexOf(normalized(word)));
  const matched = keywords.filter((_, index) => positions[index] >= 0);
  const missing = keywords.filter((_, index) => positions[index] < 0);
  const present = positions.filter(pos => pos >= 0);
  const ordered = present.length >= 2 && present.every((pos, index) => index === 0 || pos > present[index - 1]);
  const sufficientLength = text.length >= Math.max(40, normalized(modelAnswer).length * 0.45);
  const score = Math.min(100, Math.round(matched.length / Math.max(keywords.length, 1) * 60) + (ordered ? 25 : 0) + (sufficientLength ? 15 : 0));
  const feedback = `키워드·순서 기반 연습 채점입니다. AI 의미 평가가 아닙니다. 핵심 키워드 ${matched.length}/${keywords.length}개가 포함됐어요. ${ordered ? '키워드의 인과 순서가 맞아요.' : '핵심 키워드를 원인부터 결과 순서로 연결해 보세요.'} ${sufficientLength ? '설명 분량이 충분해요.' : '키워드 사이의 관계를 문장으로 더 설명해 보세요.'}`;
  return { score, matched, missing, feedback };
}

export { minutes, timeString } from '../schedule';
export function conflict(a: Pick<Schedule, 'date'|'start'|'end'>, b: Pick<Schedule, 'date'|'start'|'end'>) {
  return a.date === b.date && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
}
export function validDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value; }
export type PlanSubject = { id: string; name: string; dueCards?: number };
const PLAN_LIMIT = { blocks: 4, minutes: 240, rest: 10 };
/**
 * Rule-based fallback for the two planner proposals. Blocks fill the free windows the timetable
 * shows (gaps between schedules and the evening until 22:00); an empty day uses 16:00–22:00.
 * `after` keeps today's proposals out of time that has already passed.
 */
export function proposePlans(date: string, existing: Pick<Schedule,'date'|'start'|'end'>[], subjects: PlanSubject[], after?: string) {
  const occupied = existing.filter(block => block.date === date);
  const free = freeWindows(occupied.map((block, index) => ({ ...block, id: String(index) })), { min: 60, after });
  const floor = after ? minutes(after) : 0;
  const windows = free.length
    ? free.map(window => [minutes(window.start), minutes(window.end)])
    : [[Math.max(minutes(STUDY_DAY.start), floor), minutes(STUDY_DAY.end)]];
  const targets = subjects.length ? subjects : [{ id: '', name: '자율 학습', dueCards: 0 }];
  const place = (specs: { title: string; subjectId: string; duration: number }[]) => {
    const blocks: Omit<Schedule,'id'>[] = [];
    let cursor = 0;
    let total = 0;
    for (const spec of specs) {
      if (blocks.length >= PLAN_LIMIT.blocks) break;
      const slot = [...new Set([spec.duration, 25])]
        .filter(duration => total + duration <= PLAN_LIMIT.minutes)
        .flatMap(duration => windows.map(([start, end]) => findFreeSlot(occupied, Math.max(start, cursor), duration, end)))
        .find(Boolean);
      if (!slot) continue;
      blocks.push({ date, ...slot, title: spec.title, kind: 'FLEXIBLE', subjectId: spec.subjectId || undefined, done: false });
      cursor = minutes(slot.end) + PLAN_LIMIT.rest;
      total += minutes(slot.end) - minutes(slot.start);
    }
    return blocks;
  };
  const title = (subject: PlanSubject, activity: string) => subject.id ? `${subject.name} ${activity}` : subject.name;
  const byDue = [...targets].sort((a, b) => (b.dueCards ?? 0) - (a.dueCards ?? 0));
  const top = byDue[0];
  const reviewSpecs = Array.from({ length: PLAN_LIMIT.blocks }, (_, index) => {
    const subject = byDue[index % byDue.length];
    const cycle = Math.floor(index / byDue.length);
    const due = cycle === 0 && (subject.dueCards ?? 0) > 0;
    return { title: title(subject, due ? '복습 카드' : ['개념 정리', '문제 풀이', '개념 복습'][Math.min(cycle, 2)]), subjectId: subject.id, duration: due ? 25 : 50 };
  });
  const evenSpecs = Array.from({ length: PLAN_LIMIT.blocks }, (_, index) => {
    const subject = targets[index % targets.length];
    const cycle = Math.floor(index / targets.length);
    return { title: title(subject, ['핵심 복습', '문제 풀이', '개념 정리'][Math.min(cycle, 2)]), subjectId: subject.id, duration: 25 };
  });
  const review = place(reviewSpecs);
  const even = place(evenSpecs);
  const evenSubjects = new Set(even.map(block => block.subjectId ?? '')).size;
  return { plans: [
    { name: '복습 우선', reason: (top.dueCards ?? 0) > 0 ? `${top.name} 복습 카드 ${top.dueCards}장이 ${targets.filter(subject => (subject.dueCards ?? 0) > 0).length > 1 ? '가장 많이 ' : ''}기다려요` : '복습할 카드가 없어서 개념 정리부터 담았어요', blocks: review },
    { name: '골고루', reason: evenSubjects > 1 ? `과목 ${evenSubjects}개를 25분씩 · 사이 10분 이상 쉬어요` : '25분씩 나눠서 · 사이 10분 이상 쉬어요', blocks: even },
  ] };
}
