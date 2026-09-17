import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { essayMeaningUnits, essayStructure } from '../src/lib/essay-structure';
import {
  EssayAnswerChunks,
  EssayKeywordOptions,
  EssayStructure,
} from '../src/components/study/essay-structure';

test('meaning units preserve every source character other than boundary whitespace', () => {
  const text =
    '혈당량이 높아지면 인슐린이 분비된다. 인슐린은 포도당 흡수를 촉진한다.\n\n혈당량이 낮아진다.';
  const units = essayMeaningUnits(text);
  assert.equal(units.length, 3);
  assert.equal(units.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
  assert.deepEqual(essayMeaningUnits(''), []);
  assert.deepEqual(essayMeaningUnits('문장 부호 없이 쓴 답안'), ['문장 부호 없이 쓴 답안']);
});

test('sentence boundaries do not split decimal numbers and preserve quoted text', () => {
  const text = '측정값은 3.14이다. "정확한 값"을 사용한다.';
  const units = essayMeaningUnits(text);
  assert.equal(units.length, 2);
  assert.equal(units[0], '측정값은 3.14이다.');
  assert.equal(units[1], '"정확한 값"을 사용한다.');
});

test('structure is verbatim model answer order and associates only present keywords', () => {
  const text = '인슐린이 분비된다. 포도당흡수가 증가한다.';
  const result = essayStructure(text, '다른 자료 근거', [
    '인슐린',
    '포도당 흡수',
    '글루카곤',
    '인슐린',
  ]);
  assert.equal(result.source, 'modelAnswer');
  assert.deepEqual(result.units, [
    { text: '인슐린이 분비된다.', keywords: ['인슐린'] },
    { text: '포도당흡수가 증가한다.', keywords: ['포도당 흡수'] },
  ]);
  assert.ok(!JSON.stringify(result).includes('글루카곤'));
  assert.ok(!JSON.stringify(result).includes('다른 자료 근거'));
});

test('absent model answer falls back to actual citation, and absent evidence stays empty', () => {
  const result = essayStructure('  ', '자료에 있는 설명이다.', ['없는 키워드']);
  assert.equal(result.source, 'citation');
  assert.deepEqual(result.units, [{ text: '자료에 있는 설명이다.', keywords: [] }]);
  assert.deepEqual(essayStructure('', '', ['임의 내용']).units, []);
});

test('checked keywords remain readable with text and icons rather than color alone', () => {
  const markup = renderToStaticMarkup(
    createElement(EssayKeywordOptions, {
      choices: ['맞는 선택', '놓친 선택', '틀린 선택', '그 외'],
      correct: ['맞는 선택', '놓친 선택'],
      selected: ['맞는 선택', '틀린 선택'],
      checked: true,
      onSelect: () => {},
    }),
  );
  assert.match(markup, /data-state="correct"/);
  assert.match(markup, /data-state="incorrect"/);
  assert.match(markup, /data-state="missed"/);
  assert.match(markup, />오답<|오답<\/span>/);
  assert.match(markup, /놓친 정답/);
  assert.match(markup, /data-icon="X"/);
  assert.equal((markup.match(/disabled=""/g) || []).length, 4);
});

test('unsubmitted keyword markup contains no leaked correctness labels', () => {
  const markup = renderToStaticMarkup(
    createElement(EssayKeywordOptions, {
      choices: ['A', 'B'],
      correct: ['A'],
      selected: ['B'],
      checked: false,
      onSelect: () => {},
    }),
  );
  assert.doesNotMatch(
    markup,
    /정답|오답|data-state="correct"|data-state="incorrect"|data-state="missed"/,
  );
  assert.match(markup, /data-state="selected"/);
  assert.equal((markup.match(/disabled=""/g) || []).length, 1);
});

test('reading units are separate paragraphs and HTML content is safely escaped', () => {
  const markup = renderToStaticMarkup(
    createElement(EssayAnswerChunks, {
      text: '첫 문장이다. 두 문장이다.\n<script>alert(1)</script>',
    }),
  );
  assert.equal((markup.match(/<p>/g) || []).length, 3);
  assert.doesNotMatch(markup, /<script>/);
});

test('diagram identifies explanation sequence and does not claim inferred causality', () => {
  const markup = renderToStaticMarkup(
    createElement(EssayStructure, {
      modelAnswer: '이유를 설명한다. 결과를 확인한다.',
      citation: '다른 근거',
      keywords: ['이유', '결과'],
    }),
  );
  assert.match(markup, /aria-label="서술형 구조도"/);
  assert.match(markup, /다음 설명/);
  assert.match(markup, /인과관계를 뜻하지 않아요/);
  assert.equal((markup.match(/<li>/g) || []).length, 2);
  assert.doesNotMatch(markup, /다른 근거/);
});
