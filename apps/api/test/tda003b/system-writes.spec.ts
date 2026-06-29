/**
 * TDA-003b — engine/system writes stamp the seeded ADMIN owner.
 *
 * TDA-001 made `userId` NOT NULL on tenant-owned models. Background/engine code
 * runs with NO tenant context, and the Prisma tenant-scoping interceptor only
 * stamps `userId` when a context is active (otherwise it passes through). So
 * engine `create`/`upsert` must stamp SYSTEM_USER_ID explicitly or hit a
 * Postgres NOT NULL violation.
 *
 * This drives the REAL repositories (TradeRepository, PortfolioRepository) over
 * a real PrismaService against td_saas_test with NO cls.run — exactly how the
 * engine runs — and asserts the persisted rows carry userId === SYSTEM_USER_ID
 * and that the write did not throw.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda003b/jest.config.js -v
 */

import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { SYSTEM_USER_ID } from '../../src/common/tenant/tenant.constants';
import { TradeRepository } from '../../src/modules/trade-engine/repositories/trade.repository';
import { PortfolioRepository } from '../../src/modules/portfolio/repositories/portfolio.repository';

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error(
    'DATABASE_URL_TEST must be set to the td_saas_test connection string ' +
      '(e.g. postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test)',
  );
}

// PrismaService resolves its connection from DATABASE_URL. Point it at the test
// DB so a stray run can NEVER touch the real td_saas database.
process.env.DATABASE_URL = testUrl;

// Ground-truth client: bypasses the scoping middleware entirely.
const raw = new PrismaClient({ datasources: { db: { url: testUrl } } });

// Wire a scoped client exactly as Nest would, but we deliberately NEVER call
// cls.run() below — so every repository write runs with NO tenant context,
// reproducing the engine/background execution path.
const als = new AsyncLocalStorage<Record<string, unknown>>();
const cls = new ClsService(als);
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);

const tradeRepo = new TradeRepository(prisma);
const portfolioRepo = new PortfolioRepository(prisma);

const INST_TOKEN = 'T003B_SYS';
const PERF_DATE = new Date('2099-01-02T00:00:00.000Z'); // far future ⇒ no collision

let instId: string;

async function cleanup(): Promise<void> {
  await raw.trade.deleteMany({ where: { instrument: { token: INST_TOKEN } } });
  await raw.dailyPerformance.deleteMany({ where: { date: PERF_DATE } });
  await raw.instrument.deleteMany({ where: { token: INST_TOKEN } });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await cleanup();

  // The seeded ADMIN user must exist (TDA-001 migration / seed). Guard so a
  // failure here is a clear "test DB not seeded" message, not a cryptic FK error.
  const admin = await raw.user.findUnique({ where: { id: SYSTEM_USER_ID } });
  if (!admin) {
    throw new Error(
      `Seeded ADMIN user ${SYSTEM_USER_ID} missing in td_saas_test — run the seed/migration first`,
    );
  }

  const inst = await raw.instrument.create({
    data: {
      symbol: 'TDA003BSYS',
      token: INST_TOKEN,
      name: 'TDA-003b System Write Instrument',
      exchange: 'NSE',
      segment: 'EQ',
    },
  });
  instId = inst.id;
});

afterAll(async () => {
  await cleanup();
  await raw.$disconnect();
  await prisma.$disconnect();
});

describe('TDA-003b — engine writes stamp SYSTEM_USER_ID with no tenant context', () => {
  it('TradeRepository.createTrade persists userId = SYSTEM_USER_ID (no NOT NULL violation)', async () => {
    const created = await tradeRepo.createTrade({
      instrumentId: instId,
      side: 'BUY',
      orderType: 'MARKET',
      positionType: 'LONG',
      quantity: 1,
      status: 'OPEN',
      isPaperTrade: true,
      notes: 'tda003b-system-write',
    });

    expect(created.userId).toBe(SYSTEM_USER_ID);

    // Ground-truth read via the unscoped client confirms the column was written.
    const persisted = await raw.trade.findUnique({ where: { id: created.id } });
    expect(persisted).not.toBeNull();
    expect(persisted?.userId).toBe(SYSTEM_USER_ID);
  });

  it('PortfolioRepository.saveDailySnapshot upsert (create branch) persists userId = SYSTEM_USER_ID', async () => {
    const result = await portfolioRepo.saveDailySnapshot(PERF_DATE, {
      totalPnl: 100,
      realizedPnl: 80,
      unrealizedPnl: 20,
      totalTrades: 3,
      winningTrades: 2,
      losingTrades: 1,
      maxDrawdown: -10,
      capitalDeployed: 5000,
    });

    expect(result.userId).toBe(SYSTEM_USER_ID);

    const persisted = await raw.dailyPerformance.findUnique({
      where: { date: PERF_DATE },
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.userId).toBe(SYSTEM_USER_ID);

    // Re-run hits the update branch (date is @unique) and must not throw or
    // change ownership — proving the no-userId `where` is safe for ADMIN.
    const again = await portfolioRepo.saveDailySnapshot(PERF_DATE, {
      totalPnl: 200,
      realizedPnl: 150,
      unrealizedPnl: 50,
      totalTrades: 4,
      winningTrades: 3,
      losingTrades: 1,
      maxDrawdown: -5,
      capitalDeployed: 6000,
    });
    expect(again.userId).toBe(SYSTEM_USER_ID);
    expect(again.totalPnl).toBe(200);
  });
});
