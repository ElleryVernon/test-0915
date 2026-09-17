import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generationSourcePayload, generatedMaterialId } from '../src/lib/generation-sources';

test('source sets are order-independent but retain destination and topic while preserving legacy tasks', () => {
  assert.deepEqual(generationSourcePayload(['one'], 'bio'), { materialId: 'one' });
  assert.deepEqual(generationSourcePayload(['two', 'one', 'two'], 'bio', ' 전도 '), {
    materialIds: ['one', 'two'],
    subjectId: 'bio',
    topic: '전도',
  });
  assert.notDeepEqual(
    generationSourcePayload(['one', 'two'], 'bio', '전도'),
    generationSourcePayload(['one', 'three'], 'bio', '전도'),
  );
  assert.notDeepEqual(
    generationSourcePayload(['one', 'two'], 'bio', '전도'),
    generationSourcePayload(['one', 'two'], 'bio', '호르몬'),
  );
});
test('result navigation uses the server combined material, never just the first selected source', () => {
  assert.equal(
    generatedMaterialId([
      { id: 'q1', materialId: 'combined-id' },
      { id: 'q2', materialId: 'combined-id' },
    ]),
    'combined-id',
  );
  assert.equal(generatedMaterialId(null), null);
  assert.equal(generatedMaterialId([]), null);
});
