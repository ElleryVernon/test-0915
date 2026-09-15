// The upload-storage migration: one new migration adds the blob and image tables, the extraction columns
// and the material→upload link; its backfill links materials to their own uploads only; the migrations
// alone rebuild the schema (with a control that drops this migration); the local database is current.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { localState, migrationsWithout, rebuild, withScratchDatabase } from './lib/migrate-check.mjs';

const BASE = 'ce2dedc';
const MIGRATION = '20260915040000_upload_storage';
const problems = [];

const before = new Set(
  execFileSync('git', ['ls-tree', '--name-only', `${BASE}:prisma/migrations`], { encoding: 'utf8' }).split('\n').filter(Boolean),
);
const added = readdirSync('prisma/migrations').filter((name) => !before.has(name));
if (added.join() !== MIGRATION) problems.push(`new migrations since ${BASE}: ${added.join(', ') || '(none)'}`);
const sql = existsSync(`prisma/migrations/${MIGRATION}/migration.sql`) ? readFileSync(`prisma/migrations/${MIGRATION}/migration.sql`, 'utf8') : '';
for (const needle of [
  'CREATE TABLE "UploadBlob"',
  'CREATE TABLE "UploadImage"',
  'CREATE UNIQUE INDEX "Material_uploadId_key"',
  'ON DELETE SET NULL',
  'ALTER TABLE "UploadBlob" ALTER COLUMN "data" SET STORAGE EXTERNAL',
])
  if (!sql.includes(needle)) problems.push(`migration lacks ${needle}`);
if (sql.indexOf('UPDATE "Material"') < 0 || sql.indexOf('UPDATE "Material"') > sql.indexOf('CREATE UNIQUE INDEX "Material_uploadId_key"'))
  problems.push('the backfill must run before the unique index');
const removed = execFileSync('git', ['diff', '--unified=0', BASE, '--', 'prisma/schema.prisma'], { encoding: 'utf8' })
  .split('\n')
  .filter((l) => /^-[^-]/.test(l));
if (removed.length) problems.push(`schema lines removed: ${removed.join(' | ')}`);

// The backfill links a material to the upload its url names, and never to someone else's upload.
const beforeDir = migrationsWithout([MIGRATION], 'before-upload-storage');
let backfill = null;
try {
  backfill = await withScratchDatabase(async ({ prisma, client }) => {
    const first = prisma(['migrate', 'deploy'], beforeDir);
    if (first.status !== 0) throw new Error(`deploy before: ${first.stderr}`);
    const q = (text, values) => client.query(text, values);
    for (const id of ['owner', 'stranger']) await q(`INSERT INTO "User" ("id","name","nickname","role") VALUES ($1,$1,$1,'STUDENT')`, [id]);
    await q(`INSERT INTO "Subject" ("id","userId","name") VALUES ('s','owner','과목')`);
    await q(`INSERT INTO "Upload" ("id","userId","mime","name","size") VALUES ('aaaaaaaa-0000-0000-0000-000000000001','owner','application/pdf','a.pdf',1),('bbbbbbbb-0000-0000-0000-000000000002','stranger','application/pdf','b.pdf',1)`);
    await q(`INSERT INTO "Material" ("id","userId","subjectId","title","content","type","url") VALUES
      ('mine','owner','s','내 자료','본문','PDF','/api/uploads/aaaaaaaa-0000-0000-0000-000000000001'),
      ('theirs','owner','s','남의 업로드','본문','PDF','/api/uploads/bbbbbbbb-0000-0000-0000-000000000002'),
      ('plain','owner','s','글 자료','본문','TXT',NULL)`);
    const second = prisma(['migrate', 'deploy']);
    if (second.status !== 0) throw new Error(`deploy after: ${second.stderr}`);
    const rows = (await q(`SELECT "id","uploadId","pageBreaks" FROM "Material" ORDER BY "id"`)).rows;
    return Object.fromEntries(rows.map((r) => [r.id, { uploadId: r.uploadId, pageBreaks: r.pageBreaks }]));
  });
} finally {
  rmSync(beforeDir, { recursive: true, force: true });
}
if (backfill?.mine?.uploadId !== 'aaaaaaaa-0000-0000-0000-000000000001') problems.push(`own upload not linked: ${JSON.stringify(backfill?.mine)}`);
if (backfill?.theirs?.uploadId !== null) problems.push(`linked to another account's upload: ${JSON.stringify(backfill?.theirs)}`);
if (backfill?.plain?.uploadId !== null || JSON.stringify(backfill?.plain?.pageBreaks) !== '[]') problems.push(`plain material changed: ${JSON.stringify(backfill?.plain)}`);

const rebuilt = await rebuild('prisma/migrations');
const withoutDir = migrationsWithout([MIGRATION], 'without-upload-storage');
let control;
try {
  control = await rebuild(withoutDir);
} finally {
  rmSync(withoutDir, { recursive: true, force: true });
}
if (rebuilt !== 0) problems.push(`migrations rebuild a different schema (diff exit ${rebuilt})`);
if (control !== 2) problems.push(`control without the migration did not differ (diff exit ${control})`);
const local = localState();
if (local.diff !== 0) problems.push(`local database differs (diff exit ${local.diff})`);
if (!local.current) problems.push('local migration history is not current');

console.log(`new migration ${added.join(', ')} · backfill ${JSON.stringify(backfill)} · rebuild ${rebuilt} (control ${control}) · local diff ${local.diff} current ${local.current}`);
if (problems.length) {
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log('MATERIALS_SCHEMA_SYNCED');
