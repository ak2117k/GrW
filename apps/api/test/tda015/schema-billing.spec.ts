/**
 * TDA-015 Task 2 — additive schema (BillingProfile, WebhookEvent, Subscription
 * provider columns).
 *
 * DB-backed against the throw-away scratch DB. Proves:
 *   - a BillingProfile row (one per user; unique providerCustomerId) persists;
 *   - a Subscription carries providerSubId/providerPlanId/graceUntil and an
 *     upsert can set them;
 *   - WebhookEvent @@unique([provider, eventId]) rejects a duplicate (P2002) —
 *     the webhook dedupe key.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda015 \
 *     npx jest --config test/tda015/jest.config.js schema-billing --runInBand --verbose
 */
import { Prisma, PrismaClient } from '@prisma/client';

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error('DATABASE_URL_TEST must point at the scratch td_saas_tda015 DB');
}

const prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });

const PREFIX = 'tda015-schema';
const email = `${PREFIX}-${Date.now()}@t.local`;
let userId: string;

async function cleanup(): Promise<void> {
  await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: PREFIX } } });
  await prisma.subscription.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
  await prisma.billingProfile.deleteMany({
    where: { providerCustomerId: { startsWith: PREFIX } },
  });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

beforeAll(async () => {
  await prisma.$connect();
  await cleanup();
  const user = await prisma.user.create({
    data: { email, passwordHash: 'x' },
  });
  userId = user.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('TDA-015 schema — BillingProfile', () => {
  it('persists a BillingProfile with a unique providerCustomerId', async () => {
    const profile = await prisma.billingProfile.create({
      data: {
        userId,
        providerCustomerId: `${PREFIX}-cust-1`,
        gstin: '27AAAAA0000A1Z5',
        billingName: 'Test Buyer',
      },
    });
    expect(profile.userId).toBe(userId);
    expect(profile.providerCustomerId).toBe(`${PREFIX}-cust-1`);
  });
});

describe('TDA-015 schema — Subscription provider columns', () => {
  it('an upsert can set providerSubId / providerPlanId / graceUntil', async () => {
    const grace = new Date(Date.now() + 3 * 86_400_000);
    const row = await prisma.subscription.upsert({
      where: { userId_segment: { userId, segment: 'INTRADAY' } },
      update: {
        providerSubId: `${PREFIX}-sub-1`,
        providerPlanId: `${PREFIX}-plan-1`,
        graceUntil: grace,
      },
      create: {
        userId,
        segment: 'INTRADAY',
        status: 'PAST_DUE',
        providerSubId: `${PREFIX}-sub-1`,
        providerPlanId: `${PREFIX}-plan-1`,
        graceUntil: grace,
      },
    });
    expect(row.providerSubId).toBe(`${PREFIX}-sub-1`);
    expect(row.providerPlanId).toBe(`${PREFIX}-plan-1`);
    expect(row.graceUntil?.getTime()).toBe(grace.getTime());
  });

  it('providerSubId is unique', async () => {
    // Fresh user so the (userId, segment) unique does not mask the providerSubId one.
    const other = await prisma.user.create({
      data: { email: `${PREFIX}-other-${Date.now()}@t.local`, passwordHash: 'x' },
    });
    await expect(
      prisma.subscription.create({
        data: {
          userId: other.id,
          segment: 'SWING',
          status: 'PAST_DUE',
          providerSubId: `${PREFIX}-sub-1`, // duplicate of the row above
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('TDA-015 schema — WebhookEvent dedupe', () => {
  it('rejects a duplicate (provider, eventId) with P2002', async () => {
    const eventId = `${PREFIX}-evt-1`;
    await prisma.webhookEvent.create({
      data: { provider: 'razorpay', eventId, eventType: 'subscription.charged', payloadHash: 'h1' },
    });
    await expect(
      prisma.webhookEvent.create({
        data: { provider: 'razorpay', eventId, eventType: 'subscription.charged', payloadHash: 'h1' },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    // ...and specifically the unique-constraint code.
    const dupe = prisma.webhookEvent.create({
      data: { provider: 'razorpay', eventId, eventType: 'x', payloadHash: 'h2' },
    });
    await expect(dupe).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows the same eventId under a different provider', async () => {
    const eventId = `${PREFIX}-evt-2`;
    await prisma.webhookEvent.create({
      data: { provider: 'razorpay', eventId, eventType: 'x', payloadHash: 'h' },
    });
    const ok = await prisma.webhookEvent.create({
      data: { provider: 'stripe', eventId, eventType: 'x', payloadHash: 'h' },
    });
    expect(ok.provider).toBe('stripe');
  });
});
