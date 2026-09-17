'use client';
import { useState } from 'react';
import type { Card, Essay, Post, Question, ScreenProps } from '@/lib/contracts';
import type { CommunityDraft, CommunitySourceRef } from '@/lib/community-types';
import { Button, ListRow, Sheet } from '@/components/ui';
import { MessageCircle, ChevronRight, Layers, PenLine, BookOpen } from '@/components/icons';
import { CommunityComposer } from './community-composer';
import { CommunityPostDetail } from './community';
import { GenerationSheet } from '../study/shared';
import { askOptions, type AskOption } from '@/lib/community-nudges';
import { api } from '@/lib/api';
import followup from '../study/learning-followup.module.css';
export function CommunityAsk({
  question,
  card,
  essay,
  kind,
  heading = '다른 방법으로 이해해 볼까요?',
  ...props
}: ScreenProps & {
  question?: Question;
  card?: Card;
  essay?: Essay;
  kind: CommunitySourceRef['kind'];
  heading?: string;
}) {
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState(false);
  const [similar, setSimilar] = useState(false);
  const [practiceMode, setPracticeMode] = useState<'quiz' | 'essay'>('quiz');
  const [acting, setActing] = useState('');
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
  const linkedId =
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
  const linkedPost = linkedId ? props.data.posts.find((p) => p.id === linkedId) : undefined;
  const linkedLabel = !linkedPost
    ? '커뮤니티 질문·답변 보기'
    : linkedPost.solvedAt
      ? '커뮤니티 답변 · 해결됨'
      : linkedPost.commentCount
        ? `커뮤니티 답변 ${linkedPost.commentCount}개 도착`
        : '커뮤니티 질문 · 답변 기다리는 중';
  const materialId = question?.materialId ?? essay?.materialId;
  const canGenerate = props.data.materials.some((m) => m.id === materialId && m.contentLength >= 20);
  const options = askOptions({ kind, hasMaterial: canGenerate });
  async function choose(option: AskOption) {
    if (acting) return;
    if (option.id === 'ask') {
      setEntry(false);
      setOpen(true);
      return;
    }
    if (option.id === 'similar' || option.id === 'essay') {
      if (!canGenerate) return;
      setPracticeMode(option.id === 'essay' || essay ? 'essay' : 'quiz');
      setEntry(false);
      setSimilar(true);
      return;
    }
    setActing(option.id);
    setError('');
    try {
      const saved = await api<Card>('/quiz/review-card', { questionId: question!.id });
      await props.refresh();
      props.toast('오늘 복습할 카드에 담았어요');
      setEntry(false);
      props.navigate(`/flashcards?subject=${encodeURIComponent(saved.subjectId)}&card=${encodeURIComponent(saved.id)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing('');
    }
  }
  async function showThread() {
    if (!linkedId || busy) return;
    setBusy(true);
    setError('');
    try {
      setThread(await api<Post>(`/posts/${linkedId}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="layout-group mt-4">
      {linkedId && (
        <Button variant="outline" size="compact" disabled={busy} onClick={showThread}>
          <MessageCircle size={16} />
          {linkedLabel}
          <ChevronRight size={16} />
        </Button>
      )}
      {question ? (
        <section className={followup.section} aria-label={heading}>
          <h3>{heading}</h3>
          <div className={followup.actions}>
            {options.map((option) => {
              const Icon = { card: Layers, essay: PenLine, similar: BookOpen, ask: MessageCircle }[option.id];
              return <button key={option.id} className={followup.action}
                disabled={!!acting || (!canGenerate && (option.id === 'essay' || option.id === 'similar'))}
                onClick={() => void choose(option)}>
                <Icon size={20} aria-hidden="true" />
                <span><strong>{acting === option.id ? '카드를 준비하고 있어요…' : option.title}</strong><small>{option.sub}</small></span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>;
            })}
          </div>
        </section>
      ) : <Button
        variant="ghost"
        size="compact"
        onClick={() => (options.length > 1 ? setEntry(true) : setOpen(true))}
      >
        <MessageCircle size={16} />
        {essay ? '내 답안 피드백 부탁하기' : '여전히 헷갈리면 물어보기'}
      </Button>}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Sheet open={entry} onClose={() => setEntry(false)} title="여전히 헷갈리면">
        <div className="layout-group">
          {options.map((option) => (
            <ListRow
              key={option.id}
              title={acting === option.id ? '정리하는 중…' : option.title}
              description={option.sub}
              onClick={() => void choose(option)}
            />
          ))}
        </div>
      </Sheet>
      <GenerationSheet
        key={`${materialId}:${practiceMode}`}
        open={similar}
        onClose={() => setSimilar(false)}
        props={props}
        initialMaterial={materialId}
        initialTopic={question?.prompt}
        mode={practiceMode}
      />
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
