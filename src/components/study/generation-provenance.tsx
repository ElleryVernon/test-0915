'use client';
import { useEffect, useState } from 'react';
import { ChevronDown, FileText } from '@/components/icons';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import styles from './generation-provenance.module.css';

type Source = {
  id: string;
  title: string;
  subjectId: string;
  content: string;
  available: boolean;
  changed: boolean;
};
export function GenerationProvenance({ materialId }: { materialId: string }) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<{ sources: Source[] }>(`/materials/${materialId}/sources`, undefined, 'GET', {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setSources(result.sources);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            '함께 쓴 자료 목록을 불러오지 못했어요. 아래에는 생성 당시의 전체 본문이 있어요.',
          );
      });
    return () => controller.abort();
  }, [materialId, attempt]);
  return (
    <section className={styles.provenance} aria-label="생성에 사용한 자료">
      <div className={styles.heading}>
        <FileText size={18} />
        <strong>함께 사용한 자료{sources ? ` ${sources.length}개` : ''}</strong>
      </div>
      <p>학습 콘텐츠를 만들 때 사용한 본문이에요. 원본이 바뀌어도 이 근거는 그대로 남아요.</p>
      {!sources && !error && <p role="status">자료 목록을 불러오고 있어요.</p>}
      {error && (
        <>
          <p role="alert">{error}</p>
          <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
            다시 불러오기
          </Button>
        </>
      )}
      {sources?.map((source, index) => (
        <details key={source.id} className={styles.source}>
          <summary>
            <span>
              <strong>
                {index + 1}. {source.title}
              </strong>
              <small>
                {!source.available
                  ? '원본 삭제됨 · 생성 당시 본문 보관'
                  : source.changed
                    ? '원본 변경됨 · 생성 당시 본문 보관'
                    : '생성 당시 본문'}{' '}
                · <span className={styles.collapsedLabel}>본문 펼치기</span>
                <span className={styles.expandedLabel}>본문 접기</span>
              </small>
            </span>
            <ChevronDown size={18} aria-hidden="true" />
          </summary>
          <div className={styles.body}>{source.content}</div>
        </details>
      ))}
    </section>
  );
}
