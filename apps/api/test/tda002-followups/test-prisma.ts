import { PrismaClient } from '@prisma/client';

/**
 * Dedicated Prisma client for the TDA-002 follow-up integration tests.
 *
 * Points at the throw-away scratch database via DATABASE_URL_TEST so a stray run
 * can never touch the real `td_saas` database that DATABASE_URL points at.
 */
const url = process.env.DATABASE_URL_TEST;

if (!url) {
  throw new Error(
    'DATABASE_URL_TEST must be set to the scratch connection string ' +
      '(e.g. postgresql://postgres:postgres@127.0.0.1:5432/td_saas_debt)',
  );
}

export const db = new PrismaClient({
  datasources: { db: { url } },
});
