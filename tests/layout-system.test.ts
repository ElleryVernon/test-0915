import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
const rawSpacing =
  /(?:^|[;{\n])\s*(?:gap|row-gap|column-gap|padding(?:-[\w-]+)?|margin(?:-[\w-]+)?)\s*:[^;{}]*\b\d+(?:\.\d+)?px/g;
test('raw spacing guard catches a new local override and accepts shared tokens', () => {
  assert.match('.card { padding: 19px; gap: 13px; }', rawSpacing);
  assert.doesNotMatch('.card { padding: var(--panel-inset); gap: var(--gap-block); }', rawSpacing);
});
test('all screen CSS derives spacing from the central scale', () => {
  for (const file of files('src').filter((path) => path.endsWith('.css'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), rawSpacing, file);
  }
});
test('screen JSX does not bypass shared spacing with arbitrary Tailwind values', () => {
  for (const file of files('src/components').filter((path) => path.endsWith('.tsx'))) {
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /\b(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-\[/,
      file,
    );
  }
});
