import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  QuickJudgment,
  judgmentNote,
  type EssayJudgment,
} from '../src/components/study/essay-judgment';

const keywords = ['활성 부위', '가역적 경쟁', '겉보기 Km 증가', 'Vmax 불변'];
const partial: EssayJudgment = {
  matched: ['활성 부위', '가역적 경쟁'],
  missing: ['겉보기 Km 증가', 'Vmax 불변'],
  provisional: 50,
  answerType: 'partial',
  injection: 0.02,
  model: 'jev-1.13.0',
  durationMs: 270,
};

test('the quick verdict marks explained keywords and frames itself as a preview of the grade', () => {
  const html = renderToStaticMarkup(
    createElement(QuickJudgment, { judgment: partial, keywords, pending: false }),
  );
  assert.match(html, /먼저 확인한 핵심 개념/);
  assert.equal((html.match(/data-explained="true"/g) || []).length, 2);
  assert.equal((html.match(/data-explained="false"/g) || []).length, 2);
  assert.match(html, /핵심 개념 2개를 설명했어요\. 점수와 코칭은 곧 도착해요\./);
  for (const keyword of keywords) assert.ok(html.includes(keyword), keyword);
});

test('while the verdict is pending the block says so, and without a verdict it renders nothing', () => {
  const pending = renderToStaticMarkup(
    createElement(QuickJudgment, { judgment: null, keywords, pending: true }),
  );
  assert.match(pending, /핵심 개념을 확인하고 있어요/);
  assert.equal(
    renderToStaticMarkup(
      createElement(QuickJudgment, { judgment: null, keywords, pending: false }),
    ),
    '',
  );
});

test('the note distinguishes complete, empty and instruction-like answers', () => {
  assert.match(judgmentNote({ ...partial, matched: keywords, missing: [] }), /모두 다뤘어요/);
  assert.match(judgmentNote({ ...partial, matched: [], missing: keywords }), /보이지 않아요/);
  assert.match(judgmentNote({ ...partial, injection: 0.98 }), /채점 지시로 보여요/);
});
