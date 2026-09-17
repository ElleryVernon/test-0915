import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ActivityNotifications from '../src/components/social/activity-notifications';
import type { ScreenProps } from '../src/lib/contracts';

const props = (notifications: unknown[] = []) =>
  ({
    data: { profile: { role: 'PARENT' }, notifications },
    navigate() {},
    back() {},
    toast() {},
    refresh: async () => {},
  }) as unknown as ScreenProps;

test('parent feed distinguishes real child activity from replies with destinations visible before hover', () => {
  const html = renderToStaticMarkup(
    createElement(
      ActivityNotifications,
      props([
        {
          id: 'learning',
          kind: 'CHILD_LEARNING',
          title: '아이의 오늘 학습 소식',
          body: '카드 복습을 마쳤어요.',
          read: false,
          createdAt: new Date().toISOString(),
          href: '/parent?child=child',
        },
        {
          id: 'reply',
          kind: 'FIRST_ANSWER',
          title: '내 글에 댓글이 달렸어요',
          body: '학습 계획 질문',
          read: true,
          createdAt: new Date().toISOString(),
          href: '/community?post=post',
        },
      ]),
    ),
  );
  for (const text of [
    '활동과 소식',
    '자녀 학습',
    '내 글의 댓글',
    '자녀 현황 보기',
    '댓글 보기',
    '모두 읽음',
    '읽지 않음',
  ])
    assert.ok(html.includes(text), text);
});
test('empty feed explains the sharing prerequisite and does not claim everything is already read', () => {
  const html = renderToStaticMarkup(createElement(ActivityNotifications, props()));
  assert.match(html, /학습 활동을 공개하면/);
  assert.doesNotMatch(html, /모두 읽음/);
  assert.doesNotMatch(html, /모두 확인했어요/);
});
