// Copies one real upload out of the local development database for the parity test (gate X2):
// the PDF bytes, the text the TypeScript extractor stored for it and where it placed the images.
// Read-only: only SELECT statements, only against the local database, and the copy goes to the
// git-ignored .unlazy/memoryz-cloud/sample directory. Run from anywhere with Node 20+.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const require = createRequire(join(root, 'package.json'));
const { Client } = require('pg');

const UPLOAD_ID = 'ff43b24c-5f90-4b5c-ac49-7d3aff7aabf5';
const OUT = join(root, '.unlazy/memoryz-cloud/sample');

function databaseUrl() {
  const env = readFileSync(join(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value;
  }
  throw new Error('DATABASE_URL not found in .env');
}

const url = new URL(databaseUrl());
if (url.hostname !== '127.0.0.1' || url.port !== '15444' || url.pathname !== '/memoryz') {
  console.error(`refusing to read ${url.hostname}:${url.port}${url.pathname}: only 127.0.0.1:15444/memoryz is allowed`);
  process.exit(2);
}

const client = new Client({ connectionString: url.toString() });
await client.connect();
try {
  const blob = await client.query('SELECT data FROM "UploadBlob" WHERE "uploadId" = $1', [UPLOAD_ID]);
  const material = await client.query('SELECT content, "pageBreaks" FROM "Material" WHERE "uploadId" = $1', [UPLOAD_ID]);
  const images = await client.query(
    'SELECT page, "order", paragraph, anchor, context, width, height FROM "UploadImage" WHERE "uploadId" = $1 ORDER BY page, "order"',
    [UPLOAD_ID],
  );
  if (blob.rowCount !== 1) throw new Error(`upload ${UPLOAD_ID}: ${blob.rowCount} blobs`);
  if (material.rowCount !== 1) throw new Error(`upload ${UPLOAD_ID}: ${material.rowCount} materials`);
  const pdf = blob.rows[0].data;
  if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('blob is not a PDF');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'sample.pdf'), pdf);
  writeFileSync(join(OUT, 'sample.ts.txt'), material.rows[0].content);
  writeFileSync(join(OUT, 'sample.ts.json'), JSON.stringify({ pageBreaks: material.rows[0].pageBreaks, images: images.rows }, null, 1));
  console.log(
    `SAMPLE_EXPORT_OK pdf=${pdf.length} text=${material.rows[0].content.length} pageBreaks=${material.rows[0].pageBreaks.length} images=${images.rowCount} dir=${OUT}`,
  );
} finally {
  await client.end();
}
