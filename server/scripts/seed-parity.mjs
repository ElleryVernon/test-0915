// Gate A3: the Go demo seed produces the same rows as prisma/seed.ts. Two empty databases get the
// Go migrations; one is seeded by `server seed-demo`, the other by the TypeScript seed; every table
// is compared column by column (generated ids and timestamps excluded). Seeding again adds nothing.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz')
  throw new Error('dedicated local database only');
const work = mkdtempSync(join(tmpdir(), 'memoryz-seed-'));
const bin = join(work, 'server');
const build = spawnSync('go', ['build', '-o', bin, './cmd/server'], { cwd: resolve('server'), encoding: 'utf8' });
if (build.status !== 0) throw new Error(`go build: ${build.stderr}`);
const admin = new pg.Client({ connectionString: database.href });
await admin.connect();
const names = [];
const scratch = async () => {
  const name = `memoryz_seed_${randomUUID().slice(0, 8)}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  names.push(name);
  const url = new URL(database.href);
  url.pathname = `/${name}`;
  const migrate = spawnSync(bin, ['migrate', 'up'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url.href, ENV: 'development', LOG_FORMAT: 'json', LOG_LEVEL: 'warn' } });
  if (migrate.status !== 0) throw new Error(`migrate: ${migrate.stdout}${migrate.stderr}`);
  return url.href;
};
const tables = [
  ['User', 'id', '"id","name","nickname","role","school","grade","streak","points","suspended","selectedChildId","srsMode","desiredRetention","privacy","completedSubjects","linkFailures"'],
  ['ParentLink', '"parentId"', '"parentId","studentId"'],
  ['School', 'name', '"name"'],
  ['Subject', 'id', '"id","userId","name","icon","semester","color","examName","examDate","deleted"'],
  ['Material', 'id', '"id","userId","subjectId","title",md5("content") AS content,"type","url","uploadId","pageBreaks","extraction"'],
  ['Question', 'id', '"id","userId","subjectId","materialId","prompt","options","answer","explanation","citation","past","future"'],
  ['Essay', 'id', '"id","userId","subjectId","materialId","prompt","keywords","distractors","modelAnswer","citation"'],
  ['Card', 'id', '"id","userId","subjectId","front","back","type","bucket","consecutiveEasy","deleted","image","masks","sourceQuestionId","fsrs"'],
  ['Schedule', '"start"', '"userId","title","date","start","end","kind","subjectId","done"'],
  ['Post', 'id', '"id","userId","role","category","title","body","anonymous"'],
  ['Comment', 'body', '"postId","userId","body","parentId"'],
  ['Cheer', 'message', '"senderId","recipientId","message","points","thanked"'],
  ['Notification', 'title', '"userId","title","body","read","href"'],
];
async function snapshot(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const out = {};
  try {
    for (const [table, order, columns] of tables) out[table] = (await client.query(`SELECT ${columns} FROM "${table}" ORDER BY ${order}`)).rows;
  } finally {
    await client.end();
  }
  return out;
}
let verdict = 'SEED_PARITY_FAILED';
try {
  const goUrl = await scratch();
  const tsUrl = await scratch();
  const goSeed = spawnSync(bin, ['seed-demo'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: goUrl, ENV: 'development', DEMO_MODE: 'true', LOG_FORMAT: 'json', LOG_LEVEL: 'warn' } });
  if (goSeed.status !== 0 || !/DEMO_SEED_OK/.test(goSeed.stdout)) throw new Error(`go seed: ${goSeed.stdout}${goSeed.stderr}`);
  const tsSeed = spawnSync('npx', ['tsx', 'prisma/seed.ts'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: tsUrl, DEMO_MODE: 'true' } });
  if (tsSeed.status !== 0 || !/DEMO_SEED_OK/.test(tsSeed.stdout)) throw new Error(`ts seed: ${tsSeed.stdout}${tsSeed.stderr}`);
  const [goRows, tsRows] = [await snapshot(goUrl), await snapshot(tsUrl)];
  let compared = 0;
  for (const [table] of tables) {
    assert.deepEqual(goRows[table], tsRows[table], `${table} differs`);
    compared += goRows[table].length;
  }
  const again = spawnSync(bin, ['seed-demo'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: goUrl, ENV: 'development', DEMO_MODE: 'true', LOG_FORMAT: 'json', LOG_LEVEL: 'warn' } });
  if (again.status !== 0) throw new Error(`second go seed: ${again.stderr}`);
  assert.deepEqual(await snapshot(goUrl), goRows, 'second seed changed rows');
  console.log(`tables ${tables.length} · rows compared ${compared} · users ${goRows.User.length} cards ${goRows.Card.length}`);
  verdict = 'SEED_PARITY_OK';
} catch (error) {
  console.error(error);
} finally {
  for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
  rmSync(work, { recursive: true, force: true });
}
console.log(verdict);
process.exit(verdict === 'SEED_PARITY_OK' ? 0 : 1);
