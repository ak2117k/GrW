/**
 * TDA-010 Task 2 — FanoutEligibilityService (DB-backed, Style-A focused boot).
 *
 * Seeds users across the subscribed / connected / auto-on combinations into the
 * throw-away scratch DB and asserts eligibleUserIds() returns ONLY the fully
 * eligible user, fail-closed. A raw PrismaClient (no tenant middleware) seeds and
 * makes ground-truth assertions; the service under test runs unscoped via
 * runWithoutTenant, exactly as it does in a queue worker (no request context).
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda010 \
 *     npx jest --config test/tda010/jest.config.js eligibility --runInBand --verbose
 */
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { FanoutEligibilityService } from '../../src/modules/signal-fanout/services/fanout-eligibility.service';

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error('DATABASE_URL_TEST must point at the scratch td_saas_tda010 DB');
}
process.env.DATABASE_URL = testUrl;

const raw = new PrismaClient({ datasources: { db: { url: testUrl } } });

const als = new AsyncLocalStorage<Record<string, unknown>>();
const cls = new ClsService(als);
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const service = new FanoutEligibilityService(prisma, tenant, cls);

const SUFFIX = 'tda010-elig';
const EMAILS = ['a', 'b', 'c', 'd', 'e'].map((x) => `${SUFFIX}-${x}@test.local`);
const ids: Record<string, string> = {};

const encFields = {
  encApiKey: 'x', encApiSecret: 'x', encClientId: 'x', encPassword: 'x',
  encTotpSecret: 'x', encDataKey: 'x',
};

async function cleanup(): Promise<void> {
  await raw.user.deleteMany({ where: { email: { in: EMAILS } } });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await cleanup();

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // (a) fully eligible: ACTIVE non-expired sub + enabled/!kill consent + active cred
  ids.a = (await raw.user.create({ data: { email: EMAILS[0], passwordHash: 'x', role: 'USER',
    subscriptions: { create: { segment: 'INTRADAY', status: 'ACTIVE', expiresAt: null } },
    autoTradeConsents: { create: { segment: 'INTRADAY', enabled: true, killSwitch: false, riskPerTrade: 1000, maxCapital: 50000 } },
    brokerCredential: { create: { ...encFields, isActive: true } },
  } })).id;

  // (b) subscribed + connected but consent.enabled = false
  ids.b = (await raw.user.create({ data: { email: EMAILS[1], passwordHash: 'x', role: 'USER',
    subscriptions: { create: { segment: 'INTRADAY', status: 'ACTIVE' } },
    autoTradeConsents: { create: { segment: 'INTRADAY', enabled: false, killSwitch: false } },
    brokerCredential: { create: { ...encFields, isActive: true } },
  } })).id;

  // (c) subscribed + connected + enabled but killSwitch = true
  ids.c = (await raw.user.create({ data: { email: EMAILS[2], passwordHash: 'x', role: 'USER',
    subscriptions: { create: { segment: 'INTRADAY', status: 'ACTIVE' } },
    autoTradeConsents: { create: { segment: 'INTRADAY', enabled: true, killSwitch: true } },
    brokerCredential: { create: { ...encFields, isActive: true } },
  } })).id;

  // (d) enabled + connected but subscription expired (expiresAt in the past)
  ids.d = (await raw.user.create({ data: { email: EMAILS[3], passwordHash: 'x', role: 'USER',
    subscriptions: { create: { segment: 'INTRADAY', status: 'ACTIVE', expiresAt: yesterday } },
    autoTradeConsents: { create: { segment: 'INTRADAY', enabled: true, killSwitch: false } },
    brokerCredential: { create: { ...encFields, isActive: true } },
  } })).id;

  // (e) subscribed + enabled but BrokerCredential.isActive = false
  ids.e = (await raw.user.create({ data: { email: EMAILS[4], passwordHash: 'x', role: 'USER',
    subscriptions: { create: { segment: 'INTRADAY', status: 'ACTIVE' } },
    autoTradeConsents: { create: { segment: 'INTRADAY', enabled: true, killSwitch: false } },
    brokerCredential: { create: { ...encFields, isActive: false } },
  } })).id;
});

afterAll(async () => {
  await cleanup();
  await raw.$disconnect();
  await prisma.$disconnect();
});

describe('FanoutEligibilityService.eligibleUserIds', () => {
  it('returns ONLY the fully eligible user for INTRADAY', async () => {
    const users = await service.eligibleUserIds('INTRADAY');
    const seeded = users.filter((u) => Object.values(ids).includes(u.userId));
    expect(seeded.map((u) => u.userId)).toEqual([ids.a]);
  });

  it('carries the eligible user riskPerTrade + maxCapital', async () => {
    const users = await service.eligibleUserIds('INTRADAY');
    const a = users.find((u) => u.userId === ids.a);
    expect(a).toBeDefined();
    expect(a!.riskPerTrade).toBe(1000);
    expect(a!.maxCapital).toBe(50000);
  });

  it('excludes disabled/kill-switched/expired/disconnected users (fail-closed)', async () => {
    const users = await service.eligibleUserIds('INTRADAY');
    const returned = users.map((u) => u.userId);
    for (const key of ['b', 'c', 'd', 'e']) {
      expect(returned).not.toContain(ids[key]);
    }
  });

  it('returns nothing for a segment with no eligible users (SWING)', async () => {
    const users = await service.eligibleUserIds('SWING');
    const seeded = users.filter((u) => Object.values(ids).includes(u.userId));
    expect(seeded).toEqual([]);
  });
});
