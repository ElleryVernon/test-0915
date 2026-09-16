'use client';
import { useState } from 'react';
import type { Card, Essay, Post, Question, ScreenProps } from '@/lib/contracts';
import type { CommunityDraft, CommunitySourceRef } from '@/lib/community-types';
import { Button, Sheet } from '@/components/ui';
import { MessageCircle, ChevronRight } from '@/components/icons';
import { CommunityComposer } from './community-composer';
import { CommunityPostDetail } from './community';
import { api } from '@/lib/api';
export function CommunityAsk({
  question,
  card,
  essay,
  kind,
  ...props
}: ScreenProps & {
  question?: Question;
  card?: Card;
  essay?: Essay;
  kind: CommunitySourceRef['kind'];
}) {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<Post | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (props.data.profile.role !== 'STUDENT' || (!question && !card && !essay)) return null;
  const sourceRef: CommunitySourceRef = {
    kind,
    ...(question
      ? { questionId: question.id }
      : essay
        ? { essayId: essay.id }
        : { cardId: card!.id }),
  };
  const subject = props.data.subjects.find(
    (s) => s.id === (question?.subjectId || card?.subjectId || essay?.subjectId),
  );
  const wrong = props.data.attempts.filter(
    (a) => a.questionId === question?.id && !a.correct,
  ).length;
  const attempt = props.data.attempts
    .filter((a) => a.questionId === question?.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const selected =
    attempt && Number.isInteger(Number(attempt.answer)) ? Number(attempt.answer) : undefined;
  const essayAttempt = props.data.attempts
    .filter((a) => essay && a.essayId === essay.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (essay && !essayAttempt) return null;
  const attached = question
    ? {
        id: crypto.randomUUID(),
        type: 'QUESTION' as const,
        refId: question.id,
        hidden: true,
        payload: { ...question, subjectName: subject?.name, selected },
      }
    : essay
      ? {
          id: crypto.randomUUID(),
          type: 'ESSAY' as const,
          refId: essay.id,
          hidden: false,
          payload: {
            prompt: essay.prompt,
            answer: essayAttempt.answer,
            score: essayAttempt.score,
            subjectName: subject?.name,
          },
        }
      : {
          id: crypto.randomUUID(),
          type: 'CARD' as const,
          refId: card!.id,
          hidden: true,
          payload: { ...card, subjectName: subject?.name },
        };
  const initial: Partial<CommunityDraft> = {
    title: (question
      ? wrong
        ? `이 문제 ${wrong}번 틀렸어요. 어디서 헷갈린 걸까요?`
        : question.prompt
      : essay
        ? `이 답안을 어떻게 다듬으면 좋을까요?`
        : card!.front
    ).slice(0, 120),
    blocks: [attached],
    tags: { grade: props.data.profile.grade, subjectId: subject?.id, subjectName: subject?.name },
    sourceRef,
  };
  const linked =
    question?.communityPostId ||
    props.data.posts.find(
      (p) =>
        p.isMine &&
        (question
          ? p.sourceRef?.questionId === question.id
          : essay
            ? p.sourceRef?.essayId === essay.id
            : p.sourceRef?.cardId === card!.id),
    )?.id;
  async function showThread() {
    if (!linked || busy) return;
    setBusy(true);
    setError('');
    try {
      setThread(await api<Post>(`/posts/${linked}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="layout-group mt-4">
      {linked && (
        <Button variant="outline" size="compact" disabled={busy} onClick={showThread}>
          <MessageCircle size={16} />
          커뮤니티 질문·답변 보기
          <ChevronRight size={16} />
        </Button>
      )}
      <Button variant="ghost" size="compact" onClick={() => setOpen(true)}>
        <MessageCircle size={16} />
        {essay ? '내 답안 피드백 부탁하기' : '여전히 헷갈리면 물어보기'}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {open && (
        <CommunityComposer
          {...props}
          initial={initial}
          returnToStudy
          onClose={() => setOpen(false)}
        />
      )}
      <Sheet open={!!thread} onClose={() => setThread(null)} fullScreen title="커뮤니티 질문·답변">
        {thread && (
          <CommunityPostDetail
            {...props}
            post={thread}
            embedded
            onBack={() => setThread(null)}
            onRemoved={() => setThread(null)}
            onChange={async () => setThread(await api<Post>(`/posts/${thread.id}`))}
          />
        )}
      </Sheet>
    </div>
  );
}
