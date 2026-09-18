import type { AppData, Card, Essay, Question } from './contracts';
import { isDue } from './srs';
import { essayRevision, type EssayDraft } from './study-drafts';
import { resumableStudySessions, type StudySession } from './study-sessions';

type StudyData = Pick<AppData, 'subjects' | 'questions' | 'essays' | 'cards' | 'attempts'> &
  Partial<Pick<AppData, 'stats'>>;
export interface StudyInvitation {
  kind: 'resume' | 'card' | 'question' | 'essay' | 'revisit';
  heading: [string, string];
  description: string;
  context: string;
  prompt: string;
  action: string;
  href: string;
}

export interface StudyResume extends StudyInvitation {
  id: string;
  updatedAt: string;
  progress: string;
}

/** Each actual interrupted activity stays independently reachable; type never outranks recency. */
export function studyResumeItems(
  data: StudyData,
  drafts: EssayDraft[],
  sessions: StudySession[],
  now = Date.now(),
): StudyResume[] {
  const subject = (id: string) => data.subjects.find((s) => s.id === id)?.name || '내 학습';
  const essays = drafts.flatMap((draft) => {
    const item = studyInvitation(data, [draft], now);
    if (item?.kind !== 'resume') return [];
    return [
      {
        ...item,
        id: `essay:${draft.essayId}`,
        updatedAt: draft.updatedAt,
        progress: draft.answer.trim()
          ? `${draft.answer.trim().length}자 작성`
          : draft.selected.length
            ? `키워드 ${draft.selected.length}개 선택`
            : '힌트 확인 중',
      },
    ];
  });
  const practice = resumableStudySessions(data, sessions).map((session): StudyResume => {
    const id = session.ids[session.index];
    if (session.kind === 'quiz') {
      const question = data.questions.find((q) => q.id === id)!;
      return {
        id: `quiz:${session.id}`,
        kind: 'resume',
        updatedAt: session.updatedAt,
        heading: ['풀던 문제부터', '이어가 볼까요?'],
        description: '고른 답과 풀이 기록을 보관했어요. 하던 곳부터 이어가요.',
        context: `${subject(question.subjectId)} · 문제풀이`,
        prompt: question.prompt,
        progress: session.pending
          ? '답안 저장 확인 필요'
          : session.result
            ? `${session.answers.length}/${session.ids.length}문제 완료 · 결과 확인 중`
            : session.answers.length
              ? `${session.answers.length}/${session.ids.length}문제 완료`
              : `첫 문제 ${session.selection === null ? '풀이' : '답 선택'} 중 · 전체 ${session.ids.length}문제`,
        action: session.result ? '풀이 결과 이어보기' : '이어서 풀기',
        href: `/quiz?checkpoint=${encodeURIComponent(session.id)}`,
      };
    }
    const card = data.cards.find((c) => c.id === id)!;
    return {
      id: `cards:${session.id}`,
      kind: 'resume',
      updatedAt: session.updatedAt,
      heading: ['꺼내던 기억을', '이어가 볼까요?'],
      description: '복습하던 카드와 순서를 보관했어요. 천천히 이어가요.',
      context: `${subject(card.subjectId)} · 카드 복습`,
      prompt:
        (card.sourceQuestionId &&
          data.questions.find((q) => q.id === card.sourceQuestionId)?.prompt) ||
        (card.image ? '이미지 속 개념을 떠올려 보세요.' : card.front),
      progress: `${session.ratings.length ? `${session.ratings.length}/${session.ids.length}장 복습` : `첫 카드 · 전체 ${session.ids.length}장`}${session.flipped ? ' · 정답 확인 중' : ''}`,
      action: '복습 이어하기',
      href: `/flashcards?checkpoint=${encodeURIComponent(session.id)}`,
    };
  });
  return [...new Map([...essays, ...practice].map((item) => [item.id, item])).values()].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id),
  );
}

