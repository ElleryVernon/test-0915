import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { schoolDisplayName } from '../src/components/social/helpers';
import Account from '../src/components/social/account';
import { CommunityProfile } from '../src/components/social/community-navigation';
import type { ScreenProps } from '../src/lib/contracts';

// The server stores School.Identity() = "이름 · 주소" as the community scoping key; people
// should only ever see the name. The address belongs to search results, where it
// disambiguates same-name schools.
const IDENTITY = '서울제2고등학교 · 서울특별시 강남구 테헤란로 101길 2';
const CHILD_IDENTITY = '가락고등학교 · 서울특별시 송파구 올림픽로 424';

test('schoolDisplayName strips the address suffix from the stored identity', () => {
  assert.equal(schoolDisplayName(IDENTITY), '서울제2고등학교');
  assert.equal(schoolDisplayName('서울고등학교'), '서울고등학교');
  assert.equal(schoolDisplayName(''), '');
  // A leading separator means there is no name to keep; leave the value untouched.
  assert.equal(schoolDisplayName(' · 주소만'), ' · 주소만');
  // Split at the last separator so a name containing " · " survives.
  assert.equal(schoolDisplayName('가 · 나고등학교 · 서울특별시'), '가 · 나고등학교');
});

const props = (data: Record<string, unknown>) =>
  ({
    data: {
      posts: [],
      cheers: [],
      attempts: [],
      questions: [],
      essays: [],
      subjects: [],
      cards: [],
      ...data,
    },
    navigate() {},
    back() {},
    refresh: async () => {},
    toast() {},
    path: '/profile',
  }) as unknown as ScreenProps;

const studentProps = () =>
  props({
    profile: {
      id: 'me',
      name: '이름',
      nickname: '학습자',
      role: 'STUDENT',
      school: IDENTITY,
      grade: '고2',
      streak: 0,
      points: 0,
      privacy: { accuracy: false, time: false, wrongNotes: false },
      completedSubjects: [],
    },
  });

test('the profile header shows school name and grade, never the address', () => {
  const html = renderToStaticMarkup(createElement(Account, studentProps()));
  assert.match(html, /서울제2고등학교 · 고2/);
  assert.doesNotMatch(html, /테헤란로|강남구/);
});

test('the linked-child card shows the child school name only', () => {
  const html = renderToStaticMarkup(
    createElement(
      Account,
      props({
        profile: {
          id: 'p1',
          name: '학부모',
          nickname: '학부모',
          role: 'PARENT',
          school: '',
          grade: '',
          streak: 0,
          points: 0,
          privacy: { accuracy: false, time: false, wrongNotes: false },
          completedSubjects: [],
        },
        child: {
          id: 'c1',
          name: '자녀',
          school: CHILD_IDENTITY,
          grade: '고1',
          privacy: {},
        },
      }),
    ),
  );
  assert.match(html, /가락고등학교 · 고1/);
  assert.doesNotMatch(html, /올림픽로|송파구/);
});

test('the community profile page shows the school name only', () => {
  const html = renderToStaticMarkup(createElement(CommunityProfile, studentProps()));
  assert.match(html, /서울제2고등학교/);
  assert.doesNotMatch(html, /테헤란로|강남구/);
});

const socialSource = (file: string) =>
  readFileSync(new URL(`../src/components/social/${file}`, import.meta.url), 'utf8');

test('no stored school identity renders verbatim in social screens', () => {
  for (const file of [
    'account.tsx',
    'community.tsx',
    'community-navigation.tsx',
    'community-editor-settings.tsx',
    'parent.tsx',
  ]) {
    const code = socialSource(file);
    assert.doesNotMatch(
      code,
      /\{[^{}]*\b(?:data|child|post|profile)\.school\}/,
      `${file} renders a stored school string verbatim`,
    );
    assert.doesNotMatch(
      code,
      /\$\{[^{}]*\b(?:data|child|post|profile)\.school\}/,
      `${file} interpolates a stored school string verbatim`,
    );
  }
});

test('the profile editor shows the name but saves the scoping identity', () => {
  const code = socialSource('account.tsx');
  // The input is initialized from the display name, not the stored identity.
  assert.match(code, /school: schoolDisplayName\(data\.profile\.school\)/);
  // Picking a directory result stores the "이름 · 주소" identity for PATCH /profile.
  assert.match(code, /setSchoolSaved\(`\$\{s\.name\} · \$\{s\.address\}`\)/);
  assert.match(code, /school: schoolSaved/);
});
