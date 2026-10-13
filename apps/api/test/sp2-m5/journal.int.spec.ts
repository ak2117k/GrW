import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../src/common/prisma/prisma.service';
import { balances } from '../../src/modules/trade-core/execution/ledger-math';
import { CoreCashLedgerRepository } from '../../src/modules/trade-core/execution/repositories/core-cash-ledger.repository';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at a throwaway database with all migrations applied');
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('refusing to run against a database that is not on 127.0.0.1');

const db = new PrismaClient({ datasources: { db: { url } } });
const run = `it${Date.now()}`;
const rid = () => Math.random().toString(36).slice(2, 10);

async function newUser(): Promise<string> {
  const id = `usr_${run}_${rid()}`;
  await db.$executeRawUnsafe(`INSERT INTO "users" ("id", "email", "passwordHash", "updatedAt") VALUES ($1, $1 || '@it.local', 'x', CURRENT_TIMESTAMP)`, id);
  return id;
}

async function journal(userId: string, type: string, dedupeKey: string | null = null): Promise<string> {
  const id = `jr_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_journal" ("id", "userId", "type", "payload", "dedupeKey", "istDay") VALUES ($1, $2, $3, '{}'::jsonb, $4, CURRENT_DATE)`,
    id, userId, type, dedupeKey,
  );
  return id;
}

async function closedPosition(userId: string): Promise<string> {
  const id = `pos_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_positions" ("id", "userId", "intentId", "strategyId", "strategyVersionId", "vehicle", "exchange", "token", "symbol", "lotSize", "underlying", "side", "direction", "status", "requestedQty", "entryFilledQty", "exitFilledQty", "plan", "exitReason", "closedAt", "updatedAt")
     VALUES ($1, $2, $1, 'cs_x', 'csv_x', 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', 1, 'RELIANCE', 'BUY', 'LONG', 'CLOSED', 100, 100, 100, '{}'::jsonb, 'TARGET', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    id, userId,
  );
  return id;
}

async function summary(userId: string, positionId: string, over: Record<string, string> = {}): Promise<void> {
  const v = { exitReason: 'TARGET', charges: '12.50', initialRisk: '750.00', ...over };
  await db.$executeRawUnsafe(
    `INSERT INTO "core_trade_summaries" ("id", "userId", "positionId", "intentId", "strategyId", "strategyVersionId", "vehicle", "exchange", "token", "symbol", "side", "qty", "entryAvgPrice", "exitAvgPrice", "openedAt", "closedAt", "grossPnl", "charges", "mtfInterest", "netPnl", "initialRisk", "holdMinutes", "exitReason", "istDay")
     VALUES ($1, $2, $3, $3, 'cs_x', 'csv_x', 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', 'BUY', 100, 500, 515, CURRENT_TIMESTAMP - interval '1 hour', CURRENT_TIMESTAMP, 1500, $4::numeric, 0, 1487.50, $5::numeric, 60, $6, CURRENT_DATE)`,
    `sum_${rid()}`, userId, positionId, v.charges, v.initialRisk, v.exitReason,
  );
}

afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" LIKE $1`, `usr_${run}_%`);
  await db.$disconnect();
});

describe('core_journal (SP2 M5 migration)', () => {
  it('accepts a known type and refuses an unknown one', async () => {
    const u = await newUser();
    await expect(journal(u, 'FILL')).resolves.toMatch(/^jr_/);
    await expect(journal(u, 'GOSSIP')).rejects.toThrow(/core_journal_type_check/);
  });

  it('a dedupe key is unique and ON CONFLICT DO NOTHING skips the second write', async () => {
    const u = await newUser();
    const key = `fill:${rid()}`;
    await journal(u, 'FILL', key);
    await expect(journal(u, 'FILL', key)).rejects.toThrow(/23505[\s\S]*dedupeKey/); // Prisma reports the key, not the index name
    const n = await db.$executeRawUnsafe(
      `INSERT INTO "core_journal" ("id", "userId", "type", "payload", "dedupeKey", "istDay") VALUES ($1, $2, 'FILL', '{}'::jsonb, $3, CURRENT_DATE) ON CONFLICT DO NOTHING`,
      `jr_${rid()}`, u, key,
    );
    expect(n).toBe(0);
  });

  it('is append-only: UPDATE is refused, the user cascade still deletes', async () => {
    const u = await newUser();
    const id = await journal(u, 'BLIND');
    await expect(db.$executeRawUnsafe(`UPDATE "core_journal" SET "type" = 'FILL' WHERE "id" = $1`, id)).rejects.toThrow(/append-only/);
    await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = $1`, u);
    expect(await db.coreJournal.count({ where: { id } })).toBe(0);
  });
});

describe('core_trade_summaries (SP2 M5 migration)', () => {
  it('one summary per position; an unknown exit reason, negative charges or a zero risk are refused', async () => {
    const u = await newUser();
    const p = await closedPosition(u);
    await expect(summary(u, p, { exitReason: 'BORED' })).rejects.toThrow(/core_trade_summaries_vocab_check/);
    await expect(summary(u, p, { charges: '-1.00' })).rejects.toThrow(/core_trade_summaries_shape_check/);
    await expect(summary(u, p, { initialRisk: '0.00' })).rejects.toThrow(/core_trade_summaries_shape_check/);
    await summary(u, p);
    await expect(summary(u, p)).rejects.toThrow(/23505[\s\S]*positionId/);
  });

  it('is append-only, and deleting the position cascades', async () => {
    const u = await newUser();
    const p = await closedPosition(u);
    await summary(u, p);
    await expect(db.$executeRawUnsafe(`UPDATE "core_trade_summaries" SET "qty" = 1 WHERE "positionId" = $1`, p)).rejects.toThrow(/append-only/);
    await db.$executeRawUnsafe(`DELETE FROM "core_positions" WHERE "id" = $1`, p);
    expect(await db.coreTradeSummary.count({ where: { positionId: p } })).toBe(0);
  });
});


describe('bounded ledger reads (J19) against SQL', () => {
  it('sumsByType through balances() equals balances() over every row; held margin per vehicle', async () => {
    const u = await newUser();
    const ord = `ord_${rid()}`;
    await db.$executeRawUnsafe(
      `INSERT INTO "core_orders" ("id", "userId", "idempotencyKey", "vehicle", "exchange", "token", "symbol", "lotSize", "side", "qty", "type", "refPrice", "purpose", "state", "submittedAt", "updatedAt")
       VALUES ($1, $2, $1, 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', 1, 'BUY', 10, 'MARKET', 500, 'ENTRY', 'CANCELLED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ord, u,
    );
    for (const [type, amount, orderId] of [['DEPOSIT', '1000000.00', null], ['MARGIN_BLOCK', '-1000.00', ord], ['MARGIN_RELEASE', '1000.00', ord]] as const) {
      await db.$executeRawUnsafe(
        `INSERT INTO "core_cash_ledger" ("id", "userId", "type", "amount", "orderId", "note") VALUES ($1, $2, $3, $4::numeric, $5, 'it')`,
        `led_${rid()}`, u, type, amount, orderId,
      );
    }
    const repo = new CoreCashLedgerRepository(db as unknown as PrismaService);
    const full = balances(await repo.listForUser(u));
    const agg = balances(await repo.sumsByType(u));
    expect(agg.cash.toFixed(2)).toBe(full.cash.toFixed(2));
    expect(agg.blockedMargin.toFixed(2)).toBe(full.blockedMargin.toFixed(2));
    expect((await repo.heldMarginByVehicle(u)).get('CASH_INTRADAY')?.toFixed(2)).toBe('0.00');
  });
});
