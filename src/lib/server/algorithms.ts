import type { Bucket, Schedule } from '../contracts';

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

export function minutes(time: string) { const [h, m] = time.split(':').map(Number); return h * 60 + m; }
export function timeString(value: number) { return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
export function conflict(a: Pick<Schedule, 'date'|'start'|'end'>, b: Pick<Schedule, 'date'|'start'|'end'>) {
  return a.date === b.date && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
}
export function validDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value; }
export function proposePlans(date: string, existing: Pick<Schedule,'date'|'start'|'end'>[], subjects: {id:string;name:string}[]) {
  const targets = subjects.length ? subjects : [{id:'',name:'자율 학습'}];
  return { plans: [45, 25].map((duration, variant) => {
    const occupied = existing.filter(block => block.date === date);
    const blocks: Omit<Schedule,'id'>[] = [];
    let cursor = 16 * 60;
    while(cursor + duration <= 22 * 60 && blocks.length < 3) {
      const candidate = { date, start:timeString(cursor),end:timeString(cursor+duration) };
      if (occupied.some(block => conflict(candidate, block))) { cursor += 5; continue; }
      const subject = targets[blocks.length % targets.length];
      blocks.push({ ...candidate, title:`${subject.name} ${variant ? '집중 복습' : '개념 정리'}`, kind:'FLEXIBLE', subjectId:subject.id || undefined, done:false });
      cursor += duration + 10;
    }
    return { name: variant ? 'Plan B · 짧게 나눠서' : 'Plan A · 깊이 집중', blocks };
  }) };
}
