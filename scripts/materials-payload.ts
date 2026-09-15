// Gate leaf-2.2 D1: the bootstrap payload carries no material bodies. Runs under serve.mjs
// (TEST_APP_URL, demo mode). Creates a subject and a 20,000-character material for the demo
// student through the API, measures how much the bootstrap grew, checks the summary fields and the
// detail endpoint, and removes what it created.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';

const base = process.env.TEST_APP_URL;
if (!base) throw new Error('TEST_APP_URL is required (run through server/scripts/serve.mjs)');
const database = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.port !== '15444' || database.pathname !== '/memoryz') throw new Error('dedicated local database only');

let checks = 0;
const check = (ok: unknown, message: string) => {
  assert.ok(ok, message);
  checks++;
};
async function call(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const res = await fetch(base + path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json', origin: base } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, bytes: Buffer.byteLength(text), json: text ? JSON.parse(text) : null };
}
const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ role: 'STUDENT' }) });
const cookie = `memoryz_session=${/memoryz_session=([a-f0-9]{64})/.exec(login.headers.get('set-cookie') ?? '')?.[1]}`;
check(login.status === 200, 'demo login');

const db = new pg.Client({ connectionString: database.href });
await db.connect();
const created: { subject?: string; material?: string } = {};
try {
  const before = await call('/api/bootstrap', { cookie });
  check(before.status === 200 && Array.isArray(before.json.data.materials), 'bootstrap before');
  for (const m of before.json.data.materials) {
    check(!('content' in m) && typeof m.contentLength === 'number' && typeof m.excerpt === 'string' && m.excerpt.length <= 160 && /^[a-f0-9]{64}$/.test(m.contentHash), `material ${m.id} has summary fields only`);
  }
  const subject = (await call('/api/subjects', { cookie, body: { name: '지연 로딩 검사 과목' } })).json.data;
  created.subject = subject.id;
  const sentence = '세포막은 인지질 이중층과 막단백질로 이루어져 선택적 투과성을 가진다. ';
  const content = '  ' + sentence.repeat(Math.ceil(20000 / sentence.length)).slice(0, 20000) + '  ';
  const trimmed = content.trim();
  const material = (await call('/api/materials', { cookie, body: { subjectId: subject.id, title: '지연 로딩 검사 자료', content, type: 'TXT' } })).json.data;
  check(material?.id, `material created ${JSON.stringify(material).slice(0, 120)}`);
  created.material = material.id;
  const after = await call('/api/bootstrap', { cookie });
  const added = after.json.data.materials.find((m: { id: string }) => m.id === material.id);
  check(added && !('content' in added), 'the new material is listed without its body');
  check(added.contentLength === [...trimmed].length && added.excerpt.length <= 160 && trimmed.startsWith(added.excerpt.slice(0, 20)), `summary fields: length ${added.contentLength} excerpt ${added.excerpt.slice(0, 20)}…`);
  const growth = after.bytes - before.bytes;
  const contentBytes = Buffer.byteLength(content);
  const growthPercent = (growth / contentBytes) * 100;
  check(growth < contentBytes * 0.05, `bootstrap grew ${growth} B for a ${contentBytes} B body (${growthPercent.toFixed(2)}%)`);
  const detail = await call(`/api/materials/${material.id}`, { cookie });
  check(detail.status === 200 && detail.json.data.content === content && Array.isArray(detail.json.data.images), 'the detail endpoint returns the full body');
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  check(added.contentHash === hash && detail.json.data.contentHash === hash, `contentHash is sha256 of the stored body (${added.contentHash.slice(0, 12)} vs ${hash.slice(0, 12)})`);
  const cached = await call('/api/bootstrap', { cookie });
  check(cached.bytes === after.bytes, 'a repeated bootstrap is the same size (cache hit)');
  console.log(`MATERIALS_PAYLOAD_OK growth=${growthPercent.toFixed(2)}% before=${before.bytes} after=${after.bytes} body=${contentBytes} (${checks} checks)`);
} finally {
  if (created.material) await db.query('DELETE FROM "Material" WHERE "id" = $1', [created.material]);
  if (created.subject) await db.query('DELETE FROM "Subject" WHERE "id" = $1', [created.subject]);
  await db.end();
}
