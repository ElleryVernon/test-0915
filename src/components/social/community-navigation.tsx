'use client';
import { useEffect, useState } from 'react';
import {
  Bookmark,
  FileText,
  MessageCircle,
  PencilLine,
  Search,
  UserRound,
} from '@/components/icons';
import { Button, EmptyState, IconButton, ListRow, ScreenHeader } from '@/components/ui';
import { api } from '@/lib/api';
import type { ScreenProps } from '@/lib/contracts';
import SocialHub, { type SocialData, type SocialUser } from './social-hub';
import { relativeTime } from './helpers';
import { useJourneyState } from '../journey';

export const communityBase = (props: ScreenProps) =>
  props.data.profile.role === 'PARENT' ? '/parent-boards' : '/community';
export function CommunityHeader({
  active = 'all',
  onSearch,
  ...props
}: ScreenProps & { active?: 'all' | 'school' | 'messages'; onSearch?: () => void }) {
  const base = communityBase(props);
  const tabs = [
    { id: 'all', label: '전체 커뮤니티', href: base },
    { id: 'school', label: '학교 커뮤니티', href: `${base}?space=school` },
    { id: 'messages', label: '쪽지', href: `${base}?space=messages` },
  ];
  return (
    <header className="community-header">
      <nav className="community-spaces" aria-label="커뮤니티 공간">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            aria-current={active === tab.id ? 'page' : undefined}
            onClick={() => props.navigate(tab.href)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="community-header-actions">
        {onSearch && (
          <IconButton label="게시글 검색" onClick={onSearch}>
            <Search size={20} />
          </IconButton>
        )}
        <IconButton label="커뮤니티 내정보" onClick={() => props.navigate(`${base}/me`)}>
          <UserRound size={22} />
        </IconButton>
      </div>
    </header>
  );
}
export function CommunityProfile(props: ScreenProps) {
  const base = communityBase(props);
  return (
    <>
      <ScreenHeader title="커뮤니티 내정보" back={() => props.back(base)} />
      <div className="page-inset layout-section community-profile">
        <div className="community-identity">
          <span className="community-avatar">
            <UserRound size={24} />
          </span>
          <div>
            <h2>{props.data.profile.nickname}</h2>
            <p>{props.data.profile.school || '등록한 학교가 없어요'}</p>
          </div>
        </div>
        <section aria-label="내 활동">
          {props.data.profile.role === 'STUDENT' && (
            <ListRow
              icon={<UserRound size={22} />}
              title="공개 프로필"
              description="내 카드와 답변이 다른 사람에게 어떻게 보이는지 확인해요"
              onClick={() =>
                props.navigate(
                  `/community/profile?user=${encodeURIComponent(props.data.profile.id)}`,
                )
              }
            />
          )}
          <ListRow
            icon={<FileText size={22} />}
            title="내가 쓴 글"
            description="익명으로 쓴 글도 함께 보여요"
            onClick={() => props.navigate(`${base}?mine=1`)}
          />
          <ListRow
            icon={<MessageCircle size={22} />}
            title="내가 댓글 남긴 글"
            onClick={() => props.navigate(`${base}?commented=1`)}
          />
          <ListRow
            icon={<Bookmark size={22} />}
            title="저장한 글"
            onClick={() => props.navigate(`${base}?saved=1`)}
          />
        </section>
        <section aria-label="내 정보 관리">
          {props.data.profile.role === 'STUDENT' && (
            <ListRow
              icon={<UserRound size={22} />}
              title="프로필 공개 범위"
              description="학년·과목·팔로워 수와 팔로우 허용 범위"
              onClick={() => props.navigate('/community/privacy')}
            />
          )}
          <ListRow
            icon={<UserRound size={22} />}
            title="프로필·학교 정보 수정"
            description="마이에서 닉네임과 학교를 관리해요"
            onClick={() => props.navigate('/profile')}
          />
        </section>
      </div>
    </>
  );
}
type Conversation = SocialUser & { body: string; createdAt: string };
export function CommunityInbox(props: ScreenProps) {
  const base = communityBase(props);
  const inboxPath = `${base}?space=messages`;
  const params = new URLSearchParams(props.path.split('?')[1]);
  const peer = params.get('peer');
  const [items, setItems] = useState<Conversation[]>([]);
  const [peerUser, setPeerUser] = useState<SocialUser | null>(null);
  const [social, setSocial] = useState<SocialData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useJourneyState('inbox.query', '');
  const choosing = params.get('new') === '1';
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([
      api<Conversation[]>('/messages?inbox=1'),
      api<SocialData>('/social'),
      peer
        ? api<SocialUser>(`/messages?peer=1&userId=${encodeURIComponent(peer)}`)
        : Promise.resolve(null),
    ])
      .then(([list, people, person]) => {
        if (active) {
          setItems(list);
          setPeerUser(person);
          setSocial(people);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [retry, peer]);
  const target =
    peerUser || items.find((u) => u.id === peer) || social?.users.find((u) => u.id === peer);
  const contacts = [
    ...new Map(
      [...(social?.following ?? []), ...(social?.followers ?? []), ...items].map((u) => [u.id, u]),
    ).values(),
  ];
  const candidates = (choosing ? contacts : items).filter((u) =>
    u.nickname.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  function open(user: SocialUser) {
    props.navigate(`${inboxPath}${choosing ? '&new=1' : ''}&peer=${encodeURIComponent(user.id)}`);
  }
  return (
    <>
      <CommunityHeader {...props} active="messages" />
      <div className="page-inset pb-8 community-inbox">
        {peer ? (
          loading ? (
            <p role="status" className="py-8 text-muted">
              대화를 불러오고 있어요…
            </p>
          ) : target ? (
            <SocialHub
              key={peer}
              {...props}
              initialTab="messages"
              initialUser={target}
              onCloseConversation={() => props.back(inboxPath)}
            />
          ) : (
            <EmptyState
              title="대화를 열 수 없어요"
              description={error || '상대가 탈퇴했거나 대화할 수 없는 계정이에요.'}
              action={
                <Button
                  variant="secondary"
                  onClick={() => props.navigate(inboxPath, { replace: true })}
                >
                  쪽지 목록으로
                </Button>
              }
            />
          )
        ) : (
          <>
            <div className="community-inbox-heading">
              <h1>{choosing ? '새 쪽지' : '쪽지함'}</h1>
              <Button
                size="compact"
                variant="outline"
                onClick={() =>
                  choosing
                    ? props.navigate(inboxPath, { replace: true })
                    : props.navigate(`${inboxPath}&new=1`)
                }
              >
                {choosing ? (
                  '대화 목록'
                ) : (
                  <>
                    <PencilLine size={16} />새 쪽지
                  </>
                )}
              </Button>
            </div>
            <label className="community-search">
              <Search size={18} />
              <input
                aria-label={choosing ? '쪽지 보낼 사람 검색' : '대화 상대 검색'}
                placeholder={choosing ? '팔로우·대화 목록에서 찾기' : '대화 상대 검색'}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {error ? (
              <div role="alert" className="layout-group py-6">
                <p>{error}</p>
                <Button variant="secondary" onClick={() => setRetry((v) => v + 1)}>
                  다시 불러오기
                </Button>
              </div>
            ) : loading ? (
              <p role="status" className="py-8 text-muted">
                쪽지함을 불러오고 있어요…
              </p>
            ) : candidates.length ? (
              <div className="community-conversations">
                {candidates.map((user) => (
                  <button
                    key={user.id}
                    className="community-conversation"
                    onClick={() => open(user)}
                  >
                    <span className="community-avatar">
                      <MessageCircle size={22} />
                    </span>
                    <span className="community-conversation-copy">
                      <strong>{user.nickname}</strong>
                      {'body' in user && <span>{String(user.body)}</span>}
                    </span>
                    {'createdAt' in user && <time>{relativeTime(String(user.createdAt))}</time>}
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState
                title={
                  query
                    ? '검색 결과가 없어요'
                    : choosing
                      ? '아직 연결된 사람이 없어요'
                      : '아직 주고받은 쪽지가 없어요'
                }
                description={
                  query
                    ? '다른 닉네임으로 찾아보세요.'
                    : choosing
                      ? '도움이 된 답변의 프로필에서 쪽지를 시작할 수 있어요.'
                      : '새 쪽지에서 대화할 상대를 선택할 수 있어요.'
                }
                action={
                  !choosing && !query ? (
                    <Button
                      variant="secondary"
                      onClick={() => props.navigate(`${inboxPath}&new=1`)}
                    >
                      첫 쪽지 시작하기
                    </Button>
                  ) : undefined
                }
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
