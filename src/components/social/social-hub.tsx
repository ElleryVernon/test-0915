'use client';
import { useEffect, useState } from 'react';
import { Search } from '@/components/icons';
import { api } from '@/lib/api';
import type { ScreenProps } from '@/lib/contracts';
import { Button, EmptyState, IconButton, Sheet } from '@/components/ui';
import { communityProfileHref } from './community-profile';
import { markFollowed } from '@/lib/community-nudges';
import { CommunityMessages, DirectConversation } from './community-messages';
import { useLiveRefresh, useScreenRefresh } from '../refresh';
export interface SocialUser {
  id: string;
  nickname: string;
}
export interface SocialData {
  followers: SocialUser[];
  following: SocialUser[];
  users: SocialUser[];
  blocked: SocialUser[];
  counts: { posts: number; comments: number; followers: number; following: number };
}
export default function SocialHub({
  refresh,
  back,
  path,
  data,
  toast,
  navigate,
  initialUser,
  initialTab = 'followers',
  onCloseConversation,
}: ScreenProps & {
  initialUser?: SocialUser;
  onCloseConversation?: () => void;
  initialTab?: 'followers' | 'following' | 'messages' | 'blocked';
}) {
  const [social, setSocial] = useState<SocialData | null>(null);
  const [tab, setTab] = useState(
    data.profile.role === 'PARENT' && initialTab !== 'blocked' ? 'messages' : initialTab,
  );
  const [user, setUser] = useState<SocialUser | null>(initialUser ?? null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [unfollow, setUnfollow] = useState<SocialUser | null>(null);
  const [listReload, setListReload] = useState(0);
  const refreshList = useLiveRefresh(
    async (signal) => {
      const next = await api<SocialData>('/social', undefined, 'GET', { signal });
      if (!signal?.aborted) {
        setSocial(next);
        setError('');
      }
    },
    { interval: 60_000, enabled: !user && tab !== 'messages', resource: data.profile.id },
  );
  useScreenRefresh(refreshList, !user && tab !== 'messages');
  useEffect(() => {
    let active = true;
    setError('');
    api<SocialData>('/social')
      .then((s) => {
        if (active) setSocial(s);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [listReload]);
  async function follow(
    target: SocialUser,
    following = !social?.following.some((u) => u.id === target.id),
  ) {
    if (busy) return;
    setBusy(true);
    try {
      await api('/follow', { userId: target.id, following });
      markFollowed(target.id, following);
      setUnfollow(null);
      setSocial(await api<SocialData>('/social'));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function unblock(target: SocialUser) {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/blocks/${target.id}`, {}, 'DELETE');
      setSocial(await api<SocialData>('/social'));
      toast('차단을 해제했어요');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const screenProps = { data, toast, navigate, refresh, back, path };
  if (user)
    return (
      <DirectConversation
        {...screenProps}
        peer={user}
        onBack={onCloseConversation ?? (() => setUser(null))}
      />
    );
  if (tab === 'messages') return <CommunityMessages {...screenProps} />;
  const users =
    social?.[tab]?.filter((u) =>
      u.nickname.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ) ?? [];
  return (
    <div>
      <div className="flex gap-1 mb-5 rounded-xl bg-surface p-1">
        {(
          [
            ['followers', '팔로워'],
            ['following', '팔로잉'],
            ['messages', '쪽지'],
            ['blocked', '차단'],
          ] as const
        )
          .filter(
            ([value]) =>
              data.profile.role !== 'PARENT' || value === 'messages' || value === 'blocked',
          )
          .map(([value, label]) => (
            <button
              key={value}
              aria-pressed={tab === value}
              onClick={() => {
                setTab(value);
                setQuery('');
              }}
              className={`flex-1 min-h-11 py-2 rounded-lg text-[13px] font-semibold ${tab === value ? 'bg-white shadow-sm' : 'text-subtle'}`}
            >
              {label}
            </button>
          ))}
      </div>
      {tab !== 'blocked' && (
        <div className="relative mb-3">
          <Search size={18} className="absolute left-3.5 top-3.5 text-subtle" />
          <input
            aria-label="목록에서 닉네임 검색"
            className="field !pl-10"
            placeholder="이 목록에서 닉네임 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger mb-3">
          {error}
        </p>
      )}
      {!social && error ? (
        <Button variant="secondary" className="w-full" onClick={() => setListReload((v) => v + 1)}>
          목록 다시 불러오기
        </Button>
      ) : !social ? (
        <p className="py-10 text-center text-sm text-subtle">목록을 가져오고 있어요…</p>
      ) : !users.length ? (
        <EmptyState
          title={
            query
              ? '검색 결과가 없어요'
              : tab === 'blocked'
                ? '차단한 사용자가 없어요'
                : '아직 목록이 비어 있어요'
          }
          description={
            query
              ? '이 목록에 있는 닉네임으로 검색해 주세요.'
              : tab === 'blocked'
                ? '차단한 사용자는 여기서 관리할 수 있어요.'
                : '도움이 된 답변이나 카드에서 팔로우하면 여기 모여요.'
          }
        />
      ) : (
        users.map((u) => (
          <div key={u.id} className="flex gap-3 py-3 items-center">
            <span className="size-10 rounded-full bg-surface flex items-center justify-center font-semibold text-sm">
              {u.nickname.slice(0, 1)}
            </span>
            <button
              disabled={tab === 'blocked'}
              className="flex-1 min-w-0 min-h-11 text-left text-[15px] font-semibold truncate"
              onClick={() =>
                data.profile.role === 'PARENT' ? setUser(u) : navigate(communityProfileHref(u.id))
              }
            >
              {u.nickname}
            </button>
            {tab === 'blocked' ? (
              <Button
                size="compact"
                variant="secondary"
                className="!px-3 !text-xs"
                disabled={busy}
                onClick={() => unblock(u)}
              >
                해제
              </Button>
            ) : (
              <Button
                variant="outline"
                size="compact"
                disabled={busy}
                onClick={() =>
                  social.following.some((f) => f.id === u.id)
                    ? setUnfollow(u)
                    : void follow(u, true)
                }
              >
                {social.following.some((f) => f.id === u.id) ? '팔로잉' : '팔로우'}
              </Button>
            )}
          </div>
        ))
      )}
      <Sheet
        open={!!unfollow}
        onClose={() => {
          if (!busy) setUnfollow(null);
        }}
        title="팔로우를 그만할까요?"
        description="이 사람의 새 글과 공개 카드가 팔로잉에 모이지 않아요. 이미 담은 카드는 유지돼요."
      >
        <div className="layout-group">
          <Button variant="outline" disabled={busy} onClick={() => setUnfollow(null)}>
            계속 받아보기
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              if (unfollow) void follow(unfollow, false);
            }}
          >
            {busy ? '변경 중…' : '팔로우 해제'}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
