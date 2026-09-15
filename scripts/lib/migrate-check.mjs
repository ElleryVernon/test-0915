// Throwaway-database helpers for migration checks: create a database on the dedicated local server,
// point a temporary Prisma config at it and at a chosen migrations directory, and drop it afterwards.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

export const database = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');

/** Copies prisma/migrations without the named migrations, for "before this migration" states. */
export function migrationsWithout(names, tag) {
  const dir = resolve(`tmp/migrations-${tag}-${randomUUID().slice(0, 8)}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync('prisma/migrations', dir, { recursive: true });
  for (const name of names) rmSync(`${dir}/${name}`, { recursive: true, force: true });
  return dir;
}

/** Runs `fn` with a fresh empty database; `prisma(args, migrations)` targets it. The database is dropped after. */
export async function withScratchDatabase(fn) {
  const name = `memoryz_migrate_check_${randomUUID().slice(0, 8)}`;
  const target = new URL(database.href);
  target.pathname = `/${name}`;
  mkdirSync('tmp', { recursive: true });
  const configs = [];
  const prisma = (args, migrations = 'prisma/migrations') => {
    const config = resolve(`tmp/${name}-${configs.length}.config.ts`);
    configs.push(config);
    writeFileSync(
      config,
      `import { defineConfig } from 'prisma/config';\nexport default defineConfig(${JSON.stringify({
        schema: resolve('prisma/schema.prisma'),
        migrations: { path: resolve(migrations) },
        datasource: { url: target.href },
      })});\n`,
    );
    return spawnSync('npx', ['prisma', ...args, '--config', config], { encoding: 'utf8' });
  };
  const admin = new pg.Client({ connectionString: database.href });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const client = new pg.Client({ connectionString: target.href });
  try {
    await client.connect();
    return await fn({ prisma, client, url: target.href });
  } finally {
    await client.end().catch(() => {});
    for (const config of configs) rmSync(config, { force: true });
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

/** Applies the given migrations directory and reports the schema diff exit code (0 = identical). */
export async function rebuild(migrations) {
  return withScratchDatabase(async ({ prisma }) => {
    const deploy = prisma(['migrate', 'deploy'], migrations);
    if (deploy.status !== 0) throw new Error(`migrate deploy: ${deploy.stdout}${deploy.stderr}`);
    return prisma(['migrate', 'diff', '--from-config-datasource', '--to-schema', resolve('prisma/schema.prisma'), '--exit-code'], migrations).status;
  });
}

/** The local database matches the schema and its migration history is current. */
export function localState() {
  const diff = spawnSync('npx', ['prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], { encoding: 'utf8' });
  const status = spawnSync('npx', ['prisma', 'migrate', 'status'], { encoding: 'utf8' });
  return { diff: diff.status, current: status.status === 0 && /up to date/i.test(status.stdout) };
}
