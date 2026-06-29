import { PrismaClient } from '@prisma/client';

/**
 * Dedicated Prisma client for the TDA-001 integration tests.
 *
 * Always points at the throw-away test database `td_saas_test` via
 * DATABASE_URL_TEST so a stray run can never touch the real `td_saas`
 * database that DATABASE_URL points at.
 */
const url = process.env.DATABASE_URL_TEST;

if (!url) {
  throw new Error(
    'DATABASE_URL_TEST must be set to the td_saas_test connection string ' +
      '(e.g. postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test)',
  );
}

export const db = new PrismaClient({
  datasources: { db: { url } },
});
