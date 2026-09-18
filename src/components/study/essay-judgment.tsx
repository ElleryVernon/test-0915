// The quick verdict shown while the graded coaching is still being written: which keywords the
// judge saw explained, and a provisional score. It is a preview, never the grade, and it says so.
export type EssayJudgment = {
  matched: string[];
  missing: string[];
  provisional: number;
  answerType: string;
  injection: number;
  model: string;
  durationMs: number;
};

/** One line that frames the preview for the student. */
export function judgmentNote(judgment: EssayJudgment): string {
  if (judgment.injection >= 0.7)
    return '학습 내용이 아니라 채점 지시로 보여요. 개념을 설명한 답안으로 다시 써 주세요.';
  if (judgment.matched.length === 0)
    return '아직 충분히 설명한 핵심 개념이 보이지 않아요. 코칭에서 무엇을 더 쓸지 알려드릴게요.';
  if (judgment.missing.length === 0) return '핵심 개념을 모두 다뤘어요. 점수와 코칭은 곧 도착해요.';
  return `핵심 개념 ${judgment.matched.length}개를 설명했어요. 점수와 코칭은 곧 도착해요.`;
}

export function QuickJudgment({
  judgment,
  keywords,
  pending,
}: {
  judgment: EssayJudgment | null;
  keywords: string[];
  pending: boolean;
}) {
  if (!judgment && !pending) return null;
  return (
    <section
      className="rounded-2xl bg-surface p-4"
      aria-live="polite"
      aria-label="먼저 확인한 핵심 개념"
      data-testid="quick-judgment"
    >
      <p className="text-xs font-semibold text-muted">먼저 확인한 핵심 개념</p>
      {judgment ? (
        <>
          <ul className="mt-3 flex flex-wrap gap-2" aria-label="핵심 개념 판정">
            {keywords.map((keyword) => {
              const explained = judgment.matched.includes(keyword);
              return (
                <li
                  key={keyword}
                  className={
                    explained
                      ? 'rounded-full bg-ink px-3 py-1.5 text-sm font-semibold text-white'
                      : 'rounded-full bg-surface-muted px-3 py-1.5 text-sm text-muted'
                  }
                  data-explained={explained ? 'true' : 'false'}
                >
                  {keyword}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-sm leading-relaxed text-secondary">{judgmentNote(judgment)}</p>
        </>
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-secondary">
          답안에서 핵심 개념을 확인하고 있어요…
        </p>
      )}
    </section>
  );
}
