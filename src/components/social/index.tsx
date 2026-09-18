'use client';
import type { ScreenProps } from '@/lib/contracts';
import { ScreenHeader } from '@/components/ui';
import Planner from './planner';
import Community from './community';
import { CommunityInbox, CommunityProfile } from './community-navigation';
import Account from './account';
import Parent, { CheerScreen } from './parent';
import PointTopup from './point-topup';
import SocialHub from './social-hub';
import Admin from './admin';
import { PublicCommunityProfile, CommunityPrivacySettings } from './community-profile';
export default function SocialScreens(props: ScreenProps) {
  const route = props.path.split('?')[0];
  if (route === '/community/profile') return <PublicCommunityProfile {...props} userId={new URLSearchParams(props.path.split('?')[1]).get('user') || props.data.profile.id} />;
  if (route === '/community/privacy') return <CommunityPrivacySettings {...props} />;
  if (route === '/planner') return <Planner {...props} />;
  if (route === '/community/me' || route === '/parent-boards/me')
    return <CommunityProfile {...props} />;
  if (
    route === '/messages' ||
    (['/community', '/parent-boards'].includes(route) &&
      new URLSearchParams(props.path.split('?')[1]).get('space') === 'messages')
  )
    return <CommunityInbox {...props} />;
  if (route === '/community' || route === '/parent-boards') return <Community {...props} />;
  if (route === '/boards')
    return <Community {...props} path={props.path.replace('/boards', '/community')} />;
  if (route === '/parent') return <Parent {...props} />;
  if (route === '/points') return <PointTopup {...props} />;
  if (route === '/cheer') return <CheerScreen {...props} />;
  if (route === '/admin') return <Admin {...props} />;
  if (['/messages', '/followers', '/following'].includes(route))
    return (
      <>
        <ScreenHeader
          title={route === '/messages' ? '쪽지' : '함께 공부하는 친구'}
          back={() => props.back('/profile')}
        />
        <div className="page-inset pb-8">
          <SocialHub
            {...props}
            initialTab={route.slice(1) as 'messages' | 'followers' | 'following'}
          />
        </div>
      </>
    );
  return <Account {...props} />;
}
