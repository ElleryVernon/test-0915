'use client';
import { useState } from 'react';
import type { Card, ScreenProps } from '@/lib/contracts';
import { Button, Sheet } from '@/components/ui';
import { api } from '@/lib/api';
import { BusyText, ErrorNote, useAction } from './shared';
export function EditCard({
  card,
  props,
  onClose,
}: {
  card: Card;
  props: ScreenProps;
  onClose: () => void;
}) {
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  const action = useAction();
  return (
    <Sheet open onClose={onClose} title="카드 내용 수정">
      <div className="space-y-4">
        <label className="block text-sm font-semibold">
          앞면
          <textarea
            className="field mt-2 min-h-28"
            value={front}
            onChange={(e) => setFront(e.target.value)}
            maxLength={2000}
          />
        </label>
        <label className="block text-sm font-semibold">
          뒷면
          <textarea
            className="field mt-2 min-h-36"
            value={back}
            onChange={(e) => setBack(e.target.value)}
            maxLength={4000}
          />
        </label>
        <ErrorNote error={action.error} />
        <Button
          className="w-full"
          disabled={!front.trim() || !back.trim() || action.busy}
          onClick={() =>
            action.run(async () => {
              await api(`/cards/${card.id}`, { front: front.trim(), back: back.trim() }, 'PATCH');
              await props.refresh();
              onClose();
              props.toast('카드를 수정했어요');
            })
          }
        >
          {action.busy ? <BusyText>저장 중</BusyText> : '변경 사항 저장'}
        </Button>
      </div>
    </Sheet>
  );
}
