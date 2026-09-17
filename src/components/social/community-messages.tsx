'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Check,
  Clock,
  Copy,
  Undo2,
  Trash2,
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  Heart,
  MoreHorizontal,
  PencilLine,
  Plus,
  Search,
  Send,
  X,
} from '@/components/icons';
import { Button, EmptyState, IconButton, Sheet } from '@/components/ui';
import * as Dialog from '@radix-ui/react-dialog';
import { api } from '@/lib/api';
import type { ScreenProps } from '@/lib/contracts';
import type { CommunityBlock } from '@/lib/community-types';
import {
  receiptAnchors,
  conversationStatus,
  firstUnreadMessage,
  groupMessages,
  makeMessageAttempt,
  mergeMessages,
  messageAttemptPayload,
  messageDraftKey,
  messagePreview,
  parseMessageDraft,
  reconcileMessageDraft,
  restoreMessageDraft,
  visibleReadTarget,
  type Conversation,
  type DirectMessage,
  type MessageAttempt,
  type MessageDraft,
} from '@/lib/direct-messages';
import { useJourneyState, useJourneyLayer } from '../journey';
import { useLiveRefresh, useScreenRefresh } from '../refresh';
import { BlockDraftList, BlockPicker, BlockView } from './community-blocks';
import { communityProfileHref } from './community-profile';
import type { SocialData, SocialUser } from './social-hub';
import { relativeTime } from './helpers';
import styles from './community-messages.module.css';

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '잠시 후 다시 시도해 주세요.';
const inboxPathFor = (props: ScreenProps) =>
  `${props.data.profile.role === 'PARENT' ? '/parent-boards' : '/community'}?space=messages`;
