import test from 'node:test';
import assert from 'node:assert/strict';
import {
  permittedAttachmentTypes,
  initialAttachmentRoute,
  attachmentCapacity,
  updateExcerptRange,
  pollInputError,
  createAttachmentRequestGuard,
  insertMathSymbol,
} from '../src/lib/attachment-workflow';
import { excerptSelection } from '../src/components/social/community-blocks';

test('direct toolbar tools open only a permitted tool; generic entry opens the menu', () => {
  const permitted = permittedAttachmentTypes('STUDENT', false, [
    'ESSAY',
    'POLL',
    'SCHEDULE',
    'MATH',
  ]);
  assert.deepEqual(initialAttachmentRoute(permitted), { type: null, preview: false });
  assert.deepEqual(initialAttachmentRoute(permitted, 'POLL'), { type: 'POLL', preview: false });
  assert.deepEqual(initialAttachmentRoute(permitted, 'PHOTO'), { type: null, preview: false });
});
test('parent, comment and caller restrictions intersect, including photo fallback', () => {
  assert.deepEqual(permittedAttachmentTypes('PARENT', false, ['QUESTION', 'PHOTO', 'POLL']), [
    'PHOTO',
    'POLL',
  ]);
  assert.deepEqual(permittedAttachmentTypes('PARENT', true, ['MATH', 'POLL']), []);
  assert.deepEqual(
    permittedAttachmentTypes('STUDENT', true, ['MATERIAL', 'PHOTO', 'SCHEDULE', 'MATH']),
    ['PHOTO', 'MATH'],
  );
  assert.equal(permittedAttachmentTypes('STUDENT', false, ['MATERIAL']).includes('PHOTO'), false);
});
test('post, DM, comment capacities and photo limit are enforced at confirmation', () => {
  for (const remaining of [5, 3, 1])
    assert.equal(attachmentCapacity('QUESTION', remaining, 4), true);
  for (const remaining of [0, -1]) {
    assert.equal(attachmentCapacity('QUESTION', remaining, 0), false);
    assert.equal(attachmentCapacity('PHOTO', remaining, 0), false);
  }
  assert.equal(attachmentCapacity('PHOTO', 1, 3), true);
  assert.equal(attachmentCapacity('PHOTO', 1, 4), false);
});
test('excerpt grows at either end; removing an end preserves an exact source excerpt', () => {
  const source = '첫 문장이에요.\n둘째 문장이에요. 셋째 문장이에요. 넷째 문장이에요.';
  const first = updateExcerptRange([], 1, true);
  const before = updateExcerptRange(first.indices, 0, true);
  const after = updateExcerptRange(before.indices, 2, true);
  assert.deepEqual(after, { indices: [0, 1, 2], error: '' });
  const shortened = updateExcerptRange(after.indices, 0, false);
  assert.equal(excerptSelection(source, shortened.indices), '둘째 문장이에요. 셋째 문장이에요.');
});
test('disjoint, middle removal and fourth sentence cannot silently replace an excerpt', () => {
  const selection = [1, 2, 3];
  for (const [index, checked] of [
    [5, true],
    [2, false],
    [4, true],
  ] as const) {
    const result = updateExcerptRange(selection, index, checked);
    assert.deepEqual(result.indices, selection);
    assert.ok(result.error);
  }
  assert.deepEqual(selection, [1, 2, 3]);
  assert.deepEqual(updateExcerptRange([], 5, true), { indices: [5], error: '' });
});
test('invalid poll input stays actionable and duplicate options ignore surrounding space', () => {
  assert.match(pollInputError('', ['국어', '수학']), /질문/);
  assert.match(pollInputError('어느 과목?', ['국어', '']), /모두/);
  assert.match(pollInputError('어느 과목?', ['국어', ' 국어 ']), /다르게/);
  assert.match(pollInputError('어느 과목?', ['국어', '수학', '영어', '한국사', '화학']), /2~4/);
  assert.equal(pollInputError('어느 과목?', ['국어', '수학']), '');
});
test('late material completion after cancellation cannot apply to a reopened picker', async () => {
  const guard = createAttachmentRequestGuard();
  const closedRequest = guard.start();
  const oldResponse = Promise.resolve('old material');
  guard.cancel();
  const newRequest = guard.start();
  const result = await oldResponse;
  assert.equal(result, 'old material');
  assert.equal(guard.isCurrent(closedRequest), false);
  assert.equal(guard.isCurrent(newRequest), true);
  guard.cancel();
  assert.equal(guard.isCurrent(newRequest), false);
});
test('math symbols insert at the caret or replace selection without exceeding the limit', () => {
  assert.deepEqual(insertMathSymbol('x + y', 1, 1, '²'), { value: 'x² + y', caret: 2 });
  assert.deepEqual(insertMathSymbol('x + y', 0, 1, '√(x)'), { value: '√(x) + y', caret: 4 });
  assert.equal(insertMathSymbol('x'.repeat(2000), 2000, 2000, '²').value.length, 2000);
});
