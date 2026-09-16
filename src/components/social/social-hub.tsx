'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, MessageCircle, Search, Send } from '@/components/icons';
import { api } from '@/lib/api';
import type { ScreenProps } from '@/lib/contracts';
import { Button, EmptyState, IconButton, Sheet } from '@/components/ui';
import { useJourneyState } from '../journey';
import { relativeTime } from './helpers';
import { communityProfileHref } from './community-profile';
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
interface DirectMessage {
  id: string;
  senderId: string;
  recipientId: string;
  body: string;
  createdAt: string;
}
export default function SocialHub({
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
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useJourneyState<Record<string, string>>('messages.drafts', {});
  const body = user ? (drafts[user.id] ?? '') : '';
  const setBody = (value: string) => {
    if (user) setDrafts((previous) => ({ ...previous, [user.id]: value }));
  };
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [unfollow, setUnfollow] = useState<SocialUser | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [listReload, setListReload] = useState(0);
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
  useEffect(() => {
    let active = true;
    if (!user) return;
    setLoadingMessages(true);
    setMessages([]);
    setError('');
    api<DirectMessage[]>(`/messages?userId=${encodeURIComponent(user.id)}`)
      .then((m) => {
        if (active) setMessages(m);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoadingMessages(false);
      });
    return () => {
      active = false;
    };
  }, [user]);
  async function follow(
    target: SocialUser,
    following = !social?.following.some((u) => u.id === target.id),
  ) {
    if (busy) return;
    setBusy(true);
    try {
      await api('/follow', { userId: target.id, following });
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
  async function send(e: FormEvent) {
    e.preventDefault();
    if (busy || !user || !body.trim()) return;
    setBusy(true);
    setError('');
    let sent = false;
    try {
      await api('/messages', { userId: user.id, body: body.trim() });
      sent = true;
      setBody('');
      setMessages(await api<DirectMessage[]>(`/messages?userId=${encodeURIComponent(user.id)}`));
    } catch (e) {
      setError(sent ? '쪽지는 보냈어요. 대화 목록을 새로고침해 주세요.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (user)
    return (
      <div className="flex flex-col">
        <div className="flex gap-2 items-center mb-4">
          <IconButton
            label={onCloseConversation ? '이전 화면으로' : '목록으로'}
            onClick={onCloseConversation ?? (() => setUser(null))}
          >
            <ArrowLeft size={20} />
          </IconButton>
          {data.profile.role === 'PARENT' ? (
            <span className="font-bold">{user.nickname}</span>
          ) : (
            <button
              className="min-h-11 min-w-0 truncate font-bold underline underline-offset-4"
              aria-label={`${user.nickname}님 프로필 보기`}
              onClick={() => navigate(communityProfileHref(user.id))}
            >
              {user.nickname}
            </button>
          )}
          <button
            className="ml-auto min-h-11 px-1 text-sm font-semibold text-muted"
            onClick={async () => {
              try {
                setMessages(
                  await api<DirectMessage[]>(`/messages?userId=${encodeURIComponent(user.id)}`),
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            새로고침
          </button>
        </div>
        <div
          className="min-h-[200px] max-h-[380px] overflow-y-auto flex flex-col gap-3 pb-4"
          aria-live="polite"
        >
          {loadingMessages ? (
            <p className="text-sm text-subtle text-center py-10">쪽지를 가져오고 있어요…</p>
          ) : !messages.length && error ? null : !messages.length ? (
            <EmptyState
              title="먼저 인사해 볼까요?"
              description="같은 공간에서 공부하는 친구에게 쪽지를 보내요."
            />
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] ${m.senderId === data.profile.id ? 'self-end' : 'self-start'}`}
              >
                <p
                  className={`px-4 py-3 rounded-[18px] text-[15px] whitespace-pre-wrap break-words leading-6 ${m.senderId === data.profile.id ? 'bg-ink text-white rounded-br-sm' : 'bg-surface rounded-bl-sm'}`}
                >
                  {m.body}
                </p>
                <p className="text-[10px] text-subtle mt-1 text-right">
                  {relativeTime(m.createdAt)}
                </p>
              </div>
            ))
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger mb-3">
            {error}
          </p>
        )}
        <form
          onSubmit={send}
          noValidate
          className="flex gap-2 items-end border-t border-surface pt-4"
        >
          <textarea
            aria-label="쪽지 내용"
            placeholder="메시지를 입력하세요"
            required
            maxLength={2000}
            rows={2}
            className="field resize-none flex-1"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button
            aria-label="쪽지 보내기"
            type="submit"
            disabled={busy || !body.trim()}
            className="bg-ink text-white size-12 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
          >
            <Send size={19} />
          </button>
        </form>
      </div>
    );
  const messageContacts = [
    ...new Map(
      [...(social?.following ?? []), ...(social?.followers ?? [])].map((u) => [u.id, u]),
    ).values(),
  ];
  const users =
    (tab === 'messages' ? messageContacts : social?.[tab])?.filter((u) =>
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
                tab === 'messages' || data.profile.role === 'PARENT'
                  ? setUser(u)
                  : navigate(communityProfileHref(u.id))
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
            ) : tab === 'messages' ? (
              <IconButton label={`${u.nickname}님에게 쪽지`} onClick={() => setUser(u)}>
                <MessageCircle size={20} />
              </IconButton>
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
