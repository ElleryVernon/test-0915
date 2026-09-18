import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The search screen's idle section used to render only the "내 과목에서 찾기" title with
// nothing under it when the account has no subjects — dead space on a brand-new account.
const app = readFileSync(new URL('../src/components/app.tsx', import.meta.url), 'utf8');

test('empty subjects on the search screen show a create-subject CTA, not a blank section', () => {
  assert.match(app, /data\.subjects\.length \?/);
  assert.match(app, /아직 만든 과목이 없어요/);
  assert.match(app, /navigate\('\/subjects'\)/);
});
