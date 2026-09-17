import { ArrowDown, Check, X } from '@/components/icons';
import { essayKeywordState } from '@/lib/essay-interaction';
import { essayMeaningUnits, essayStructure } from '@/lib/essay-structure';
import styles from './essay-structure.module.css';

export function EssayKeywordOptions({
  choices,
  selected,
  correct,
  checked,
  onSelect,
}: {
  choices: string[];
  selected: string[];
  correct: string[];
  checked: boolean;
  onSelect: (word: string) => void;
}) {
  return (
    <div className={styles.keywords} role="group" aria-label="설명에 필요한 키워드">
      {choices.map((word) => {
        const state = essayKeywordState(word, selected, correct, checked);
        const label = { correct: '정답', incorrect: '오답', missed: '놓친 정답' }[
          state as 'correct' | 'incorrect' | 'missed'
        ];
        return (
          <button
            key={word}
            type="button"
            aria-pressed={selected.includes(word)}
            aria-describedby="keyword-instruction"
            disabled={checked || (!selected.includes(word) && selected.length >= correct.length)}
            className={styles.keyword}
            data-state={state}
            onClick={() => onSelect(word)}
          >
            <span className={styles.keywordWord}>{word}</span>
            {label ? (
              <span className={styles.keywordStatus}>
                {state === 'incorrect' ? <X size={15} /> : <Check size={15} />}
                {label}
              </span>
            ) : state === 'selected' ? (
              <Check size={16} />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function EssayAnswerChunks({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`${styles.chunks} ${className}`}>
      {essayMeaningUnits(text).map((unit, index) => (
        <p key={index}>{unit}</p>
      ))}
    </div>
  );
}

export function EssayStructure({
  modelAnswer,
  citation,
  keywords,
}: {
  modelAnswer: string;
  citation: string;
  keywords: string[];
}) {
  const structure = essayStructure(modelAnswer, citation, keywords);
  return (
    <section className={styles.structure} aria-label="서술형 구조도">
      <p className={styles.structureNote}>
        {structure.source === 'modelAnswer' ? '예시 답안' : '자료 근거'}의 설명 순서예요. 표현이나
        순서는 달라도 괜찮아요.
      </p>
      {!structure.units.length ? (
        <p className={styles.structureNote}>아직 구조도로 정리할 예시나 근거가 없어요.</p>
      ) : (
        <ol className={styles.flow}>
          {structure.units.map((unit, index) => (
            <li key={index}>
              {index > 0 && (
                <div className={styles.connector} aria-hidden="true">
                  <ArrowDown size={16} />
                  <span>다음 설명</span>
                </div>
              )}
              <div className={styles.node}>
                <div className={styles.nodeHeading}>
                  <span className={styles.number}>{index + 1}</span>
                  <span>
                    {unit.keywords.length ? unit.keywords.join(' · ') : `설명 ${index + 1}`}
                  </span>
                </div>
                <p>{unit.text}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {structure.units.length > 1 && (
        <p className={styles.structureNote}>
          화살표는 글의 설명 순서이며, 인과관계를 뜻하지 않아요.
        </p>
      )}
    </section>
  );
}
