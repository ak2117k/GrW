/**
 * TDA-007 Task 1 — SubscriptionService (hasActive / listForUser / grant / revoke).
 *
 * Style-B: real `td_saas_test` DB. A raw `PrismaClient` seeds/cleans up;
 * `PrismaService` + `TenantContextService` are wired by hand for the SUT.
 * `Subscription` is a TENANT_MODEL (TDA-003), and the service runs all queries
 * unscoped via `runWithoutTenant`, so these checks drive the SUT with NO tenant
 * context at all — proving it queries the explicit userId correctly.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda007/jest.config.js subscription --verbose
 */

import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { SubscriptionService } from '../../src/modules/subscription/subscription.service';

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  throw new Error(
    'DATABASE_URL_TEST must be set to the td_saas_test connection string ' +
      '(e.g. postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test)',
  );
}
// PrismaService resolves its connection from DATABASE_URL — point it at the
// test DB so a stray run can NEVER touch the real td_saas database.
process.env.DATABASE_URL = url;

const raw = new PrismaClient({ datasources: { db: { url } } });
const cls = new ClsService(new AsyncLocalStorage());
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const svc = new SubscriptionService(prisma, tenant);

/**
 * Run `fn` inside a CLS scope with NO tenant set — the background/system scope
 * that production always provides via ClsMiddleware. `runWithoutTenant` inside
 * the service mutates the CLS store, so an active scope must exist (exactly how
 * isolation.spec drives the scoped client through `asTenant`/`cls.run`).
 */
const run = <T>(fn: () => Promise<T>): Promise<T> => cls.run(() => fn());

let uId: string;
const E = 'tda007-sub@test.local';

beforeAll(async () => {
  await prisma.onModuleInit();
  await raw.subscription.deleteMany({ where: { user: { email: E } } });
  await raw.user.deleteMany({ where: { email: E } });
  const u = await raw.user.create({
    data: { email: E, passwordHash: 'x', role: 'USER' },
  });
  uId = u.id;
  await raw.subscription.create({
    data: { userId: uId, segment: 'INTRADAY', status: 'ACTIVE' },
  });
  await raw.subscription.create({
    data: {
      userId: uId,
      segment: 'SWING',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 1000),
    },
  }); // expired
});

afterAll(async () => {
  await raw.subscription.deleteMany({ where: { userId: uId } });
  await raw.user.deleteMany({ where: { email: E } });
  await raw.$disconnect();
  await prisma.$disconnect();
});

describe('TDA-007 Task 1 — SubscriptionService', () => {
  it('hasActive true for ACTIVE non-expired', async () =>
    expect(await run(() => svc.hasActive(uId, 'INTRADAY'))).toBe(true));

  it('hasActive false for expired', async () =>
    expect(await run(() => svc.hasActive(uId, 'SWING'))).toBe(false));

  it('hasActive false when no row', async () =>
    expect(await run(() => svc.hasActive('nope', 'INTRADAY'))).toBe(false));

  it('hasActive false for wrong segment with no row', async () =>
    expect(await run(() => svc.hasActive('nope', 'SWING'))).toBe(false));

  it('listForUser reports per-segment booleans', async () =>
    expect(await run(() => svc.listForUser(uId))).toEqual({
      INTRADAY: true,
      SWING: false,
    }));

  it('grant upserts ACTIVE; revoke cancels', async () => {
    await run(() => svc.grant(uId, 'SWING', null));
    expect(await run(() => svc.hasActive(uId, 'SWING'))).toBe(true);
    await run(() => svc.revoke(uId, 'SWING'));
    expect(await run(() => svc.hasActive(uId, 'SWING'))).toBe(false);
  });
});
