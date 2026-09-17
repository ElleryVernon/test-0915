import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Material, Subject } from '../src/lib/contracts';
import { generationDefault, materialChoices, sortedMaterials } from '../src/lib/study-library';

const materials = [
  {
    id: 'old',
    title: '수업 2',
    subjectId: 'bio',
    createdAt: '2026-01-01T01:00:00Z',
    contentLength: 100,
  },
  {
    id: 'new',
    title: '수업 10',
    subjectId: 'math',
    createdAt: '2026-02-01T01:00:00Z',
    contentLength: 100,
  },
  {
    id: 'short',
    title: '수업 1',
    subjectId: 'bio',
    createdAt: '2026-03-01T01:00:00Z',
    contentLength: 5,
  },
] as Material[];
const subjects = [
  { id: 'bio', name: '생명과학' },
  { id: 'math', name: '수학' },
] as Subject[];

test('source order is explicit, stable and independent of bootstrap array order', () => {
  assert.deepEqual(
    sortedMaterials(materials).map((m) => m.id),
    ['short', 'new', 'old'],
  );
  assert.deepEqual(
    sortedMaterials([...materials].reverse()).map((m) => m.id),
    ['short', 'new', 'old'],
  );
  assert.deepEqual(
    sortedMaterials(materials, 'name').map((m) => m.id),
    ['short', 'old', 'new'],
  );
  assert.deepEqual(
    materials.map((m) => m.id),
    ['old', 'new', 'short'],
  );
  const tied = [
    { ...materials[0], id: 'b' },
    { ...materials[0], id: 'a' },
  ];
  assert.deepEqual(
    sortedMaterials(tied).map((m) => m.id),
    ['a', 'b'],
  );
});
test('contextual material wins; generic entry skips insufficient sources, never chooses missing data', () => {
  assert.equal(generationDefault(materials, 'old'), 'old');
  assert.equal(generationDefault(materials, 'missing'), '');
  assert.equal(generationDefault(materials, ''), '');
  assert.equal(generationDefault([materials[2]], ''), '');
  assert.equal(generationDefault([], ''), '');
  assert.equal(
    generationDefault(materials, 'short'),
    'short',
    'explicit short source remains available to repair',
  );
});
test('search and subject filters intersect without hiding selected state or silently changing scope', () => {
  assert.deepEqual(
    materialChoices(materials, subjects, '수업', 'bio', 'recent').map((m) => m.id),
    ['short', 'old'],
  );
  assert.deepEqual(
    materialChoices(materials, subjects, ' 생명과학 ', '', 'name').map((m) => m.id),
    ['short', 'old'],
  );
  assert.equal(materialChoices(materials, subjects, '수학', 'bio', 'recent').length, 0);
  assert.equal(materialChoices(materials, subjects, '없는자료', '', 'recent').length, 0);
});
