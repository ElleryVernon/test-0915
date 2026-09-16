import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IconButton } from '../src/components/ui';
import {
  readCommunityDraft,
  saveCommunityDraft,
  clearCommunityDraft,
} from '../src/lib/community-draft';
import type { CommunityDraft } from '../src/lib/community-types';

test('community drafts isolate users and study sources, expire at seven days and survive storage errors', () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    },
  });
  try {
    const draft: CommunityDraft = {
      requestId: 'draft',
      title: '질문',
      body: '초안',
      category: '질문',
      anonymous: true,
      blocks: [],
      tags: {},
      scope: 'all',
      updatedAt: '2026-09-16T00:00:00Z',
    };
    const now = Date.parse(draft.updatedAt);
    assert.equal(saveCommunityDraft('a', draft), true);
    saveCommunityDraft('a:WRONGNOTE:q', { ...draft, title: '학습 질문' });
    assert.equal(readCommunityDraft('a', now)?.title, '질문');
    assert.equal(readCommunityDraft('a:WRONGNOTE:q', now)?.title, '학습 질문');
    assert.equal(readCommunityDraft('b', now), null);
    assert.equal(readCommunityDraft('a', now + 7 * 86400000 + 1), null);
    assert.equal(readCommunityDraft('a:WRONGNOTE:q', now)?.title, '학습 질문');
    clearCommunityDraft('a:WRONGNOTE:q');
    assert.equal(readCommunityDraft('a:WRONGNOTE:q', now), null);
    values.set('memoryz.community.draft.v3.a', JSON.stringify({ ...draft, title: { bad: true } }));
    assert.equal(readCommunityDraft('a', now), null);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('unavailable');
      },
    });
    assert.equal(saveCommunityDraft('a', draft), false);
    assert.equal(readCommunityDraft('a', now), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('attachment and cancel icon buttons cannot accidentally submit a form', () => {
  const html = renderToStaticMarkup(createElement(IconButton, { label: '첨부 제거' }, '×'));
  assert.match(html, /type="button"/);
  const submit = renderToStaticMarkup(
    createElement(IconButton, { label: '등록', type: 'submit' }, '등록'),
  );
  assert.match(submit, /type="submit"/);
});
