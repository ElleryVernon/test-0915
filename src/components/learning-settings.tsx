'use client';
import { useState } from 'react';
import { Brain, Check, ChevronRight, Repeat2, Info } from '@/components/icons';
import { Button, ScreenHeader } from './ui';
import { api } from '@/lib/api';
import { syncReviews } from '@/lib/offline';
import type { ScreenProps } from '@/lib/contracts';
import { readExplanationDepth, saveExplanationDepth } from '@/lib/learning-preferences';
import { Slider } from '@/components/ui-choice';
export default function LearningSettings({ data, back, refresh, toast }: ScreenProps) {
  const [depth, setDepth] = useState(() => readExplanationDepth(data.profile.id));
  const [mode, setMode] = useState(data.profile.srsMode ?? 'FIXED');
  const [retention, setRetention] = useState(data.profile.desiredRetention ?? 0.9);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      await syncReviews(data.profile.id, (item) => api('/cards/review', item));
      await api('/profile', { srsMode: mode, desiredRetention: retention }, 'PATCH');
      const savedDepth = saveExplanationDepth(data.profile.id, depth);
      await refresh();
      toast(
        savedDepth
          ? '학습 설정을 저장했어요'
          : '복습 방식은 저장했지만 이 기기의 해설 설정은 저장하지 못했어요',
      );
      back('/profile');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ScreenHeader title="나에게 맞는 복습" back={() => back('/profile')} />
      <div className="page-inset pb-8">
        <div className="mt-4 mb-7">
          <span className="eyebrow">복습하는 방식</span>
          <h1 className="page-title mt-2">
            오래 기억하는 방법을
            <br />
            골라 주세요
          </h1>
          <p className="text-sm text-muted mt-3 leading-relaxed">
            개념·비교·관계·이미지 가림 카드에 모두 적용해요. 다음 복습에서 평가한 카드부터 새
            간격으로 예약해요.
          </p>
        </div>
        <div className="space-y-3">
          {[
            {
              id: 'FIXED',
              title: '일정한 간격으로',
              description: '다시 10분 · 어려움 1일 · 보통 3일 · 쉬움 7일',
              icon: Repeat2,
            },
            {
              id: 'FSRS',
              title: '기억에 맞춰서',
              description: '카드마다 쌓인 복습 기록으로 다음에 볼 때를 정해요',
              icon: Brain,
            },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setMode(item.id as 'FIXED' | 'FSRS')}
              aria-pressed={mode === item.id}
              className={`w-full rounded-[22px] p-5 text-left ${mode === item.id ? 'bg-ink text-white' : 'bg-surface'}`}
            >
              <div className="flex items-center gap-3">
                <item.icon size={22} />
                <strong className="text-base flex-1">{item.title}</strong>
                {mode === item.id && <Check size={20} />}
              </div>
              <p
                className={`mt-3 text-[13px] leading-relaxed ${mode === item.id ? 'text-white/70' : 'text-muted'}`}
              >
                {item.description}
              </p>
            </button>
          ))}
        </div>
        {mode === 'FSRS' && (
          <section className="mt-7">
            <h2 className="font-bold text-lg">나에게 맞는 복습량</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              부담과 기억 사이의 균형을 골라 주세요.
            </p>
            <div className="mt-4 space-y-2">
              {[
                { value: 0.85, title: '가볍게', detail: '복습 간격을 넉넉히 두고 부담을 줄여요' },
                { value: 0.9, title: '균형 있게', detail: '기억과 복습량을 함께 고려해요 · 추천' },
                {
                  value: 0.95,
                  title: '꼼꼼하게',
                  detail: '잊기 전에 더 자주 봐요 · 복습량이 늘어요',
                },
              ].map((option) => (
                <button
                  key={option.value}
                  onClick={() => setRetention(option.value)}
                  aria-pressed={retention === option.value}
                  className={`flex min-h-20 w-full items-center gap-3 rounded-2xl px-4 py-3 text-left ${retention === option.value ? 'bg-ink text-white' : 'bg-surface'}`}
                >
                  <span className="flex-1">
                    <strong className="block text-sm">{option.title}</strong>
                    <span
                      className={`mt-1 block text-xs leading-relaxed ${retention === option.value ? 'text-white/75' : 'text-muted'}`}
                    >
                      {option.detail}
                    </span>
                  </span>
                  {retention === option.value && <Check size={18} />}
                </button>
              ))}
            </div>
            <details className="mt-4 rounded-2xl bg-surface p-4">
              <summary className="min-h-6 cursor-pointer text-sm font-semibold">
                세부 설정 · 목표 기억률 {Math.round(retention * 100)}%
              </summary>
              <p className="my-4 text-xs leading-relaxed text-muted">
                예정된 복습 때 기억할 확률의 목표예요. 현재 점수나 보장된 기억률은 아니에요.
                높일수록 더 자주 복습하게 돼요.
              </p>
              <Slider
                label="목표 기억률"
                name="retention"
                min={80}
                max={97}
                step={1}
                value={Math.round(retention * 100)}
                format={(v) => `${v}%`}
                onChange={(v) => setRetention(v / 100)}
              />
              <div className="flex justify-between text-[11px] text-muted mt-1">
                <span>복습 부담이 가벼워요</span>
                <span>더 자주 복습해요</span>
              </div>
            </details>
            <p className="mt-4 text-xs leading-relaxed text-muted">
              기억에 맞추는 방식은 1일·3일·7일을 일정 비율로 줄이는 설정이 아니에요. 처음 배우거나
              잊은 카드는 짧게 다시 보고, 익숙해지면 간격이 길어져요. 평가 버튼에서 실제 다음 복습
              시간을 확인할 수 있어요.
            </p>
            <div className="panel mt-5 !p-4 flex gap-3">
              <Info size={17} className="mt-1 text-muted" />
              <p className="text-xs leading-relaxed text-muted">
                ‘암기완료’는 잘 기억한다는 표시예요. 맞춤 복습에서는 완료한 카드도 잊기 전에 다시
                보여드려요. 기존 카드는 다음 평가부터 맞춤 기억 기록을 쌓아요.
              </p>
            </div>
          </section>
        )}
        <section className="mt-8">
          <h2 className="mb-2 text-base font-bold">문제 해설 길이</h2>
          <p className="mb-3 text-sm leading-relaxed text-muted">
            문제풀이에서 처음 펼칠 해설 길이예요. 플래시카드의 답에는 적용하지 않아요. 이 기기에
            저장해요.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(['SHORT', 'FULL'] as const).map((value) => (
              <button
                key={value}
                className="choice-row"
                aria-pressed={depth === value}
                onClick={() => setDepth(value)}
              >
                <span>{value === 'SHORT' ? '핵심만' : '자세히'}</span>
                <span className="choice-indicator">{depth === value && <Check size={14} />}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="mt-8">
          <h2 className="font-bold text-base mb-3">솔직한 평가가 좋은 간격을 만들어요</h2>
          {[
            ['다시', '기억이 나지 않았어요'],
            ['어려움', '기억했지만 꽤 어려웠어요'],
            ['보통', '생각해서 떠올렸어요'],
            ['쉬움', '바로 떠올렸어요'],
          ].map(([rating, description]) => (
            <div key={rating} className="flex py-3 gap-4 text-sm">
              <span className="w-12 font-semibold">{rating}</span>
              <span className="text-muted">{description}</span>
            </div>
          ))}
        </section>
        {error && (
          <p role="alert" className="error-banner mt-5">
            {error}
          </p>
        )}
        <Button className="w-full mt-8" disabled={busy} onClick={save}>
          {busy ? '저장하고 있어요' : '복습 방식 저장'}
          <ChevronRight size={18} />
        </Button>
        <p className="text-[11px] text-center text-muted mt-4">기존 학습 기록은 그대로 보관해요</p>
      </div>
    </>
  );
}
