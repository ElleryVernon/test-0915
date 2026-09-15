// Test sessions for QA scripts, written straight into the database with the same rule the Go
// server uses (Session.id = sha256(token); 8 days, the top of the server's 8 d − U[0, 12 h) draw). Replaces the deleted TS server's createSession
// so the contract scripts keep issuing cookies for arbitrary accounts without a login form.
import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

export const SESSION_COOKIE = 'memoryz_session';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

let pool: pg.Pool | undefined;
function db() {
  if (!pool) {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '15444' || !url.pathname.startsWith('/memoryz'))
      throw new Error('dedicated local database only');
    pool = new pg.Pool({ connectionString: url.href, max: 2 });
  }
  return pool;
}

/** Inserts a session for userId and returns the Set-Cookie value (`memoryz_session=<token>; …`). */
export async function createSession(userId: string, request: Request) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  await db().query('INSERT INTO "Session" ("id", "userId", "expiresAt") VALUES ($1, $2, $3)', [tokenHash(token), userId, expiresAt]);
  await db().query('DELETE FROM "Session" WHERE "userId" = $1 AND "expiresAt" < now()', [userId]);
  const secure = new URL(request.url).protocol === 'https:' || process.env.APP_URL?.startsWith('https:');
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=691200${secure ? '; Secure' : ''}`;
}

/** Releases the pool so a script can exit without waiting for idle connections. */
export async function closeSessions() {
  await pool?.end();
  pool = undefined;
}
