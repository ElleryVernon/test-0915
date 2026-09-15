// Prisma client for QA scripts (development only; the product server is Go). Writes that go
// straight to the database bypass the server's cache versioning, so after every write this client
// asks the server under test (TEST_APP_URL, or whatever `useServer` was told) to drop its cache —
// the dev-only route the Go server exposes for exactly this. Reads through the API are then never
// stale because of a shortcut taken by a check.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../prisma/generated/client';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '15444' || !url.pathname.startsWith('/memoryz')) throw new Error('dedicated local database only');

let serverBase: string | undefined = process.env.TEST_APP_URL;
/** Points cache flushes at a server the script started itself. */
export function useServer(base: string | undefined) {
  serverBase = base;
}

const writes = /^(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)$/;
export async function flushServerCache() {
  if (!serverBase) return;
  const res = await fetch(`${serverBase}/api/_dev/cache-flush`, { method: 'POST', headers: { origin: serverBase } }).catch(() => undefined);
  if (res && res.status !== 200) throw new Error(`cache flush at ${serverBase}: ${res.status}`);
}

export const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url.href, max: 10, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 30_000 }),
}).$extends({
  query: {
    $allModels: {
      async $allOperations({ operation, args, query }) {
        const result = await query(args);
        if (writes.test(operation)) await flushServerCache();
        return result;
      },
    },
  },
});
