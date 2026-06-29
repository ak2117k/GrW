/**
 * Models that carry a `userId` scalar and are therefore tenant-owned (TDA-003).
 *
 * The Prisma tenant-scoping interceptor (Task 2) auto-injects `userId` scoping
 * for these models whenever a non-admin tenant context is active. `User` is
 * deliberately absent — it is the tenant root (keyed by `id`), and global/IP
 * models (Signal, Candle, …) are never scoped.
 *
 * Keep verbatim in sync with the schema; a missing name here is a silent
 * isolation hole.
 */
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'Trade',
  'UserSettings',
  'DailyPerformance',
  'Alert',
  'AITradeAnalysis',
  'AIWeeklyReport',
  'BrokerCredential',
  'Subscription',
  'AutoTradeConsent',
  'ConsentRecord',
  'RefreshToken',
  'VerificationToken',
]);

/**
 * The seeded ADMIN user (`prisma/seed.ts` / TDA-001 migration) that owns all
 * engine- and system-generated tenant rows.
 *
 * Background/engine code runs with NO tenant context, and the Prisma
 * tenant-scoping interceptor only stamps `userId` when a context is active — so
 * engine `create`/`upsert` on tenant-owned models must stamp this id explicitly
 * to satisfy the NOT NULL `userId` column added in TDA-001. Real user-owned rows
 * are stamped by the interceptor during authenticated requests; the centralized
 * fan-out (TDA-010/011) will reassign real owners later.
 */
export const SYSTEM_USER_ID = 'usr_admin_seed_0001';
