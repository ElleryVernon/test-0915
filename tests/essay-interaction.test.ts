import test from 'node:test';
import assert from 'node:assert/strict';
import {
  essaySelection,
  toggleEssayKeyword,
  appendEssayOrder,
  restartEssayOrder,
  completeEssayOutline,
  essayPracticeStart,
} from '../src/lib/essay-interaction';
import { exactKeywords, exactOrder } from '../src/components/study/logic';
const correct = ['혈당량', '인슐린', '포도당 흡수', '글리코젠 합성'];
const choices = [...correct, '혈액 응고', '체온 상승', '항원', '글루카곤 증가'];

test('four-of-eight selection rejects a fifth choice but allows removing and replacing one', () => {
  let selected: string[] = [];
  for (const word of correct)
    selected = toggleEssayKeyword(selected, word, choices, correct.length);
  assert.deepEqual(toggleEssayKeyword(selected, choices[4], choices, 4), selected);
  selected = toggleEssayKeyword(selected, correct[1], choices, 4);
  assert.equal(selected.length, 3);
  selected = toggleEssayKeyword(selected, choices[4], choices, 4);
  assert.equal(selected.length, 4);
  assert.equal(exactKeywords(selected, correct), false);
  selected = toggleEssayKeyword(selected, choices[4], choices, 4);
  selected = toggleEssayKeyword(selected, correct[1], choices, 4);
  assert.equal(exactKeywords(selected, correct), true);
});

test('repeated and rapid selection transitions never exceed the required count', () => {
  let selected: string[] = [];
  for (let i = 0; i < 100; i++) {
    selected = toggleEssayKeyword(selected, choices[i % choices.length], choices, 4);
    assert.ok(selected.length <= 4);
    assert.equal(new Set(selected).size, selected.length);
  }
});

test('old oversized or malformed drafts cannot bypass the selection limit', () => {
  assert.deepEqual(essaySelection([...choices, 'unknown', correct[0]], choices, 4), correct);
  assert.deepEqual(essaySelection(['unknown', correct[0], correct[0]], choices, 4), [correct[0]]);
  assert.deepEqual(toggleEssayKeyword([], 'unknown', choices, 4), []);
  assert.deepEqual(essaySelection(choices, choices, 0), []);
});

test('only a complete correct selection passes, not a partial set or all eight choices', () => {
  assert.equal(exactKeywords(correct.slice(0, 3), correct), false);
  assert.equal(exactKeywords(choices, correct), false);
  assert.equal(exactKeywords([...correct].reverse(), correct), true);
});

test('tap ordering starts empty and adds each available keyword once', () => {
  let order: string[] = [];
  assert.equal(exactOrder(order, correct), false);
  for (const word of correct) {
    order = appendEssayOrder(order, word, correct);
    assert.deepEqual(
      appendEssayOrder(order, word, correct),
      order,
      'double-tap cannot duplicate a word',
    );
  }
  assert.equal(exactOrder(order, correct), true);
  assert.deepEqual(appendEssayOrder(order, '항원', correct), correct);
});

test('alternative writing order is accepted and editing preserves the chosen prefix', () => {
  let order = [correct[0], correct[2], correct[1], correct[3]];
  assert.equal(exactOrder(order, correct), false);
  assert.equal(completeEssayOutline(order, correct), true);
  order = restartEssayOrder(order, 1);
  assert.deepEqual(order, [correct[0]]);
  for (const word of correct.slice(1)) order = appendEssayOrder(order, word, correct);
  assert.equal(exactOrder(order, correct), true);
  assert.equal(completeEssayOutline(order, correct), true);
});

test('undo and restart produce an editable partial sequence, never an automatic pass', () => {
  assert.deepEqual(restartEssayOrder(correct, 3), correct.slice(0, 3));
  assert.deepEqual(restartEssayOrder(correct, 0), []);
  assert.equal(exactOrder(restartEssayOrder(correct, 3), correct), false);
  assert.equal(completeEssayOutline(correct.slice(0, 3), correct), false);
  assert.equal(
    completeEssayOutline([correct[0], correct[0], correct[2], correct[3]], correct),
    false,
  );
});

test('new attempts open a blank answer without mandatory pre-exercises', () => {
  assert.deepEqual(essayPracticeStart(), { stage: 4, guided: false, answer: '' });
});
test('drafts restore the optional help mode, including compatible older drafts', () => {
  assert.deepEqual(essayPracticeStart({ stage: 2, answer: '작성 중' }), {
    stage: 2,
    guided: true,
    answer: '작성 중',
  });
  assert.deepEqual(essayPracticeStart({ stage: 4, guided: true, answer: '연습 후 작성' }), {
    stage: 4,
    guided: true,
    answer: '연습 후 작성',
  });
  assert.deepEqual(essayPracticeStart({ stage: 4, guided: false, answer: '혼자 작성' }), {
    stage: 4,
    guided: false,
    answer: '혼자 작성',
  });
});

test('explicit revision prefills the prior answer, but a newer draft takes precedence', () => {
  assert.equal(essayPracticeStart(undefined, '지난 답안').answer, '지난 답안');
  assert.equal(
    essayPracticeStart({ stage: 4, answer: '고치는 중' }, '지난 답안').answer,
    '고치는 중',
  );
});