/** One real, small next action. Never generate content or infer progress from an empty draft. */
export function studyInvitation(
  data: StudyData,
  drafts: EssayDraft[] = [],
  now = Date.now(),
): StudyInvitation | null {
  const context = (subjectId: string, kind: string) =>
    [data.subjects.find((s) => s.id === subjectId)?.name, kind].filter(Boolean).join(' · ');
  const latestDraft = [...drafts]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .find((draft) => {
      const essay = data.essays.find((e) => e.id === draft.essayId);
      return (
        essay &&
        essayRevision(essay) === draft.revision &&
        Number.isFinite(Date.parse(draft.updatedAt)) &&
        (draft.answer.trim() || draft.selected.length || draft.order.length || draft.hint) &&
        !data.attempts.some(
          (a) => a.essayId === essay.id && Date.parse(a.createdAt) >= Date.parse(draft.updatedAt),
        )
      );
    });
  if (latestDraft) {
    const essay = data.essays.find((e) => e.id === latestDraft.essayId)!;
    return {
      kind: 'resume',
      heading: ['쓰던 생각을', '이어가 볼까요?'],
      description: '조금씩 써도 괜찮아요. 하던 곳부터 이어가요.',
      context: context(essay.subjectId, '작성 중인 서술형'),
      prompt: essay.prompt,
      action: '이어서 쓰기',
      href: `/essay?essay=${encodeURIComponent(essay.id)}`,
    };
  }

  const liveCards = data.cards.filter((c) => !c.deleted);
  const due = liveCards
    .filter((c) => isDue(c, now))
    .sort(
      (a, b) => Date.parse(a.nextReviewAt) - Date.parse(b.nextReviewAt) || a.id.localeCompare(b.id),
    )[0];
  const cardPrompt = (card: Card) =>
    (card.sourceQuestionId && data.questions.find((q) => q.id === card.sourceQuestionId)?.prompt) ||
    (card.image ? '이미지 속 개념을 떠올려 보세요.' : card.front);
  if (due) {
    return {
      kind: 'card',
      heading: ['기억 하나만', '꺼내 볼까요?'],
      description: '오늘 복습할 카드예요. 한 장부터 가볍게 시작해요.',
      context: context(due.subjectId, '오늘의 복습 카드'),
      prompt: cardPrompt(due),
      action: '한 장 복습하기',
      href: `/flashcards?subject=${encodeURIComponent(due.subjectId)}&card=${encodeURIComponent(due.id)}`,
    };
  }

  const questionAction = (question: Question, revisit = false): StudyInvitation => ({
    kind: revisit ? 'revisit' : 'question',
    heading: revisit ? ['익숙한 문제도', '다시 보면 새로워요'] : ['딱 한 문제로', '시작해 볼까요?'],
    description: revisit
      ? '전에 풀었던 문제예요. 기억나는 만큼 다시 떠올려 봐요.'
      : '다 끝내지 않아도 괜찮아요. 한 문제부터 풀어 봐요.',
    context: context(question.subjectId, revisit ? '다시 풀어볼 문제' : '아직 안 푼 문제'),
    prompt: question.prompt,
    action: '한 문제 풀기',
    href: `/quiz?question=${encodeURIComponent(question.id)}`,
  });
  const essayAction = (essay: Essay, revisit = false): StudyInvitation => ({
    kind: revisit ? 'revisit' : 'essay',
    heading: ['내 생각을', '한 문장부터'],
    description: '완벽한 답이 아니어도 좋아요. 떠오르는 말부터 써 봐요.',
    context: context(essay.subjectId, revisit ? '다시 써볼 서술형' : '아직 안 쓴 서술형'),
    prompt: essay.prompt,
    action: '답안 써보기',
    href: `/essay?essay=${encodeURIComponent(essay.id)}`,
  });
  const answered = new Set(data.attempts.map((a) => a.questionId));
  const freshQuestion = data.questions.find((q) => !answered.has(q.id));
  if (freshQuestion) return questionAction(freshQuestion);
  const written = new Set(data.attempts.map((a) => a.essayId));
  const freshEssay = data.essays.find((e) => !written.has(e.id));
  if (freshEssay) return essayAction(freshEssay);
  if (data.questions[0]) {
    const revisit = questionAction(data.questions[0], true);
    if ((data.stats?.todayQuestions || 0) + (data.stats?.todayCards || 0) > 0) {
      revisit.heading = ['오늘도 기억을', '잘 쌓았어요'];
      revisit.description = '여기서 쉬어도 좋아요. 더 하고 싶다면 한 문제만 가볍게 풀어 봐요.';
    }
    return revisit;
  }
  if (data.essays[0]) return essayAction(data.essays[0], true);
  if (liveCards[0]) {
    return {
      kind: 'revisit',
      heading: ['차곡차곡 쌓인 기억,', '천천히 둘러봐요'],
      description: '지금 복습할 카드는 없어요. 익숙한 개념을 살펴볼까요?',
      context: '내 플래시카드',
      prompt: `${liveCards.length}장의 카드가 보관되어 있어요.`,
      action: '카드 살펴보기',
      href: '/flashcards',
    };
  }
  return null;
}
