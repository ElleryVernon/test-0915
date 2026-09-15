'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, MessageCircle, Search, Send } from '@/components/icons';
import { api } from '@/lib/api';
import type { ScreenProps } from '@/lib/contracts';
import { Button, EmptyState, IconButton } from '@/components/ui';
import { relativeTime } from './helpers';
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
  initialUser,
  initialTab = 'followers',
}: ScreenProps & {
  initialUser?: SocialUser;
  initialTab?: 'followers' | 'following' | 'messages' | 'blocked';
}) {
  const [social, setSocial] = useState<SocialData | null>(null);
  const [tab, setTab] = useState(initialTab);
  const [user, setUser] = useState<SocialUser | null>(initialUser ?? null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [query, setQuery] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
  async function follow(target: SocialUser) {
    setBusy(true);
    try {
      await api('/follow', { userId: target.id });
      setSocial(await api<SocialData>('/social'));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function unblock(target: SocialUser) {
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
    if (!user || !body.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api('/messages', { userId: user.id, body: body.trim() });
      setBody('');
      setMessages(await api<DirectMessage[]>(`/messages?userId=${encodeURIComponent(user.id)}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (user)
    return (
      <div className="flex flex-col">
        <div className="flex gap-2 items-center mb-4">
          <IconButton label="친구 목록으로" onClick={() => setUser(null)}>
            <ArrowLeft size={20} />
          </IconButton>
          <span className="font-bold">{user.nickname}</span>
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
        <form onSubmit={send} className="flex gap-2 items-end border-t border-surface pt-4">
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
            className="bg-primary text-white size-12 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
          >
            <Send size={19} />
          </button>
        </form>
      </div>
    );
  const users =
    (query ? social?.users : tab === 'messages' ? social?.users : social?.[tab])?.filter((u) =>
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
        ).map(([value, label]) => (
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
            aria-label="닉네임 검색"
            className="field !pl-10"
            placeholder="닉네임으로 친구 찾기"
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
          친구 목록 다시 불러오기
        </Button>
      ) : !social ? (
        <p className="py-10 text-center text-sm text-subtle">목록을 가져오고 있어요…</p>
      ) : !users.length ? (
        <EmptyState
          title={tab === 'blocked' ? '차단한 사용자가 없어요' : '아직 목록이 비어 있어요'}
          description={
            tab === 'blocked'
              ? '차단한 사용자는 여기서 관리할 수 있어요.'
              : '닉네임으로 친구를 찾아 연결해 보세요.'
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
              onClick={() => setUser(u)}
            >
              {u.nickname}
            </button>
            {tab === 'blocked' ? (
              <Button
                variant="secondary"
                className="!min-h-9 !px-3 !text-xs"
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
                variant={social.following.some((f) => f.id === u.id) ? 'secondary' : 'primary'}
                className="!min-h-9 !px-3 !text-xs"
                disabled={busy}
                onClick={() => follow(u)}
              >
                {social.following.some((f) => f.id === u.id)
                  ? '팔로잉'
                  : social.followers.some((f) => f.id === u.id)
                    ? '맞팔로우'
                    : '팔로우'}
              </Button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
