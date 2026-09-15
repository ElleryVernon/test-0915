// Gate G2: the embedded goose migrations rebuild exactly the schema the Prisma mirror describes.
// A fresh throwaway database gets `server migrate up`; `prisma migrate diff` against the mirror must
// find nothing (exit 0) while a control database stopped at version 1 must differ (exit 2). Running
// `migrate up` again applies nothing and `migrate status` shows no pending migration.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const work = mkdtempSync(join(tmpdir(), 'memoryz-migrate-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`go build: ${build.stderr}`);
const emptyMigrations = join(work, 'no-migrations');
mkdirSync(emptyMigrations);

const lastJson = (text) => JSON.parse(text.trim().split('\n').filter(Boolean).pop());
const server = (url, args) => {
  const result = spawnSync(bin, args, { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url, ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'warn' } });
  if (result.status !== 0) throw new Error(`server ${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return lastJson(result.stdout);
};
// Prisma loads the config as a module, so it must live inside the repository to resolve 'prisma/config'.
const configDir = resolve('tmp');
mkdirSync(configDir, { recursive: true });
const configs = [];
const prismaDiff = (url) => {
  const config = join(configDir, `migrate-check-${randomUUID().slice(0, 8)}.config.ts`);
  configs.push(config);
  writeFileSync(config, `import { defineConfig } from 'prisma/config';\nexport default defineConfig(${JSON.stringify({ schema: resolve('prisma/schema.prisma'), migrations: { path: emptyMigrations }, datasource: { url } })});\n`);
  const diff = spawnSync('npx', ['prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', resolve('prisma/schema.prisma'), '--exit-code', '--config', config], { encoding: 'utf8' });
  // 0 = identical, 2 = different; anything else is Prisma failing to compare at all.
  if (diff.status !== 0 && diff.status !== 2) console.log(`prisma migrate diff failed (${diff.status}): ${diff.stderr.trim() || diff.stdout.trim()}`);
  return { status: diff.status, script: diff.stdout };
};

const admin = new pg.Client({ connectionString: database.href });
await admin.connect();
const names = [];
const scratch = async () => {
  const name = `memoryz_migrate_${randomUUID().slice(0, 8)}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  names.push(name);
  const url = new URL(database.href);
  url.pathname = `/${name}`;
  return url.href;
};
let verdict = 'MIGRATIONS_DIFFER';
try {
  const full = await scratch();
  const applied = server(full, ['migrate', 'up']).applied;
  const diff = prismaDiff(full);
  const again = server(full, ['migrate', 'up']).applied;
  const status = server(full, ['migrate', 'status']);
  const control = await scratch();
  server(control, ['migrate', 'up', '1']);
  const controlDiff = prismaDiff(control);
  console.log(`applied ${JSON.stringify(applied)} then ${JSON.stringify(again)} · status current ${status.current} pending ${status.pending} · prisma diff exit ${diff.status} (control at version 1: exit ${controlDiff.status})`);
  if (diff.status !== 0) console.log(diff.script.trim());
  if (diff.status === 0 && controlDiff.status === 2 && applied.length >= 2 && again.length === 0 && status.pending === 0) verdict = 'MIGRATIONS_MATCH_PRISMA';
} finally {
  for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
  rmSync(work, { recursive: true, force: true });
  for (const config of configs) rmSync(config, { force: true });
}
console.log(verdict);
process.exit(verdict === 'MIGRATIONS_MATCH_PRISMA' ? 0 : 1);
