'use client';
import { Bookmark, FileText, MessageCircle, Search, UserRound } from '@/components/icons';
import { IconButton, ListRow, ScreenHeader } from '@/components/ui';
import type { ScreenProps } from '@/lib/contracts';
import { CommunityMessages } from './community-messages';
import { schoolDisplayName } from './helpers';

export const communityBase = (props: ScreenProps) =>
  props.data.profile.role === 'PARENT' ? '/parent-boards' : '/community';
export function CommunityHeader({
  active = 'all',
  onSearch,
  searchLabel = '게시글 검색',
  ...props
}: ScreenProps & {
  active?: 'all' | 'school' | 'messages';
  onSearch?: () => void;
  searchLabel?: string;
}) {
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
          <IconButton label={searchLabel} onClick={onSearch}>
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
            <p>{schoolDisplayName(props.data.profile.school) || '등록한 학교가 없어요'}</p>
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
export function CommunityInbox(props: ScreenProps) {
  return (
    <CommunityMessages
      {...props}
      renderHeader={(onSearch) => (
        <CommunityHeader {...props} active="messages" onSearch={onSearch} searchLabel="쪽지 검색" />
      )}
    />
  );
}
