'use client';
import type { ScreenProps } from '@/lib/contracts';
import { ScreenHeader } from '@/components/ui';
import Planner from './planner';
import Community from './community';
import Account from './account';
import Parent, { CheerScreen } from './parent';
import SocialHub from './social-hub';
import Admin from './admin';
export default function SocialScreens(props: ScreenProps) {
  const route = props.path.split('?')[0];
  if (route === '/planner') return <Planner {...props} />;
  if (route === '/community' || route === '/parent-boards') return <Community {...props} />;
  if (route === '/boards')
    return <Community {...props} path={props.path.replace('/boards', '/community')} />;
  if (route === '/parent') return <Parent {...props} />;
  if (route === '/cheer') return <CheerScreen {...props} />;
  if (route === '/admin') return <Admin {...props} />;
  if (['/messages', '/followers', '/following'].includes(route))
    return (
      <>
        <ScreenHeader
          title={route === '/messages' ? '쪽지' : '함께 공부하는 친구'}
          back={() => props.navigate('/profile')}
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
