'use client';
import { useEffect, useState } from 'react';
import type { Question, ScreenProps } from '@/lib/contracts';
import { conceptConnections } from '@/lib/learning-followup';
import { ChevronRight, Link2 } from '@/components/icons';
import { api } from '@/lib/api';
import styles from './learning-followup.module.css';
type Standard = { code: string; course: string; text: string; source: string };
export function ConceptConnections({
  question,
  props,
}: {
  question: Question;
  props: ScreenProps;
}) {
  const links = conceptConnections(question, props.data);
  const [official, setOfficial] = useState<{ id: string; standards: Standard[] } | null>(null);
  useEffect(() => {
    let current = true;
    void api<{ standards: Standard[] }>(
      `/quiz/connections?questionId=${encodeURIComponent(question.id)}`,
    )
      .then((result) => {
        if (current) setOfficial({ id: question.id, standards: result.standards });
      })
      .catch(() => {
        if (current) setOfficial(null);
      });
    return () => {
      current = false;
    };
  }, [question.id, props.data.profile.grade]);
  const standards = official?.id === question.id ? official.standards : [];
  if (!links.length && !standards.length) return null;
  return (
    <section className={styles.section} aria-label="개념 연결">
      <div className="flex items-center justify-between gap-3">
        <h3>개념을 연결해 봐요</h3>
        <button
          className="min-h-11 text-xs font-semibold text-muted"
          onClick={() => props.navigate('/completed-subjects')}
        >
          배운 과목 설정
        </button>
      </div>
      {links.length > 0 && (
        <p className="text-xs leading-relaxed text-muted">
          문제에서 제안한 연결이에요. 배운 과목 표시를 기준으로 살펴보세요.
        </p>
      )}
      {links.map((link) => (
        <div key={link.kind} className="rounded-2xl bg-surface p-4">
          <span className="text-xs text-muted">
            {link.kind === 'past' ? '앞서 연결되는 개념' : '다음에 이어지는 개념'} ·{' '}
            {link.learned ? '배운 과목' : '학습 여부 미설정'}
          </span>
          <p className="mt-2 text-sm font-semibold leading-relaxed">{link.text}</p>
          {link.subjectId && (
            <button
              className="mt-2 flex min-h-11 items-center gap-2 text-xs font-semibold"
              onClick={() => props.navigate(`/subjects/${encodeURIComponent(link.subjectId!)}`)}
            >
              <Link2 size={15} />내 {link.course} 자료 살펴보기
              <ChevronRight size={15} />
            </button>
          )}
        </div>
      ))}
      {standards.length > 0 && (
        <details className="rounded-2xl bg-surface p-4">
          <summary className="cursor-pointer py-2 text-sm font-semibold">
            관련 교육과정 학습 목표
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            2022 교육과정 원문에서 찾은 관련 목표예요. 정답의 근거는 올린 자료에서 확인해 주세요.
          </p>
          {standards.map((s) => (
            <div key={s.code} className="mt-4">
              <span className="text-xs text-muted">
                {s.course} · {s.code}
              </span>
              <p className="mt-1 text-sm leading-relaxed">{s.text}</p>
            </div>
          ))}
          <a
            className="mt-3 inline-flex min-h-11 items-center gap-1 text-xs font-semibold"
            href={standards[0].source}
            target="_blank"
            rel="noreferrer"
          >
            교육부 고시 원문
            <ChevronRight size={14} />
          </a>
        </details>
      )}
    </section>
  );
}
