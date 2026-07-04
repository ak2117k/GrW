/**
 * TDA-015 Task 4 — BillingWebhookService (verify -> dedupe -> map -> audit).
 *
 * Style-B: real td_saas_tda015 scratch DB. A raw PrismaClient seeds/cleans;
 * PrismaService + TenantContextService are hand-wired; the SUT binds the real
 * SubscriptionService (the ONLY entitlement writer), the FakePaymentProvider,
 * and a spied AuditService. Proves the money -> access loop:
 *   - forged signature -> UnauthorizedException, audit REJECTED, NO grant;
 *   - subscription.charged -> hasActive true, expiresAt ~ currentPeriodEnd+grace;
 *   - the SAME eventId twice -> grant called once, second is { deduped: true };
 *   - subscription.halted -> revoke -> hasActive false;
 *   - payment.failed -> graceUntil set, hasActive STILL true (no revoke);
 *   - audit meta carries no secret/signature/PII.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda015 \
 *     npx jest --config test/tda015/jest.config.js billing-webhook --runInBand --verbose
 */
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { SubscriptionService } from '../../src/modules/subscription/subscription.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { BillingService } from '../../src/modules/billing/billing.service';
import { BillingWebhookService } from '../../src/modules/billing/billing-webhook.service';
import {
  FakePaymentProvider,
  FAKE_WEBHOOK_SECRET,
} from '../../src/modules/billing/providers/fake-payment.provider';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at the scratch td_saas_tda015 DB');
process.env.DATABASE_URL = url;

const GRACE_DAYS = 3;
const raw = new PrismaClient({ datasources: { db: { url } } });
const cls = new ClsService(new AsyncLocalStorage());
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const subs = new SubscriptionService(prisma, tenant);
const audit = new AuditService(prisma);
const provider = new FakePaymentProvider();
const config = { get: (k: string) => (k === 'billing.graceDays' ? GRACE_DAYS : undefined) };
const billing = new BillingService(prisma, tenant, provider as never, audit, config as never);
// TDA-017 added a PaymentService dependency (records captured/failed payments).
// tda015 asserts entitlement/grace/redaction, not the ledger — stub it (mirrors
// the `provider as never` stubbing above).
const payments = { record: async () => {} };
const webhook = new BillingWebhookService(
  provider as never,
  subs,
  billing,
  audit,
  prisma,
  payments as never,
);

const run = <T>(fn: () => Promise<T>): Promise<T> => cls.run(() => fn());

const E = 'tda015-webhook@test.local';
let uId: string;

function sign(body: Buffer): string {
  return createHmac('sha256', FAKE_WEBHOOK_SECRET).update(body).digest('hex');
}

let paymentSeq = 0;
function event(name: string, subId: string, currentEndSec?: number): Buffer {
  paymentSeq += 1;
  return Buffer.from(
    JSON.stringify({
      entity: 'event',
      event: name,
      created_at: 1_700_000_000 + paymentSeq,
      payload: {
        subscription: {
          entity: { id: subId, ...(currentEndSec ? { current_end: currentEndSec } : {}) },
        },
        ...(name === 'subscription.charged' || name === 'payment.failed'
          ? { payment: { entity: { id: `pay_sub_wh_${paymentSeq}` } } }
          : {}),
      },
    }),
  );
}

async function seedSub(segment: 'INTRADAY' | 'SWING', providerSubId: string): Promise<void> {
  await raw.subscription.upsert({
    where: { userId_segment: { userId: uId, segment } },
    update: { status: 'PAST_DUE', providerSubId, providerPlanId: 'plan_x', expiresAt: null, graceUntil: null },
    create: { userId: uId, segment, status: 'PAST_DUE', providerSubId, providerPlanId: 'plan_x' },
  });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await raw.webhookEvent.deleteMany({ where: { eventId: { contains: 'sub_wh_' } } });
  await raw.subscription.deleteMany({ where: { user: { email: E } } });
  await raw.user.deleteMany({ where: { email: E } });
  const u = await raw.user.create({ data: { email: E, passwordHash: 'x', role: 'USER' } });
  uId = u.id;
});

afterAll(async () => {
  await raw.webhookEvent.deleteMany({ where: { eventId: { contains: 'sub_wh_' } } });
  await raw.subscription.deleteMany({ where: { userId: uId } });
  await raw.user.deleteMany({ where: { email: E } });
  await raw.$disconnect();
  await prisma.$disconnect();
});

beforeEach(() => jest.restoreAllMocks());

