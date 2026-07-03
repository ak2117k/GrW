/**
 * TDA-015 Task 8 — redaction regression guard (locks spec §7 / AC6).
 *
 * Runs a representative checkout + a signed webhook through the REAL services
 * (FakePaymentProvider — never real Razorpay) while capturing EVERY logger line
 * and EVERY AuditService.append payload, then asserts none of them contains the
 * webhook secret or the x-razorpay-signature value. If this ever fails, a leak
 * has been introduced — fix the leak, do not weaken the test.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda015 \
 *     npx jest --config test/tda015/jest.config.js no-secret-leak --runInBand --verbose
 */
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { createHmac } from 'crypto';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { SubscriptionService } from '../../src/modules/subscription/subscription.service';
import { BillingService } from '../../src/modules/billing/billing.service';
import { BillingWebhookService } from '../../src/modules/billing/billing-webhook.service';
import {
  FakePaymentProvider,
  FAKE_WEBHOOK_SECRET,
} from '../../src/modules/billing/providers/fake-payment.provider';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at the scratch td_saas_tda015 DB');
process.env.DATABASE_URL = url;

const raw = new PrismaClient({ datasources: { db: { url } } });
const cls = new ClsService(new AsyncLocalStorage());
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const subs = new SubscriptionService(prisma, tenant);
const audit = new AuditService(prisma);
const provider = new FakePaymentProvider();
const config = { get: (k: string) => (k === 'billing.graceDays' ? 3 : undefined) };
const billing = new BillingService(prisma, tenant, provider as never, audit, config as never);
const webhook = new BillingWebhookService(provider as never, subs, billing, audit, prisma);

const run = <T>(fn: () => Promise<T>): Promise<T> => cls.run(() => fn());

const E = 'tda015-leak@test.local';
let uId: string;

async function cleanup(): Promise<void> {
  await raw.webhookEvent.deleteMany({ where: { eventId: { contains: 'leak_wh' } } });
  await raw.subscription.deleteMany({ where: { user: { email: E } } });
  await raw.billingProfile.deleteMany({ where: { user: { email: E } } });
  await raw.user.deleteMany({ where: { email: E } });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await cleanup();
  const u = await raw.user.create({ data: { email: E, passwordHash: 'x', role: 'USER' } });
  uId = u.id;
});

afterAll(async () => {
  await cleanup();
  await raw.$disconnect();
  await prisma.$disconnect();
});

describe('TDA-015 redaction guard — no secret/signature leak', () => {
  it('neither the webhook secret nor the signature reaches logs or audit meta', async () => {
    // Capture every logger line + every audit payload.
    const logged: unknown[] = [];
    for (const level of ['log', 'warn', 'debug', 'error', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
        return undefined as never;
      });
    }
    const auditCalls: unknown[] = [];
    jest.spyOn(audit, 'append').mockImplementation(async (ev) => {
      auditCalls.push(ev);
      return { seq: 1n, hash: 'h' };
    });

    // Checkout (fake) then a valid signed webhook charge.
    await run(() => billing.createCheckout({ userId: uId, email: E }, 'INTRADAY'));
    const row = await raw.subscription.findUnique({
      where: { userId_segment: { userId: uId, segment: 'INTRADAY' } },
    });
    const providerSubId = row!.providerSubId!;

    const bodyStr = JSON.stringify({
      event: 'subscription.charged',
      created_at: 1_700_000_777,
      payload: {
        subscription: { entity: { id: providerSubId, current_end: Math.floor(Date.now() / 1000) + 2_592_000 } },
        payment: { entity: { id: 'pay_leak_wh_1' } },
      },
    });
    const body = Buffer.from(bodyStr);
    const sig = createHmac('sha256', FAKE_WEBHOOK_SECRET).update(body).digest('hex');
    await run(() => webhook.handle(body, sig));

    const haystack = JSON.stringify(logged) + JSON.stringify(auditCalls);
    expect(haystack).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(haystack).not.toContain(sig);

    jest.restoreAllMocks();
  });
});
