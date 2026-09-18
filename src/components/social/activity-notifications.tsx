'use client';
import { useState } from 'react';
import { Bell, BookOpen, ChevronRight, MessageCircle } from '@/components/icons';
import { Button, EmptyState, ScreenHeader } from '@/components/ui';
import { api } from '@/lib/api';
import type { ScreenProps } from '@/lib/contracts';
import { relativeTime } from './helpers';
import styles from './activity-notifications.module.css';

export default function ActivityNotifications({
  data,
  navigate,
  back,
  refresh,
  toast,
}: ScreenProps) {
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState('');
  const parent = data.profile.role === 'PARENT';
  const unread = data.notifications.filter((n) => !n.read).length;
  const visible = data.notifications.filter(
    (n) =>
      filter === 'all' ||
      (filter === 'learning'
        ? n.kind === 'CHILD_LEARNING'
        : ['FIRST_ANSWER', 'MORE_ANSWERS'].includes(n.kind || '')),
  );
  async function open(n: (typeof data.notifications)[number]) {
    if (busy) return;
    setBusy(n.id);
    try {
      if (n.kind === 'CHILD_LEARNING') {
        const childId = new URL(n.href, 'https://memoryz.invalid').searchParams.get('child');
        if (!childId) throw new Error('자녀 연결을 다시 확인해 주세요.');
        // Selection validates the current link again; an old notice cannot grant access.
        await api('/children/select', { childId });
      }
      await api('/notifications', { read: true, id: n.id }, 'PATCH');
      await refresh();
      navigate(n.kind === 'CHILD_LEARNING' ? '/parent' : n.href);
    } catch (e) {
      toast((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <ScreenHeader
        title="활동과 소식"
        back={() => back('/profile')}
        action={
          unread > 0 ? (
            <Button
              size="compact"
              variant="ghost"
              disabled={!!busy}
              onClick={async () => {
                setBusy('all');
                try {
                  await api('/notifications', { read: true }, 'PATCH');
                  await refresh();
                  toast('모두 읽음으로 표시했어요');
                } catch (e) {
                  toast((e as Error).message);
                } finally {
                  setBusy('');
                }
              }}
            >
              모두 읽음
            </Button>
          ) : undefined
        }
      />
      <div className="page-inset pb-8">
        {parent && (
          <div className={styles.filters} aria-label="알림 종류">
            {[
              ['all', '전체'],
              ['learning', '자녀 학습'],
              ['comments', '내 글의 댓글'],
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={filter === value ? styles.selected : ''}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {visible.length > 0 && (
          <p className={styles.caption}>
            {filter === 'all'
              ? '최근 소식'
              : filter === 'learning'
                ? '자녀가 공유한 학습 소식'
                : '내 글에 달린 댓글'}
          </p>
        )}
        <div className={styles.list}>
          {visible.map((n) => {
            const learning = n.kind === 'CHILD_LEARNING';
            const comment = ['FIRST_ANSWER', 'MORE_ANSWERS'].includes(n.kind || '');
            const Icon = learning ? BookOpen : comment ? MessageCircle : Bell;
            return (
              <button
                type="button"
                key={n.id}
                disabled={!!busy}
                onClick={() => void open(n)}
                className={`${styles.row} ${!n.read ? styles.unread : ''}`}
                aria-label={`${!n.read ? '읽지 않음, ' : ''}${n.title}`}
              >
                <span className={styles.icon}>
                  <Icon size={20} />
                </span>
                <span className={styles.content}>
                  <span className={styles.meta}>
                    {learning ? '자녀 학습' : comment ? '내 글의 댓글' : '새 소식'}
                    <time dateTime={n.createdAt}>{relativeTime(n.createdAt)}</time>
                  </span>
                  <strong>{n.title}</strong>
                  <span className={styles.body}>{n.body}</span>
                  <span className={styles.destination}>
                    {busy === n.id
                      ? '확인 중…'
                      : learning
                        ? '자녀 현황 보기'
                        : comment
                          ? '댓글 보기'
                          : '자세히 보기'}
                    <ChevronRight size={13} />
                  </span>
                </span>
                {!n.read && <span className={styles.dot} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        {!visible.length && (
          <EmptyState
            title={
              filter === 'comments'
                ? '아직 새 댓글이 없어요'
                : filter === 'learning'
                  ? '아직 자녀의 학습 소식이 없어요'
                  : '새로운 소식이 아직 없어요'
            }
            description={
              parent
                ? filter === 'comments'
                  ? '내가 쓴 글에 댓글이 달리면 여기에 알려드려요.'
                  : '연결된 자녀가 학습 활동을 공개하면, 문제 풀이와 카드 복습을 마친 날에 알려드려요.'
                : '댓글과 새로운 활동이 생기면 여기에 알려드려요.'
            }
          />
        )}
      </div>
    </>
  );
}
