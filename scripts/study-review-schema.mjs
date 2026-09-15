// The study review may only add Subject.examName / Subject.examDate (nullable). It must ship a migration
// that adds exactly those columns, the migrations alone must rebuild the schema (checked on a throwaway
// database, with a control that drops the new migration), and the local database must match the schema
// with the migration recorded. Only the dedicated local server is touched.
import 'dotenv/config';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const BASE = '0f14f1e';
const MIGRATION = '20260915030000_subject_exam';
const database = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const problems = [];

const diff = execFileSync('git', ['diff', '--unified=0', BASE, '--', 'prisma/schema.prisma'], { encoding: 'utf8' });
const changed = diff
  .split('\n')
  .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
  .map((l) => l.replace(/\s+/g, ' ').trim().replace(/^([+-]) /, '$1'));
if (changed.length !== 2 || !changed.includes('+examName String?') || !changed.includes('+examDate String?'))
  problems.push(`schema changes: ${changed.join(' | ')}`);
if (!/model Subject/.test(execFileSync('git', ['diff', BASE, '--', 'prisma/schema.prisma'], { encoding: 'utf8' })))
  problems.push('changes are outside model Subject');

const before = new Set(
  execFileSync('git', ['ls-tree', '--name-only', `${BASE}:prisma/migrations`], { encoding: 'utf8' }).split('\n').filter(Boolean),
);
const added = readdirSync('prisma/migrations').filter((name) => !before.has(name));
const sql = existsSync(`prisma/migrations/${MIGRATION}/migration.sql`)
  ? readFileSync(`prisma/migrations/${MIGRATION}/migration.sql`, 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim()
  : '';
if (added.join() !== MIGRATION) problems.push(`new migrations: ${added.join(', ') || '(none)'}`);
if (sql !== 'ALTER TABLE "Subject" ADD COLUMN "examDate" TEXT, ADD COLUMN "examName" TEXT;')
  problems.push(`migration SQL: ${sql || '(missing)'}`);

/** Applies a migrations directory to an empty database and diffs it against the schema (0 = identical). */
async function rebuild(migrations) {
  const name = `memoryz_migrate_check_${randomUUID().slice(0, 8)}`;
  const target = new URL(database.href);
  target.pathname = `/${name}`;
  mkdirSync('tmp', { recursive: true });
  const config = resolve(`tmp/${name}.config.ts`);
  writeFileSync(
    config,
    `import { defineConfig } from 'prisma/config';\nexport default defineConfig(${JSON.stringify({
      schema: resolve('prisma/schema.prisma'),
      migrations: { path: resolve(migrations) },
      datasource: { url: target.href },
    })});\n`,
  );
  const admin = new pg.Client({ connectionString: database.href });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  try {
    const deploy = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--config', config], { encoding: 'utf8' });
    if (deploy.status !== 0) throw new Error(`migrate deploy: ${deploy.stdout}${deploy.stderr}`);
    const check = spawnSync(
      'npx',
      ['prisma', 'migrate', 'diff', '--config', config, '--from-config-datasource', '--to-schema', resolve('prisma/schema.prisma'), '--exit-code'],
      { encoding: 'utf8' },
    );
    return check.status;
  } finally {
    rmSync(config, { force: true });
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}
const rebuilt = await rebuild('prisma/migrations');
// Control: without the new migration the rebuilt database must differ, or the check proves nothing.
const withoutNew = resolve(`tmp/migrations-without-${MIGRATION}`);
rmSync(withoutNew, { recursive: true, force: true });
cpSync('prisma/migrations', withoutNew, { recursive: true });
rmSync(`${withoutNew}/${MIGRATION}`, { recursive: true, force: true });
const control = await rebuild(withoutNew);
rmSync(withoutNew, { recursive: true, force: true });
if (rebuilt !== 0) problems.push(`migrations rebuild a different schema (diff exit ${rebuilt})`);
if (control !== 2) problems.push(`control without the migration did not differ (diff exit ${control})`);

const local = spawnSync('npx', ['prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], { encoding: 'utf8' });
const status = spawnSync('npx', ['prisma', 'migrate', 'status'], { encoding: 'utf8' });
if (local.status !== 0) problems.push(`local database differs from the schema (diff exit ${local.status})`);
if (status.status !== 0 || !/up to date/i.test(status.stdout)) problems.push('local migration history is not up to date');

console.log(`schema changes vs ${BASE}: ${changed.join(' | ')} · new migration: ${added.join(', ') || '-'}`);
console.log(`migrations rebuild the schema: diff exit ${rebuilt} (control without it: ${control}) · local diff exit ${local.status} · history up to date: ${status.status === 0}`);
if (problems.length) {
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log('STUDY_REVIEW_SCHEMA_SYNCED');
