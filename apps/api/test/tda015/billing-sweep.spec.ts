/**
 * TDA-015 Task 6 — daily lapse sweep (missed-webhook safety).
 *
 * expiresAt is authoritative for gating: a row past expiresAt is already not
 * hasActive, and the sweep durably flips ACTIVE+expired -> EXPIRED and audits
 * BILLING_ACCESS_REVOKED_LAPSE. A not-yet-expired ACTIVE row is untouched.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda015 \
 *     npx jest --config test/tda015/jest.config.js billing-sweep --runInBand --verbose
 */
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { SubscriptionService } from '../../src/modules/subscription/subscription.service';
import { BillingSweepService } from '../../src/modules/billing/billing-sweep.service';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at the scratch td_saas_tda015 DB');
process.env.DATABASE_URL = url;

const raw = new PrismaClient({ datasources: { db: { url } } });
const cls = new ClsService(new AsyncLocalStorage());
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const audit = new AuditService(prisma);
const subs = new SubscriptionService(prisma, tenant);
const sweep = new BillingSweepService(prisma, tenant, audit);

const run = <T>(fn: () => Promise<T>): Promise<T> => cls.run(() => fn());

const E = 'tda015-sweep@test.local';
let uId: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  await raw.subscription.deleteMany({ where: { user: { email: E } } });
  await raw.user.deleteMany({ where: { email: E } });
  const u = await raw.user.create({ data: { email: E, passwordHash: 'x', role: 'USER' } });
  uId = u.id;
});

afterAll(async () => {
  await raw.subscription.deleteMany({ where: { userId: uId } });
  await raw.user.deleteMany({ where: { email: E } });
  await raw.$disconnect();
  await prisma.$disconnect();
});

describe('TDA-015 BillingSweepService.expireLapsedSubscriptions', () => {
  it('flips an expired ACTIVE row to EXPIRED, audits, and untouched a fresh one', async () => {
    // Expired ACTIVE (past expiresAt) on INTRADAY.
    await raw.subscription.upsert({
      where: { userId_segment: { userId: uId, segment: 'INTRADAY' } },
      update: { status: 'ACTIVE', expiresAt: new Date(Date.now() - 86_400_000) },
      create: { userId: uId, segment: 'INTRADAY', status: 'ACTIVE', expiresAt: new Date(Date.now() - 86_400_000) },
    });
    // Fresh ACTIVE (future expiresAt) on SWING.
    await raw.subscription.upsert({
      where: { userId_segment: { userId: uId, segment: 'SWING' } },
      update: { status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 86_400_000) },
      create: { userId: uId, segment: 'SWING', status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 86_400_000) },
    });

    const auditSpy = jest.spyOn(audit, 'append').mockResolvedValue({ seq: 1n, hash: 'h' });

    const result = await run(() => sweep.expireLapsedSubscriptions());
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const intraday = await raw.subscription.findUnique({
      where: { userId_segment: { userId: uId, segment: 'INTRADAY' } },
    });
    const swing = await raw.subscription.findUnique({
      where: { userId_segment: { userId: uId, segment: 'SWING' } },
    });
    expect(intraday!.status).toBe('EXPIRED');
    expect(swing!.status).toBe('ACTIVE'); // fresh row untouched

    expect(await run(() => subs.hasActive(uId, 'INTRADAY'))).toBe(false);

    const actions = auditSpy.mock.calls.map((c) => (c[0] as { action: string; userId?: string }));
    const lapse = actions.find((a) => a.action === 'BILLING_ACCESS_REVOKED_LAPSE');
    expect(lapse).toBeDefined();
    expect(lapse!.userId).toBe(uId);
    auditSpy.mockRestore();
  });

  it('is a no-op on a second run (the sweep is idempotent; nothing left lapsed)', async () => {
    // Drain any lapsed rows left by other specs (the sweep is global), then a
    // second run must find nothing and audit nothing.
    await run(() => sweep.expireLapsedSubscriptions());
    const auditSpy = jest.spyOn(audit, 'append').mockResolvedValue({ seq: 1n, hash: 'h' });
    const result = await run(() => sweep.expireLapsedSubscriptions());
    expect(result.expired).toBe(0);
    expect(auditSpy).not.toHaveBeenCalled();
    auditSpy.mockRestore();
  });
});
