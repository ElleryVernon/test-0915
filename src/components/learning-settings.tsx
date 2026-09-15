'use client';
import { useState } from 'react';
import { Brain, Check, ChevronRight, Repeat2, Info } from '@/components/icons';
import { Button, ScreenHeader } from './ui';
import { api } from '@/lib/api';
import { syncReviews } from '@/lib/offline';
import type { ScreenProps } from '@/lib/contracts';
export default function LearningSettings({ data, navigate, refresh, toast }: ScreenProps) {
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
      await refresh();
      toast('다음 복습부터 새 방식으로 기억해요');
      navigate('/flashcards');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ScreenHeader title="나에게 맞는 복습" back={() => navigate('/profile')} />
      <div className="page-inset pb-8">
        <div className="mt-4 mb-7">
          <span className="eyebrow">복습하는 방식</span>
          <h1 className="page-title mt-2">
            오래 기억하는 방법을
            <br />
            골라 주세요
          </h1>
          <p className="text-sm text-muted mt-3 leading-relaxed">
            같은 네 가지 평가 버튼으로,
            <br />
            나에게 맞게 복습 간격을 정해요.
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
              description: '내가 얼마나 잘 기억하는지에 따라 간격을 조절해요',
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
              {item.id === 'FSRS' && (
                <span className="inline-block mt-3 text-[10px] font-semibold uppercase tracking-wider opacity-60">
                  FSRS · Anki가 사용하는 기억 모델
                </span>
              )}
            </button>
          ))}
        </div>
        {mode === 'FSRS' && (
          <section className="mt-7">
            <div className="flex justify-between items-center">
              <h2 className="font-bold text-lg">얼마나 확실히 기억할까요?</h2>
              <strong className="text-2xl">
                {Math.round(retention * 100)}
                <span className="text-sm">%</span>
              </strong>
            </div>
            <input
              className="w-full mt-6 accent-[#f97316]"
              aria-label="목표 기억률"
              type="range"
              min="80"
              max="97"
              step="1"
              value={Math.round(retention * 100)}
              onChange={(e) => setRetention(Number(e.target.value) / 100)}
            />
            <div className="flex justify-between text-[11px] text-muted mt-1">
              <span>복습 부담이 가벼워요</span>
              <span>더 자주 복습해요</span>
            </div>
            <p className="mt-5 text-[13px] text-muted leading-relaxed">
              처음에는 90%를 권해요. 예정된 복습 시 기억할 확률의 목표이며, 높게 설정할수록 복습할
              양이 늘어나요.
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
          <h2 className="font-bold text-base mb-3">솔직한 평가가 좋은 간격을 만들어요</h2>
          {[
            ['다시', '기억이 나지 않았어요'],
            ['어려움', '기억했지만 꽤 어려웠어요'],
            ['보통', '생각해서 떠올렸어요'],
            ['쉬움', '바로 떠올렸어요'],
          ].map(([rating, description]) => (
            <div key={rating} className="flex py-3 gap-4 text-sm border-b border-surface">
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
          {busy ? '저장하고 있어요' : '이 방식으로 복습하기'}
          <ChevronRight size={18} />
        </Button>
        <p className="text-[11px] text-center text-muted mt-4">기존 학습 기록은 그대로 보관해요</p>
      </div>
    </>
  );
}
