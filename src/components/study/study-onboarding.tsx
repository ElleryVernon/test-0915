'use client';

import {
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Layers,
  PencilLine,
  Upload,
} from '@/components/icons';
import { Button } from '@/components/ui';
import type { ScreenProps } from '@/lib/contracts';
import { studyOnboarding } from '@/lib/study-onboarding';
import type { GenerationMode } from './logic';
import styles from './study-onboarding.module.css';

const choices = [
  {
    mode: 'cards',
    icon: Layers,
    label: '플래시카드',
    description: '중요한 개념을 카드로 기억해요',
  },
  {
    mode: 'essay',
    icon: PencilLine,
    label: '서술형 문제',
    description: '내 문장으로 설명하며 이해해요',
  },
  {
    mode: 'quiz',
    icon: BookOpen,
    label: '객관식 문제',
    description: '문제를 풀며 배운 내용을 확인해요',
  },
] as const;

export function StudyOnboarding({
  props,
  onAddSource,
  onGenerate,
  onManualCard,
}: {
  props: ScreenProps;
  onAddSource: () => void;
  onGenerate: (mode: GenerationMode) => void;
  onManualCard: () => void;
}) {
  const { phase, usableSources } = studyOnboarding(props.data);
  const ready = phase === 'first-study';
  const needsContent = phase === 'source-needs-content';
  return (
    <section className={styles.onboarding} aria-labelledby="study-start-title">
      <ol className={styles.steps} aria-label="학습 시작 순서">
        <li aria-current={!ready ? 'step' : undefined}>
          {ready && <Check size={14} aria-label="완료" />}자료 추가
        </li>
        <li aria-current={ready ? 'step' : undefined}>학습 만들기</li>
        <li>풀고 복습</li>
      </ol>
      <div className={styles.introduction}>
        <span className={styles.symbol} aria-hidden="true">
          {ready ? <Check size={28} /> : <FileText size={28} />}
        </span>
        <h2 id="study-start-title">
          {ready ? (
            <>
              자료가 준비됐어요
              <br />
              어떻게 공부할까요?
            </>
          ) : needsContent ? (
            <>
              자료 내용을 채우면
              <br />
              학습을 시작할 수 있어요
            </>
          ) : (
            <>
              공부할 자료 하나로
              <br />첫 학습을 시작해요
            </>
          )}
        </h2>
        <p>
          {ready
            ? `자료 ${usableSources}개로 카드나 문제를 만들 수 있어요. 원하는 학습 방법을 골라 주세요.`
            : needsContent
              ? '저장한 자료의 본문이 짧아요. 내용을 20자 이상 채우거나 새 자료를 추가해 주세요.'
              : '수업 필기, PDF, 사진을 올려 주세요. 내 자료에서 문제와 복습 카드를 만들 수 있어요.'}
        </p>
      </div>
      {ready ? (
        props.data.aiAvailable ? (
          <div className={styles.choices} aria-label="첫 학습 만들기">
            {choices.map(({ mode, icon: Icon, label, description }) => (
              <button key={mode} type="button" onClick={() => onGenerate(mode)}>
                <Icon size={23} aria-hidden="true" />
                <span>
                  <strong>{label} 만들기</strong>
                  <small>{description}</small>
                </span>
                <ChevronRight size={17} aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : (
          <div className={styles.unavailable}>
            <p>
              지금은 AI 학습 만들기를 이용할 수 없어요. 자료는 저장되어 있고, 카드는 직접 만들 수
              있어요.
            </p>
            <Button className="w-full" onClick={onManualCard}>
              직접 카드 만들기
            </Button>
          </div>
        )
      ) : (
        <div className={styles.start}>
          <Button
            className="w-full"
            onClick={needsContent ? () => props.navigate('/subjects') : onAddSource}
          >
            {!needsContent && <Upload size={18} />}{' '}
            {needsContent ? '자료 내용 확인하기' : '첫 자료 추가하기'}
          </Button>
          {needsContent && (
            <Button variant="ghost" className="w-full" onClick={onAddSource}>
              새 자료 추가하기
            </Button>
          )}
        </div>
      )}
      {(!ready || props.data.aiAvailable) && (
        <button type="button" className={styles.manual} onClick={onManualCard}>
          자료 없이 직접 카드 만들기 <ChevronRight size={16} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
