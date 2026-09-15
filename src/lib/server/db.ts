import { PrismaClient } from './generated/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalDb = globalThis as unknown as { memoryzPrisma?: PrismaClient };
export const db = globalDb.memoryzPrisma ?? new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 30_000 }),
});
if (process.env.NODE_ENV !== 'production') globalDb.memoryzPrisma = db;
