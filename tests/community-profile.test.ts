import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PublicCommunityProfile,
  CommunityPrivacySettings,
  ProfileIdentity,
  profileIdentity,
  profileFollowRestriction,
  communityProfileHref,
} from '../src/components/social/community-profile';
import SocialHub from '../src/components/social/social-hub';
import type { CommunityProfileData } from '../src/lib/community-types';
import type { ScreenProps } from '../src/lib/contracts';
import { JourneyContext, JourneyUserContext } from '../src/components/journey';
import { JourneyHistory } from '../src/lib/navigation';

const profile = (patch: Partial<CommunityProfileData> = {}): CommunityProfileData => ({
  id: 'student',
  nickname: '수학도움',
  grade: '고2',
  subjects: ['수학Ⅱ'],
  joinedAt: '2026-03-01T00:00:00Z',
  following: false,
  isMine: false,
  visibility: {
    grade: true,
    subjects: true,
    followerCount: false,
    cardsDefault: false,
    whoCanFollow: 'SAME_GRADE',
  },
  stats: { accepted: 12, cardsCloned: 31, helpedUsers: 17, answers: 19 },
  followers: 38,
  followingCount: 4,
  posts: [],
  answers: [],
  cards: [],
  ...patch,
});
const props = (role = 'STUDENT') =>
  ({
    data: {
      profile: { id: 'me', nickname: '나', grade: '고2', school: '절대노출하지않는학교', role },
    },
    navigate() {},
    back() {},
    refresh: async () => {},
    toast() {},
    path: '/community/profile?user=student',
  }) as unknown as ScreenProps;

test('profile respects grade and subject privacy even if stale data contains hidden fields', () => {
  const p = profile({ visibility: { ...profile().visibility, grade: false, subjects: false } });
  assert.equal(profileIdentity(p), '');
  const html = renderToStaticMarkup(createElement(ProfileIdentity, { profile: p, navigate() {} }));
  assert.doesNotMatch(html, /고2|수학Ⅱ|팔로워 38|나만 보는/);
  assert.match(html, /팔로워 비공개/);
  assert.match(html, /채택된 답변/);
  assert.match(html, />12</);
  assert.match(html, />31</);
  assert.match(html, />17</);
});

test('only profile owner sees private follower count and own list controls', () => {
  const own = renderToStaticMarkup(
    createElement(ProfileIdentity, { profile: profile({ isMine: true }), navigate() {} }),
  );
  assert.match(own, /나만 보는 팔로워 목록 · 38명/);
  assert.match(own, /팔로워 비공개/);
  const publicHtml = renderToStaticMarkup(
    createElement(ProfileIdentity, {
      profile: profile({ visibility: { ...profile().visibility, followerCount: true } }),
      navigate() {},
    }),
  );
  assert.match(publicHtml, /팔로워 38/);
  assert.doesNotMatch(publicHtml, /나만 보는/);
});

test('follow restrictions preserve an existing relationship and defer hidden-grade decisions to server', () => {
  assert.match(profileFollowRestriction(profile(), '고1'), /같은 학년/);
  assert.equal(profileFollowRestriction(profile(), '고2'), '');
  assert.equal(profileFollowRestriction(profile({ following: true }), '고1'), '');
  assert.equal(profileFollowRestriction(profile({ grade: undefined }), '고1'), '');
  assert.match(
    profileFollowRestriction(
      profile({ visibility: { ...profile().visibility, whoCanFollow: 'NONE' } }),
      '고2',
    ),
    /새 팔로우/,
  );
});

test('parent public profile and privacy routes are explicit unavailable states without private identity', () => {
  for (const component of [
    createElement(PublicCommunityProfile, { ...props('PARENT'), userId: 'student' }),
    createElement(CommunityPrivacySettings, props('PARENT')),
  ]) {
    const html = renderToStaticMarkup(component);
    assert.match(html, /학생/);
    assert.doesNotMatch(html, /절대노출하지않는학교|공개 설정을 저장|팔로우 해제/);
  }
});

test('message header offers contextual student profile but preserves parent private messaging', () => {
  const student = renderToStaticMarkup(
    createElement(SocialHub, { ...props(), initialUser: { id: 'peer', nickname: '상대' } }),
  );
  assert.match(student, /상대님 프로필 보기/);
  assert.match(student, /쪽지 내용/);
  const parent = renderToStaticMarkup(
    createElement(SocialHub, { ...props('PARENT'), initialUser: { id: 'peer', nickname: '상대' } }),
  );
  assert.doesNotMatch(parent, /프로필 보기/);
  assert.match(parent, /쪽지 내용/);
  assert.equal(communityProfileHref('user/a?b'), '/community/profile?user=user%2Fa%3Fb');
});

test('social list search is bounded to the current relationship list, never a people finder', () => {
  const html = renderToStaticMarkup(createElement(SocialHub, props()));
  assert.match(html, /이 목록에서 닉네임 검색/);
  assert.doesNotMatch(html, /친구 찾기|맞팔로우|추천/);
});

test('returning from a profile preserves the correct recipient draft in its journey entry', () => {
  const journey = {
    entry: {
      id: 'conversation',
      view: { 'me:messages.drafts': { peer: '작성 중인 쪽지', other: '다른 상대의 초안' } },
    },
  } as unknown as JourneyHistory;
  const html = renderToStaticMarkup(
    createElement(
      JourneyContext.Provider,
      { value: journey },
      createElement(
        JourneyUserContext.Provider,
        { value: 'me' },
        createElement(SocialHub, { ...props(), initialUser: { id: 'peer', nickname: '상대' } }),
      ),
    ),
  );
  assert.match(html, /작성 중인 쪽지/);
  assert.doesNotMatch(html, /다른 상대의 초안/);
});