describe('TDA-015 BillingWebhookService', () => {
  it('rejects a forged signature: 401, audits REJECTED, no grant', async () => {
    const subId = 'sub_wh_forge';
    await seedSub('INTRADAY', subId);
    const grantSpy = jest.spyOn(subs, 'grant');
    const auditSpy = jest.spyOn(audit, 'append').mockResolvedValue({ seq: 1n, hash: 'h' });

    const body = event('subscription.charged', subId, 1_700_500_000);
    await expect(run(() => webhook.handle(body, 'deadbeef'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(grantSpy).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'BILLING_WEBHOOK_REJECTED' }),
    );
    expect(await run(() => subs.hasActive(uId, 'INTRADAY'))).toBe(false);
  });

  it('subscription.charged grants ACTIVE with expiresAt ~ currentPeriodEnd + grace', async () => {
    const subId = 'sub_wh_charge';
    await seedSub('INTRADAY', subId);
    jest.spyOn(audit, 'append').mockResolvedValue({ seq: 1n, hash: 'h' });

    const currentEnd = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const body = event('subscription.charged', subId, currentEnd);
    const res = await run(() => webhook.handle(body, sign(body)));
    expect(res.processed).toBe(true);

    expect(await run(() => subs.hasActive(uId, 'INTRADAY'))).toBe(true);
    const row = await raw.subscription.findUnique({
      where: { userId_segment: { userId: uId, segment: 'INTRADAY' } },
    });
    const expected = currentEnd * 1000 + GRACE_DAYS * 86_400_000;
    expect(Math.abs((row!.expiresAt!.getTime()) - expected)).toBeLessThan(2000);
    expect(row!.graceUntil).toBeNull();
  });

  it('is idempotent: the same eventId delivered twice grants once', async () => {
    const subId = 'sub_wh_idem';
    await seedSub('SWING', subId);
    jest.spyOn(audit, 'append').mockResolvedValue({ seq: 1n, hash: 'h' });
    const grantSpy = jest.spyOn(subs, 'grant');

    const body = event('subscription.charged', subId, 1_700_700_000);
    const sig = sign(body);
    const first = await run(() => webhook.handle(body, sig));
    const second = await run(() => webhook.handle(body, sig));

    expect(first.processed).toBe(true);
    expect(second.deduped).toBe(true);
    expect(grantSpy).toHaveBeenCalledTimes(1);
  });

  it('subscription.halted revokes access', async () => {
    const subId = 'sub_wh_halt';
    await seedSub('INTRADAY', subId);
    jest.spyOn(audit, 'append').mockResolvedValue({ seq: 1n, hash: 'h' });
    // First a charge to make it ACTIVE.
    const charge = event('subscription.charged', subId, Math.floor(Date.now() / 1000) + 30 * 86_400);
    await run(() => webhook.handle(charge, sign(charge)));
    expect(await run(() => subs.hasActive(uId, 'INTRADAY'))).toBe(true);

    const halt = event('subscription.halted', subId);
    const auditSpy = jest.spyOn(audit, 'append').mockResolvedValue({ seq: 1n, hash: 'h' });
    await run(() => webhook.handle(halt, sign(halt)));

    expect(await run(() => subs.hasActive(uId, 'INTRADAY'))).toBe(false);
    const actions = auditSpy.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain('BILLING_SUBSCRIPTION_HALTED');
    expect(actions).toContain('BILLING_ACCESS_REVOKED_LAPSE');
  });

  it('payment.failed sets graceUntil but keeps access until expiresAt', async () => {
    const subId = 'sub_wh_fail';
    await seedSub('SWING', subId);
    jest.spyOn(audit, 'append').mockResolvedValue({ seq: 1n, hash: 'h' });
    const charge = event('subscription.charged', subId, Math.floor(Date.now() / 1000) + 30 * 86_400);
    await run(() => webhook.handle(charge, sign(charge)));
    expect(await run(() => subs.hasActive(uId, 'SWING'))).toBe(true);

    const fail = event('payment.failed', subId);
    await run(() => webhook.handle(fail, sign(fail)));

    // Still active (not past expiresAt) and graceUntil now set.
    expect(await run(() => subs.hasActive(uId, 'SWING'))).toBe(true);
    const row = await raw.subscription.findUnique({
      where: { userId_segment: { userId: uId, segment: 'SWING' } },
    });
    expect(row!.graceUntil).not.toBeNull();
    expect(row!.status).toBe('ACTIVE');
  });

  it('does not leak the webhook secret / signature into audit meta', async () => {
    const subId = 'sub_wh_redact';
    await seedSub('INTRADAY', subId);
    const auditSpy = jest.spyOn(audit, 'append').mockResolvedValue({ seq: 1n, hash: 'h' });
    const body = event('subscription.charged', subId, 1_700_900_000);
    const sig = sign(body);
    await run(() => webhook.handle(body, sig));

    const serialized = JSON.stringify(auditSpy.mock.calls);
    expect(serialized).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(serialized).not.toContain(sig);
  });
});
