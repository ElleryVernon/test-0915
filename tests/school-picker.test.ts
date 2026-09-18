import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Highlighted, SCHOOL_REGIONS } from '../src/components/onboarding';

const onboardingSource = readFileSync('src/components/onboarding.tsx', 'utf8');
const pickerCss = readFileSync('src/components/onboarding.module.css', 'utf8');
const checkSource = readFileSync('scripts/keyboard-browser-check.ts', 'utf8');
const directory = JSON.parse(readFileSync('server/internal/schools/directory.json', 'utf8')) as {
  id: string;
  name: string;
  address: string;
  province: string;
}[];

// Mirrors schools.Search: every whitespace-separated word must appear in name+address.
function directoryMatches(q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return directory.filter((s) => {
    const text = `${s.name} ${s.address}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

test('every region chip query matches real schools in the directory', () => {
  assert.equal(SCHOOL_REGIONS.length, 17, 'expected 17 시·도 chips');
  for (const { label, q } of SCHOOL_REGIONS) {
    const matches = directoryMatches(q);
    assert.ok(
      matches.length >= 5,
      `region "${label}" query "${q}" matched only ${matches.length} schools`,
    );
  }
});

test('region chip labels are short forms that still resolve through their query', () => {
  const map = Object.fromEntries(SCHOOL_REGIONS.map((r) => [r.label, r.q]));
  // Short labels where the full province name is needed to match address text.
  assert.equal(map['충북'], '충청북도');
  assert.equal(map['충남'], '충청남도');
  assert.equal(map['경북'], '경상북도');
  assert.equal(map['경남'], '경상남도');
});

test('Highlighted wraps each query word in a mark and leaves the rest untouched', () => {
  const html = renderToStaticMarkup(
    createElement(Highlighted, { text: '서울제2고등학교', query: '서울' }),
  );
  assert.equal(html, '<mark>서울</mark>제2고등학교');
  const multi = renderToStaticMarkup(
    createElement(Highlighted, { text: '서울특별시 강남구 테헤란로 101', query: '서울 강남' }),
  );
  assert.equal(multi, '<mark>서울</mark>특별시 <mark>강남</mark>구 테헤란로 101');
  // No query → plain text, no mark.
  const plain = renderToStaticMarkup(createElement(Highlighted, { text: '가락고', query: ' ' }));
  assert.equal(plain, '가락고');
});

test('the picker renders production content: regions, recents, browse, skeleton, rich rows', () => {
  for (const marker of [
    '지역으로 빠르게 찾기',
    '최근에 선택한 학교',
    '전국 고등학교',
    'data-results-list',
    'data-browse-list',
    'schoolSkeleton',
    'schoolRegions',
    'schoolEmpty',
    'RECENT_SCHOOLS_KEY',
  ]) {
    assert.ok(onboardingSource.includes(marker), `onboarding.tsx missing ${marker}`);
  }
  // Selecting a school persists it to recents and closes the picker.
  assert.match(onboardingSource, /localStorage\.setItem\(RECENT_SCHOOLS_KEY/);
  assert.match(onboardingSource, /localStorage\.getItem\(RECENT_SCHOOLS_KEY\)/);
  // Result rows render highlighted name + address inside a shared row builder.
  assert.match(onboardingSource, /renderSchoolRow\(s, schoolSearch\)/);
  assert.match(onboardingSource, /<Highlighted text=\{s\.name\}/);
  assert.match(onboardingSource, /<Highlighted text=\{s\.address\}/);
});

test('picker styles cover the new UI: chips, row badge, skeleton, empty, marks', () => {
  for (const selector of [
    '.schoolRegions',
    '.schoolRowIcon',
    '.schoolRowText',
    '.schoolSkeleton',
    '.skeletonIcon',
    '.schoolEmpty',
    '.schoolResults mark',
    '.schoolSection',
    '@keyframes schoolPulse',
  ]) {
    assert.ok(pickerCss.includes(selector), `onboarding.module.css missing ${selector}`);
  }
});

test('the browser check targets the results list, not idle lists', () => {
  assert.ok(!checkSource.includes('[data-school-results] ul li button'));
  assert.ok(checkSource.includes('[data-results-list] li button'));
  assert.ok(checkSource.includes('[data-browse-list] li button'));
});
