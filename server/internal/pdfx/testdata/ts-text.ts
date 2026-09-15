// Writes the TypeScript extractor's text for a fixture, the parity reference for the Go port.
// Run from the repository root: `npx tsx server/internal/pdfx/testdata/ts-text.ts [fixture] [out]`
// (defaults: document -> server/internal/pdfx/testdata/document.ts.txt). Prints a summary as JSON.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdf } from '../../../testdata/reference/pdf-extract';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const name = process.argv[2] ?? 'document';
const out = process.argv[3] ?? join(here, `${name}.ts.txt`);
const data = new Uint8Array(readFileSync(join(root, 'tests/fixtures/pdf', `${name}.pdf`)));
const result = await extractPdf(data);
writeFileSync(out, result.text);
console.log(
  JSON.stringify({
    fixture: name,
    out,
    pages: result.pages,
    method: result.method,
    warning: result.warning ?? null,
    pageBreaks: result.pageBreaks,
    textLength: result.text.length,
    images: result.images.map((image) => ({
      page: image.page,
      order: image.order,
      paragraph: image.paragraph,
      anchor: image.anchor,
      box: image.box,
      width: image.width,
      height: image.height,
      context: image.context,
      bytes: image.data.length,
    })),
  }),
);