const timeLabel = (timestamp: string) =>
  new Intl.DateTimeFormat('ko', {
    timeZone: 'Asia/Seoul',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
const dateLabel = (timestamp: string) =>
  new Intl.DateTimeFormat('ko', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(timestamp));

function Avatar({ nickname, small = false }: { nickname: string; small?: boolean }) {
  return (
    <span aria-hidden="true" className={`${styles.avatar} ${small ? styles.smallAvatar : ''}`}>
      {Array.from(nickname)[0] || '?'}
    </span>
  );
}

/** A compact contextual surface anchored to the pressed message, with modal focus/escape behavior. */
function MessagePopover({
  anchor,
  onClose,
  children,
  title,
  restoreFocus,
}: {
  restoreFocus: () => boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  title: string;
}) {
  const close = useJourneyLayer(true, onClose);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const fit = () => {
      const node = surface;
      if (!node) return;
      if (!anchor?.isConnected) {
        onClose();
        return;
      }
      const rect = anchor.getBoundingClientRect(),
        box = node.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0,
        bottom = top + (viewport?.height ?? window.innerHeight);
      const app = document.querySelector('[data-dm-thread]')?.getBoundingClientRect();
      const minX = Math.max(8, (app?.left ?? 0) + 12);
      const maxX = Math.min(window.innerWidth - 12, app?.right ?? window.innerWidth) - box.width;
      const below = rect.bottom + 8;
      const y = below + box.height < bottom - 12 ? below : rect.top - box.height - 8;
      setPosition({
        left: Math.max(minX, Math.min(rect.left, maxX)),
        top: Math.max(top + 12, Math.min(y, bottom - box.height - 12)),
        visibility: 'visible',
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (surface) observer.observe(surface);
    window.visualViewport?.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener('resize', fit);
    };
  }, [anchor, surface]);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.contextBackdrop} />
        <Dialog.Content
          ref={setSurface}
          className={styles.contextMenu}
          style={position}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!restoreFocus() && anchor?.isConnected) anchor.focus({ preventScroll: true });
          }}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CommunityMessages({
  renderHeader,
  ...props
}: ScreenProps & { renderHeader?: (onSearch: () => void) => ReactNode }) {
  const inboxPath = inboxPathFor(props);
  const params = new URLSearchParams(props.path.split('?')[1]);
  const peer = params.get('peer');
  const choosing = params.get('new') === '1';
  const [items, setItems] = useState<Conversation[]>([]);
  const [social, setSocial] = useState<SocialData | null>(null);
  const [peerUser, setPeerUser] = useState<SocialUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useJourneyState('inbox.query', '');
  const [unreadOnly, setUnreadOnly] = useJourneyState('inbox.unreadOnly', false);
  const searchInput = useRef<HTMLInputElement>(null);
  const inboxRead = useRef<(signal?: AbortSignal) => Promise<void>>(async () => {});
  const refreshInbox = useLiveRefresh((signal) => inboxRead.current(signal), {
    interval: 8000,
    enabled: !peer,
    resource: `${props.data.profile.id}:${choosing}:${retry}`,
  });
  useScreenRefresh(refreshInbox, !peer);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    setLoading(true);
    setPeerUser(null);
    setError('');
    const load = async (initial = false, signal?: AbortSignal) => {
      if (!active || inFlight || (!initial && document.visibilityState !== 'visible')) return;
      inFlight = true;
      try {
        if (peer) {
          const person = await api<SocialUser>(
            `/messages?peer=1&userId=${encodeURIComponent(peer)}`,
            undefined,
            'GET',
            { signal },
          );
          if (active) setPeerUser(person);
        } else {
          const [list, people] = await Promise.all([
            api<Conversation[]>('/messages?inbox=1', undefined, 'GET', { signal }),
            choosing
              ? api<SocialData>('/social', undefined, 'GET', { signal })
              : Promise.resolve(null),
          ]);
          if (active && !signal?.aborted) {
            setItems(list);
            if (people) setSocial(people);
          }
        }
        if (active) setError('');
      } catch (e) {
        if (active && !signal?.aborted) setError(errorText(e));
        throw e;
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };
    inboxRead.current = (signal) => load(false, signal);
    const initial = new AbortController();
    void load(true, initial.signal).catch(() => {});
    return () => {
      active = false;
      initial.abort();
    };
  }, [peer, choosing, retry, props.data.profile.id]);
  if (peer) {
    if (peerUser)
      return (
        <DirectConversation
          key={`${props.data.profile.id}:${peer}`}
          {...props}
          peer={peerUser}
          onBack={() => props.back(inboxPath)}
        />
      );
    return (
      <section className={styles.thread} aria-label="쪽지 대화">
        <header className={styles.threadHeader}>
          <IconButton label="쪽지 목록으로" onClick={() => props.back(inboxPath)}>
            <ArrowLeft size={22} />
          </IconButton>
          <h1>쪽지</h1>
        </header>
        <div className={styles.threadEmpty}>
          {loading ? (
            <p role="status">대화를 불러오고 있어요…</p>
          ) : (
            <EmptyState
              title="대화를 열 수 없어요"
              description={error || '상대가 탈퇴했거나 대화할 수 없는 계정이에요.'}
              action={
                <Button variant="secondary" onClick={() => setRetry((v) => v + 1)}>
                  다시 불러오기
                </Button>
              }
            />
          )}
        </div>
      </section>
    );
  }
  const contacts = [
    ...new Map(
      [...(social?.following ?? []), ...(social?.followers ?? []), ...items]
        .filter((user) => user.id !== props.data.profile.id)
        .map((user) => [user.id, user]),
    ).values(),
  ];
  const candidates = (choosing ? contacts : items).filter(
    (user) =>
      user.nickname.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
      (choosing || !unreadOnly || ('unreadCount' in user && Number(user.unreadCount) > 0)),
  );
  return (
    <>
      {renderHeader?.(() => searchInput.current?.focus())}
      <section className={styles.inbox} aria-label={choosing ? '새 쪽지' : '쪽지함'}>
        <div className={styles.inboxHeading}>
          <h1>{choosing ? '새 쪽지' : '쪽지함'}</h1>
          {choosing ? (
            <button
              className={styles.textButton}
              onClick={() => props.navigate(inboxPath, { replace: true })}
            >
              취소
            </button>
          ) : (
            <IconButton label="새 쪽지" onClick={() => props.navigate(`${inboxPath}&new=1`)}>
              <PencilLine size={22} />
            </IconButton>
          )}
        </div>
        <label className={styles.search}>
          <Search size={18} />
          <input
            ref={searchInput}
            type="search"
            aria-label={choosing ? '쪽지 보낼 사람 검색' : '대화 상대 검색'}
            placeholder={choosing ? '팔로우·대화 목록에서 찾기' : '검색'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {!choosing && (
          <div className={styles.inboxFilters} aria-label="쪽지 필터">
            <button aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>
              전체
            </button>
            <button aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>
              안 읽음 {items.filter((item) => item.unreadCount > 0).length || ''}
            </button>
          </div>
        )}
        {choosing && <p className={styles.listHint}>팔로우하거나 대화한 사람</p>}
        {error && (
          <div role="alert" className={styles.inlineError}>
            <p>{error}</p>
            <button className={styles.textButton} onClick={() => setRetry((v) => v + 1)}>
              다시 불러오기
            </button>
          </div>
        )}
        {loading && !items.length ? (
          <p className={styles.loading} role="status">
            쪽지함을 불러오고 있어요…
          </p>
        ) : candidates.length ? (
          <div className={styles.conversations}>
            {candidates.map((user) => {
              const conversation = 'unreadCount' in user ? (user as Conversation) : null;
              const unread = !choosing && (conversation?.unreadCount ?? 0) > 0;
              return (
                <button
                  key={user.id}
                  className={`${styles.conversation} ${unread ? styles.unread : ''}`}
                  onClick={() => props.navigate(`${inboxPath}&peer=${encodeURIComponent(user.id)}`)}
                  aria-label={`${user.nickname}${unread ? `, 읽지 않은 메시지 ${conversation?.unreadCount}개` : ''}`}
                >
                  <Avatar nickname={user.nickname} />
                  <span className={styles.conversationCopy}>
                    <strong>{user.nickname}</strong>
                    <span>
                      {conversation ? (
                        <>
                          {conversation.senderId === props.data.profile.id && !conversation.deleted
                            ? '나: '
                            : ''}
                          {messagePreview(conversation)}
                        </>
                      ) : (
                        '새 대화 시작'
                      )}
                    </span>
                  </span>
                  {!choosing && conversation && (
                    <span className={styles.conversationMeta}>
                      <time dateTime={conversation.createdAt}>
                        {relativeTime(conversation.createdAt)}
                      </time>
                      {unread ? (
                        <span className={styles.unreadBadge}>
                          {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                        </span>
                      ) : (
                        conversationStatus(conversation, props.data.profile.id) && (
                          <span className={styles.inboxReceipt}>
                            {conversationStatus(conversation, props.data.profile.id)}
                          </span>
                        )
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          !error && (
            <EmptyState
              title={
                query
                  ? '검색 결과가 없어요'
                  : choosing
                    ? '아직 연결된 사람이 없어요'
                    : unreadOnly
                      ? '모든 쪽지를 읽었어요'
                      : '아직 주고받은 쪽지가 없어요'
              }
              description={
                query
                  ? '다른 닉네임으로 찾아보세요.'
                  : choosing
                    ? '도움이 된 답변의 프로필에서 쪽지를 시작할 수 있어요.'
                    : unreadOnly
                      ? '새 쪽지가 오면 여기에 모아 보여드려요.'
                      : '친구에게 인사하고 공부하던 문제도 나눠 보세요.'
              }
              action={
                !choosing && !query && !unreadOnly ? (
                  <Button variant="secondary" onClick={() => props.navigate(`${inboxPath}&new=1`)}>
                    첫 쪽지 시작하기
                  </Button>
                ) : undefined
              }
            />
          )
        )}
      </section>
    </>
  );
}

type ScrollIntent =
  | { kind: 'bottom' }
  | { kind: 'older'; height: number; top: number }
  | { kind: 'jump'; id: string }
  | { kind: 'unread'; id: string };
export function DirectConversation({
  peer,
  onBack,
  ...props
}: ScreenProps & { peer: SocialUser; onBack: () => void }) {
  const accountId = props.data.profile.id;
  const storageKey = messageDraftKey(accountId, peer.id);
  const [legacyDrafts, setLegacyDrafts] = useJourneyState<Record<string, string>>(
    'messages.drafts',
    {},
  );
  const [draft, setDraft] = useState<MessageDraft>(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey);
    } catch {
      /* Older history-entry drafts also work when storage is unavailable. */
    }
    return restoreMessageDraft(raw, peer.id, legacyDrafts);
  });
  const draftRef = useRef(draft);
  const [storageError, setStorageError] = useState(false);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const messagesRef = useRef(messages);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unreadStart, setUnreadStart] = useState('');
  const initialLoaded = useRef(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [newMessages, setNewMessages] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftPreview, setDraftPreview] = useState(false);
  const [actionMessage, setActionMessage] = useState<DirectMessage | null>(null);
  const [retractMessage, setRetractMessage] = useState<DirectMessage | null>(null);
  const [actionMode, setActionMode] = useState<'actions' | 'receipt'>('actions');
  const actionAnchor = useRef<HTMLElement | null>(null);
  const focusComposerOnClose = useRef(false);
  const pressStart = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  const [actionBusy, setActionBusy] = useState(false);
  const [highlight, setHighlight] = useState('');
  const [viewport, setViewport] = useState<CSSProperties>({});
  const [composerHeight, setComposerHeight] = useState(76);
  const composer = useRef<HTMLFormElement>(null);
  const alive = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const scrollIntent = useRef<ScrollIntent | null>({ kind: 'bottom' });
  const fetchBusy = useRef(false);
  const olderBusy = useRef(false);
  const sendBusy = useRef(false);
  const actionLock = useRef(false);
  const readBusy = useRef(false);
  const readThrough = useRef('');
  const visibleIds = useRef(new Set<string>());
  const overlayOpen = useRef(false);
  overlayOpen.current = pickerOpen || draftPreview || !!actionMessage || !!retractMessage;
  const readVisible = useRef<() => void>(() => {});
  const loadLatest = useRef<(signal?: AbortSignal) => Promise<void>>(async () => {});
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function openMessageMenu(
    message: DirectMessage,
    element: HTMLElement,
    mode: 'actions' | 'receipt' = 'actions',
  ) {
    actionAnchor.current = element;
    setActionMode(mode);
    setActionMessage(message);
  }
  function cancelPress() {
    if (pressStart.current) clearTimeout(pressStart.current.timer);
    pressStart.current = null;
  }
  useEffect(() => () => cancelPress(), []);
  function saveDraft(next: MessageDraft) {
    draftRef.current = next;
    if (alive.current) setDraft(next);
    try {
      // Keep an empty tombstone too: returning to an older history entry must not resurrect sent text.
      localStorage.setItem(storageKey, JSON.stringify(next));
      if (alive.current) setStorageError(false);
    } catch {
      if (alive.current) setStorageError(true);
    }
  }
  function settleAttempt(attempt: MessageAttempt, error?: string) {
    let current = draftRef.current;
    if (!alive.current) {
      // A reopened screen may already have a newer draft; do not overwrite it with this old closure.
      try {
        current = parseMessageDraft(localStorage.getItem(storageKey), peer.id);
      } catch {
        /* Retain the in-memory copy if storage is unavailable. */
      }
    }
    if (current.pending?.requestId !== attempt.requestId) return;
    saveDraft({ ...current, pending: error ? { ...attempt, status: 'error', error } : undefined });
  }
  function updateMessages(next: DirectMessage[]) {
    messagesRef.current = next;
    setMessages(next);
    const reconciled = reconcileMessageDraft(draftRef.current, next);
    if (reconciled !== draftRef.current) {
      // A poll can confirm delivery before an uncertain POST completes. The next draft may send.
      sendBusy.current = false;
      saveDraft(reconciled);
    }
  }
  function toLatest() {
    const node = scroll.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }
  const load = async (signal?: AbortSignal) => {
    if (!alive.current || fetchBusy.current || document.visibilityState !== 'visible') return;
    fetchBusy.current = true;
    try {
      const incoming = await api<DirectMessage[]>(
        `/messages?userId=${encodeURIComponent(peer.id)}`,
        undefined,
        'GET',
        { signal },
      );
      if (!alive.current || signal?.aborted) return;
      const firstLoad = !initialLoaded.current;
      initialLoaded.current = true;
      const existingIds = new Set(messagesRef.current.map((message) => message.id));
      const added = incoming.filter(
        (message) => !existingIds.has(message.id) && message.senderId !== accountId,
      ).length;
      if (firstLoad) setHasOlder(incoming.length === 50);
      const firstUnread = firstLoad ? firstUnreadMessage(incoming, accountId) : undefined;
      if (firstUnread) {
        setUnreadStart(firstUnread);
        nearBottom.current = false;
        scrollIntent.current = { kind: 'unread', id: firstUnread };
      } else if (nearBottom.current) scrollIntent.current = { kind: 'bottom' };
      else if (added && !firstLoad) setNewMessages((count) => count + added);
      updateMessages(mergeMessages(messagesRef.current, incoming));
      setError('');
    } catch (e) {
      if (alive.current && !signal?.aborted) setError(errorText(e));
      throw e;
    } finally {
      fetchBusy.current = false;
      if (alive.current) setLoading(false);
    }
  };
  loadLatest.current = load;
  const reconnect = useLiveRefresh((signal) => loadLatest.current(signal), {
    interval: 2500,
    resource: `${accountId}:${peer.id}`,
  });
  useEffect(() => {
    alive.current = true;
    const initial = new AbortController();
    void loadLatest.current(initial.signal).catch(() => {});
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        readVisible.current();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      alive.current = false;
      initial.abort();
      clearTimeout(highlightTimer.current);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);
  useEffect(() => {
    if (typeof legacyDrafts?.[peer.id] !== 'string') return;
    try {
      // Remove the legacy peer only after its new durable draft is safely written.
      localStorage.setItem(storageKey, JSON.stringify(draftRef.current));
    } catch {
      return;
    }
    setLegacyDrafts((previous) => {
      const next = { ...previous };
      delete next[peer.id];
      return next;
    });
  }, [legacyDrafts, peer.id, setLegacyDrafts, storageKey]);
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    const resize = () => {
      setViewport({ height: `${visual.height}px`, top: `${visual.offsetTop}px` });
      if (nearBottom.current)
        requestAnimationFrame(() => {
          const node = scroll.current;
          if (node) node.scrollTop = node.scrollHeight;
        });
    };
    resize();
    visual.addEventListener('resize', resize);
    visual.addEventListener('scroll', resize);
    return () => {
      visual.removeEventListener('resize', resize);
      visual.removeEventListener('scroll', resize);
    };
  }, []);
  useLayoutEffect(() => {
    const node = composer.current;
    if (!node) return;
    const observer = new ResizeObserver(() =>
      setComposerHeight(node.getBoundingClientRect().height),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    const fit = () => {
      node.style.height = '0px';
      node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
    };
    fit();
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [draft.body]);
  useLayoutEffect(() => {
    const node = scroll.current,
      intent = scrollIntent.current;
    if (!node || !intent) return;
    if (intent.kind === 'bottom') node.scrollTop = node.scrollHeight;
    if (intent.kind === 'older') node.scrollTop = intent.top + node.scrollHeight - intent.height;
    if (intent.kind === 'unread') {
      const target = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (row) => row.dataset.messageId === intent.id,
      );
      if (target)
        node.scrollTop +=
          target.getBoundingClientRect().top - node.getBoundingClientRect().top - 48;
      nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
      setAtBottom(nearBottom.current);
    }
    if (intent.kind === 'jump') {
      const target = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (row) => row.dataset.messageId === intent.id,
      );
      target?.scrollIntoView({ block: 'center' });
      setHighlight(intent.id);
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => {
        if (alive.current) setHighlight('');
      }, 1800);
    }
    scrollIntent.current = null;
  }, [messages, draft.pending, loading]);
  useEffect(() => {
    if (!list.current) return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current && scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(list.current);
    return () => observer.disconnect();
  }, []);
  readVisible.current = async () => {
    const throughId = visibleReadTarget(
      messagesRef.current,
      accountId,
      visibleIds.current,
      document.visibilityState === 'visible' &&
        document.hasFocus() &&
        !overlayOpen.current &&
        ![...document.querySelectorAll('[role="dialog"][data-state="open"]')].some(
          (dialog) => !dialog.querySelector('[data-dm-thread]'),
        ),
    );
    if (!throughId || readBusy.current || throughId === readThrough.current) return;
    readBusy.current = true;
    try {
      await api('/messages', { userId: peer.id, throughId }, 'PATCH');
      if (alive.current) readThrough.current = throughId;
    } catch {
      /* Leave it unread and retry only when visibility/scroll/poll is checked again. */
    } finally {
      readBusy.current = false;
    }
  };
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    visibleIds.current.clear();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageId!;
          const visible =
            entry.isIntersecting &&
            entry.intersectionRect.height >= Math.min(44, entry.boundingClientRect.height);
          if (visible) visibleIds.current.add(id);
          else visibleIds.current.delete(id);
        }
        readVisible.current();
      },
      { root: node, threshold: [0, 0.1, 0.5, 1] },
    );
    node.querySelectorAll('[data-message-id]').forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [messages, loading]);
  useEffect(() => {
    if (!overlayOpen.current) readVisible.current();
  }, [pickerOpen, draftPreview, actionMessage, retractMessage]);

  async function loadOlder(jumpId?: string) {
    if (olderBusy.current || !messagesRef.current.length || !hasOlder) return;
    olderBusy.current = true;
    setLoadingOlder(true);
    try {
      let found = false;
      do {
        const before = messagesRef.current[0].id;
        const incoming = await api<DirectMessage[]>(
          `/messages?userId=${encodeURIComponent(peer.id)}&before=${encodeURIComponent(before)}`,
        );
        if (!alive.current) return;
        const more = incoming.length === 50;
        setHasOlder(more);
        found = !!jumpId && incoming.some((message) => message.id === jumpId);
        const node = scroll.current;
        if (found && jumpId) scrollIntent.current = { kind: 'jump', id: jumpId };
        else if (node)
          scrollIntent.current = { kind: 'older', height: node.scrollHeight, top: node.scrollTop };
        updateMessages(mergeMessages(messagesRef.current, incoming, 'older'));
        if (!jumpId || found || !more || !incoming.length) break;
        // Give React a frame to preserve the viewport before loading another history page.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } while (alive.current);
      if (jumpId && !found) props.toast('이 메시지의 원문을 찾을 수 없어요.');
      setError('');
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      olderBusy.current = false;
      if (alive.current) setLoadingOlder(false);
    }
  }
  function jumpTo(id: string) {
    if (messagesRef.current.some((message) => message.id === id)) {
      scrollIntent.current = { kind: 'jump', id };
      setMessages([...messagesRef.current]);
    } else if (hasOlder) void loadOlder(id);
    else props.toast('이 메시지의 원문을 찾을 수 없어요.');
  }
  async function transmit(attempt: MessageAttempt) {
    if (sendBusy.current) return;
    sendBusy.current = true;
    saveDraft({
      ...draftRef.current,
      pending: { ...attempt, status: 'sending', error: undefined },
    });
    try {
      const sent = await api<DirectMessage>('/messages', messageAttemptPayload(attempt));
      settleAttempt(attempt);
      if (alive.current) {
        scrollIntent.current = { kind: 'bottom' };
        updateMessages(mergeMessages(messagesRef.current, [sent]));
      }
    } catch (e) {
      settleAttempt(attempt, errorText(e));
    } finally {
      sendBusy.current = false;
    }
  }
  function send(event: FormEvent) {
    event.preventDefault();
    if (sendBusy.current || draftRef.current.pending || loading) return;
    try {
      const attempt = makeMessageAttempt(
        draftRef.current,
        peer.id,
        crypto.randomUUID(),
        new Date().toISOString(),
      );
      scrollIntent.current = { kind: 'bottom' };
      saveDraft({ body: '', blocks: [], pending: attempt });
      void transmit(attempt);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function react(message: DirectMessage) {
    if (actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    try {
      const mine = message.reactions?.some((reaction) => reaction.emoji === '❤️' && reaction.mine);
      const updated = await api<DirectMessage>(
        `/messages/${encodeURIComponent(message.id)}`,
        { reaction: mine ? null : '❤️' },
        'PATCH',
      );
      if (alive.current) {
        updateMessages(mergeMessages(messagesRef.current, [updated]));
        setActionMessage(null);
      }
    } catch (e) {
      props.toast(errorText(e));
    } finally {
      actionLock.current = false;
      if (alive.current) setActionBusy(false);
    }
  }
  async function retract() {
    if (!retractMessage || actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    try {
      const updated = await api<DirectMessage>(
        `/messages/${encodeURIComponent(retractMessage.id)}`,
        {},
        'DELETE',
      );
      if (alive.current) {
        updateMessages(mergeMessages(messagesRef.current, [updated]));
        setRetractMessage(null);
        setActionMessage(null);
      }
    } catch (e) {
      props.toast(errorText(e));
    } finally {
      actionLock.current = false;
      if (alive.current) setActionBusy(false);
    }
  }
  function reply(message: DirectMessage) {
    focusComposerOnClose.current = true;
    saveDraft({
      ...draftRef.current,
      replyTo: {
        id: message.id,
        body: messagePreview(message),
        senderId: message.senderId,
        deleted: message.deleted,
      },
    });
    setActionMessage(null);
    requestAnimationFrame(() => input.current?.focus());
  }
  const receipts = receiptAnchors(messages, accountId);
  const selectedMessage = messages.find((m) => m.id === actionMessage?.id) ?? actionMessage;
  return (
    <section
      className={styles.thread}
      style={{ ...viewport, '--dm-composer-height': `${composerHeight}px` } as CSSProperties}
      aria-label={`${peer.nickname}님과의 쪽지 대화`}
      data-dm-thread
    >
      <header className={styles.threadHeader}>
        <IconButton label="쪽지 목록으로" onClick={onBack}>
          <ArrowLeft size={22} />
        </IconButton>
        <button
          className={styles.peer}
          onClick={() =>
            props.data.profile.role !== 'PARENT' && props.navigate(communityProfileHref(peer.id))
          }
          disabled={props.data.profile.role === 'PARENT'}
          aria-label={
            props.data.profile.role === 'PARENT' ? peer.nickname : `${peer.nickname}님 프로필 보기`
          }
        >
          <Avatar nickname={peer.nickname} small />
          <span>
            <strong>{peer.nickname}</strong>
            <span>쪽지</span>
          </span>
        </button>
      </header>
      {error && (
        <div role="alert" className={styles.threadError}>
          <span>{error}</span>
          <button onClick={() => void reconnect().catch(() => {})}>다시 연결</button>
        </div>
      )}
      <div
        ref={scroll}
        className={styles.stream}
        tabIndex={0}
        aria-label="대화 내용"
        onScroll={() => {
          const node = scroll.current;
          if (!node) return;
          const near = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
          nearBottom.current = near;
          setAtBottom(near);
          if (near) setNewMessages(0);
          readVisible.current();
        }}
      >
        <div ref={list} className={styles.messageList}>
          {loading ? (
            <p className={styles.loading} role="status">
              대화를 불러오고 있어요…
            </p>
          ) : !messages.length && !draft.pending ? (
            <div className={styles.greeting}>
              <Avatar nickname={peer.nickname} />
              <h2>{peer.nickname}</h2>
              <p>인사와 함께 공부하던 문제도 나눠 보세요.</p>
            </div>
          ) : null}
          {hasOlder && (
            <button
              className={styles.historyButton}
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? '이전 대화를 불러오고 있어요…' : '이전 메시지 보기'}
            </button>
          )}
          {groupMessages(messages).map(({ message, showDate, startsGroup, endsGroup }) => {
            const own = message.senderId === accountId;
            const heart = message.reactions?.find((reaction) => reaction.emoji === '❤️');
            return (
              <div key={message.id}>
                {showDate && (
                  <p className={styles.date}>
                    <time dateTime={message.createdAt}>{dateLabel(message.createdAt)}</time>
                  </p>
                )}
                {message.id === unreadStart && (
                  <p className={styles.unreadDivider}>여기부터 읽지 않은 메시지</p>
                )}
                <div
                  data-message-id={message.id}
                  className={`${styles.message} ${own ? styles.own : ''} ${startsGroup ? styles.groupStart : ''} ${endsGroup ? styles.groupEnd : ''} ${highlight === message.id ? styles.highlight : ''}`}
                >
                  <div
                    className={styles.messageContent}
                    tabIndex={message.deleted ? undefined : 0}
                    aria-label={
                      message.deleted
                        ? undefined
                        : `${own ? '내' : peer.nickname + '님의'} 메시지: ${messagePreview(message)}`
                    }
                    onContextMenu={(event) => {
                      if (!message.deleted) {
                        event.preventDefault();
                        cancelPress();
                        openMessageMenu(message, event.currentTarget);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        openMessageMenu(message, event.currentTarget);
                      }
                    }}
                    onPointerDown={(event) => {
                      if (
                        message.deleted ||
                        event.button !== 0 ||
                        (event.target as HTMLElement).closest('button,a,input')
                      )
                        return;
                      cancelPress();
                      const element = event.currentTarget;
                      pressStart.current = {
                        x: event.clientX,
                        y: event.clientY,
                        timer: setTimeout(() => {
                          pressStart.current = null;
                          openMessageMenu(message, element);
                        }, 450),
                      };
                    }}
                    onPointerMove={(event) => {
                      const p = pressStart.current;
                      if (p && Math.hypot(event.clientX - p.x, event.clientY - p.y) > 10)
                        cancelPress();
                    }}
                    onPointerUp={cancelPress}
                    onPointerCancel={cancelPress}
                    onPointerLeave={cancelPress}
                  >
                    {message.replyTo && (
                      <button
                        className={styles.quote}
                        onClick={() => jumpTo(message.replyTo!.id)}
                        aria-label="답장 원문 보기"
                      >
                        <span>
                          {message.replyTo.senderId === accountId ? '나' : peer.nickname}에게 답장
                        </span>
                        <strong>
                          {message.replyTo.deleted
                            ? '보내기를 취소한 메시지'
                            : message.replyTo.body || '학습 자료'}
                        </strong>
                      </button>
                    )}
                    {(message.body || message.deleted) && (
                      <p className={`${styles.bubble} ${message.deleted ? styles.deleted : ''}`}>
                        {message.deleted ? '보내기를 취소한 메시지예요.' : message.body}
                      </p>
                    )}
                    {!message.deleted && !!message.blocks?.length && (
                      <div className={styles.attachments}>
                        {message.blocks.map((block) => (
                          <BlockView
                            key={block.id}
                            block={block}
                            messageId={message.id}
                            data={props.data}
                            navigate={props.navigate}
                            toast={props.toast}
                            onChanged={() => void loadLatest.current().catch(() => {})}
                          />
                        ))}
                      </div>
                    )}
                    {!!heart?.count && !message.deleted && (
                      <button
                        className={styles.reaction}
                        aria-label={`하트 ${heart.count}개${heart.mine ? ', 내 반응 취소' : ', 하트 보내기'}`}
                        aria-pressed={heart.mine}
                        disabled={actionBusy}
                        onClick={() => void react(message)}
                      >
                        ❤️ <span>{heart.count}</span>
                      </button>
                    )}
                    {(endsGroup ||
                      message.id === receipts.read ||
                      message.id === receipts.sent) && (
                      <div className={styles.messageMeta}>
                        {endsGroup && (
                          <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
                        )}
                        {own &&
                          !message.deleted &&
                          (message.id === receipts.read || message.id === receipts.sent) && (
                            <button
                              type="button"
                              className={styles.receipt}
                              onClick={(event) =>
                                openMessageMenu(message, event.currentTarget, 'receipt')
                              }
                              aria-label={`${message.readAt ? '읽음' : '보냄'} 상태 자세히 보기`}
                            >
                              {message.readAt ? <Check size={13} /> : <Clock size={12} />}
                              {message.readAt ? '읽음' : '보냄'}
                            </button>
                          )}
                      </div>
                    )}
                  </div>
                  {!message.deleted && (
                    <IconButton
                      className={styles.messageMore}
                      label={`${own ? '내' : peer.nickname + '님의'} 메시지 더보기: ${messagePreview(message).slice(0, 24)}`}
                      onClick={(event) =>
                        openMessageMenu(
                          message,
                          (event.currentTarget
                            .closest('[data-message-id]')
                            ?.querySelector('[tabindex]') as HTMLElement) ?? event.currentTarget,
                        )
                      }
                    >
                      <MoreHorizontal size={18} />
                    </IconButton>
                  )}
                </div>
              </div>
            );
          })}
          {draft.pending && (
            <div className={`${styles.message} ${styles.own} ${styles.groupStart}`}>
              <div className={styles.messageContent}>
                {draft.pending.body && (
                  <p className={`${styles.bubble} ${styles.pendingBubble}`}>{draft.pending.body}</p>
                )}
                {!!draft.pending.blocks.length && (
                  <div className={styles.attachments}>
                    {draft.pending.blocks.map((block) => (
                      <BlockView
                        key={block.id}
                        block={block}
                        data={props.data}
                        navigate={props.navigate}
                        toast={props.toast}
                        preview
                      />
                    ))}
                  </div>
                )}
                <div className={styles.pendingStatus} role="status">
                  {draft.pending.status === 'sending' ? (
                    <>
                      <Clock size={12} /> 보내는 중…
                    </>
                  ) : (
                    <>
                      <span className={styles.failedLabel}>
                        <AlertCircle size={13} /> 전송 미확인
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          if (draftRef.current.pending) void transmit(draftRef.current.pending);
                        }}
                      >
                        다시 보내기
                      </button>
                    </>
                  )}
                </div>
                {draft.pending.status === 'error' && (
                  <p className={styles.sendError} role="alert">
                    {draft.pending.error}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <button className={styles.latest} onClick={toLatest}>
          <ArrowDown size={16} />
          {newMessages ? `새 메시지 ${newMessages}개` : '최근 메시지로'}
        </button>
      )}
      <form ref={composer} className={styles.composer} onSubmit={send} noValidate>
        {draft.replyTo && (
          <div className={styles.replyDraft}>
            <span>
              <strong>
                {draft.replyTo.senderId === accountId ? '나' : peer.nickname}에게 답장
              </strong>
              <span>{draft.replyTo.body}</span>
            </span>
            <IconButton
              label="답장 취소"
              onClick={() => saveDraft({ ...draftRef.current, replyTo: undefined })}
            >
              <X size={18} />
            </IconButton>
          </div>
        )}
        {!!draft.blocks.length && (
          <div className={styles.draftAttachments}>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => setDraftPreview(true)}
            >
              학습 자료 {draft.blocks.length}개 · 첨부 확인
            </button>
            <IconButton
              label="첨부 모두 삭제"
              onClick={() => saveDraft({ ...draftRef.current, blocks: [] })}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}
        {storageError && (
          <p className={styles.sendError} role="alert">
            이 기기에 임시 저장하지 못했어요. 작성 중에는 대화를 닫지 말아 주세요.
          </p>
        )}
        {draft.pending && (
          <p className={styles.composerHint} role="status">
            {draft.pending.status === 'error'
              ? '위 메시지를 다시 보내면 이어서 전송할 수 있어요. 중복으로 보내지 않아요.'
              : '전송을 마치면 다음 메시지를 보낼 수 있어요.'}
          </p>
        )}
        <div className={styles.inputRow}>
          <IconButton
            label="학습 자료 첨부"
            disabled={draft.blocks.length >= 3}
            onClick={() => setPickerOpen(true)}
          >
            <Plus size={22} />
          </IconButton>
          <div className={styles.inputShell}>
            <textarea
              ref={input}
              rows={1}
              aria-label="쪽지 내용"
              placeholder="메시지 보내기…"
              maxLength={3000}
              value={draft.body}
              onChange={(e) => saveDraft({ ...draftRef.current, body: e.target.value })}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  window.matchMedia('(pointer: fine)').matches
                ) {
                  e.preventDefault();
                  if ((draft.body.trim() || draft.blocks.length) && !draft.pending)
                    e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              type="submit"
              className={styles.send}
              aria-label="쪽지 보내기"
              disabled={loading || !!draft.pending || (!draft.body.trim() && !draft.blocks.length)}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
        {draft.body.length > 2800 && (
          <span className={styles.characterCount}>
            {draft.body.length.toLocaleString()} / 3,000
          </span>
        )}
      </form>
      <BlockPicker
        data={props.data}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        remaining={3 - draft.blocks.length}
        maxAttachments={3}
        photoCount={draft.blocks.filter((block) => block.type === 'PHOTO').length}
        onAdd={(block) => {
          if (draftRef.current.blocks.length < 3)
            saveDraft({ ...draftRef.current, blocks: [...draftRef.current.blocks, block] });
          setPickerOpen(false);
        }}
      />
      <Sheet open={draftPreview} onClose={() => setDraftPreview(false)} title="보낼 학습 자료">
        <BlockDraftList
          blocks={draft.blocks}
          data={props.data}
          onChange={(blocks: CommunityBlock[]) => saveDraft({ ...draftRef.current, blocks })}
        />
        <Button className="w-full mt-4" onClick={() => setDraftPreview(false)}>
          완료
        </Button>
      </Sheet>
      {selectedMessage && (
        <MessagePopover
          anchor={actionAnchor.current}
          restoreFocus={() => {
            if (!focusComposerOnClose.current) return false;
            focusComposerOnClose.current = false;
            input.current?.focus();
            return true;
          }}
          title={actionMode === 'receipt' ? '메시지 상태' : '메시지 동작'}
          onClose={() => {
            if (!actionBusy) {
              setActionMessage(null);
              setRetractMessage(null);
            }
          }}
        >
          {retractMessage ? (
            <div className={styles.contextConfirm}>
              <strong>보내기를 취소할까요?</strong>
              <p>상대방의 대화에서도 사라져요. 이미 확인한 내용은 남을 수 있어요.</p>
              <button
                disabled={actionBusy}
                className={styles.danger}
                onClick={() => void retract()}
              >
                {actionBusy ? '취소 중…' : '보내기 취소'}
              </button>
              <button disabled={actionBusy} onClick={() => setRetractMessage(null)}>
                돌아가기
              </button>
            </div>
          ) : actionMode === 'receipt' ? (
            <div className={styles.receiptDetails}>
              <strong>{selectedMessage.readAt ? '읽음' : '보냄'}</strong>
              <dl>
                <div>
                  <dt>보낸 시간</dt>
                  <dd>
                    {timeLabel(selectedMessage.createdAt)}
                    <small>{dateLabel(selectedMessage.createdAt)}</small>
                  </dd>
                </div>
                <div>
                  <dt>읽은 시간</dt>
                  <dd>
                    {selectedMessage.readAt ? (
                      <>
                        {timeLabel(selectedMessage.readAt)}
                        <small>{dateLabel(selectedMessage.readAt)}</small>
                      </>
                    ) : (
                      '아직 읽지 않았어요'
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          ) : (
            <div className={styles.contextActions}>
              <button
                className={styles.quickHeart}
                disabled={actionBusy}
                aria-pressed={
                  selectedMessage.reactions?.some((r) => r.emoji === '❤️' && r.mine) ?? false
                }
                onClick={() => void react(selectedMessage)}
              >
                <span>❤️</span>
                {selectedMessage.reactions?.some((r) => r.emoji === '❤️' && r.mine)
                  ? '좋아요 취소'
                  : '좋아요'}
              </button>
              <button
                disabled={actionBusy || selectedMessage.deleted}
                onClick={() => reply(selectedMessage)}
              >
                <span>답장</span>
                <Undo2 size={19} />
              </button>
              {!!selectedMessage.body && (
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(selectedMessage.body);
                      props.toast('메시지를 복사했어요');
                      setActionMessage(null);
                    } catch {
                      props.toast('복사하지 못했어요. 다시 시도해 주세요.');
                    }
                  }}
                >
                  <span>복사</span>
                  <Copy size={19} />
                </button>
              )}
              {selectedMessage.senderId === accountId && !selectedMessage.deleted && (
                <button
                  className={styles.danger}
                  disabled={actionBusy}
                  onClick={() => setRetractMessage(selectedMessage)}
                >
                  <span>보내기 취소</span>
                  <Trash2 size={19} />
                </button>
              )}
            </div>
          )}
        </MessagePopover>
      )}
    </section>
  );
}
