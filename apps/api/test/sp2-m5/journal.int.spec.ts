import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../src/common/prisma/prisma.service';
import { balances } from '../../src/modules/trade-core/execution/ledger-math';
import { CoreCashLedgerRepository } from '../../src/modules/trade-core/execution/repositories/core-cash-ledger.repository';
import { CoreCorpusWriter } from '../../src/modules/trade-core/journal/core-corpus.writer';
import { CoreJournalRepository } from '../../src/modules/trade-core/journal/repositories/core-journal.repository';
import type { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import type { ClsService } from 'nestjs-cls';
import { BrokerCorpusCron } from '../../src/modules/trade-core/journal/broker-corpus.cron';
import type { JobRunnerService } from '../../src/common/job-registry';

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

  it("unackedMismatches is one anti-join: acked and other users' mismatches are left out (review fix 5)", async () => {
    const u = await newUser();
    const other = await newUser();
    const m1 = await journal(u, 'RECON_MISMATCH', `recon:${rid()}`);
    const m2 = await journal(u, 'RECON_MISMATCH', `recon:${rid()}`);
    await journal(other, 'RECON_MISMATCH', `recon:${rid()}`);
    await journal(u, 'RECON_ACK', `ack:${m1}`);
    const repo = new CoreJournalRepository(db as unknown as PrismaService, {} as TenantContextService, { isActive: () => false } as unknown as ClsService);
    const rows = await repo.unackedMismatches(u);
    expect(rows.map((r) => r.id)).toEqual([m2]);
    expect(rows[0]).toMatchObject({ userId: u, type: 'RECON_MISMATCH', priceUsed: null, payload: {} });
    expect(rows[0].istDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

describe('ai_decision_records from the core (O9) against SQL', () => {
  it('a setup is written once; outcome patches merge', async () => {
    const u = await newUser();
    const w = new CoreCorpusWriter(db as unknown as PrismaService);
    const intentId = `ci_${rid()}`;
    const s = {
      intentId, userId: u, decidedAt: new Date(), symbol: 'RELIANCE-EQ', exchange: 'NSE', vehicle: 'CASH_INTRADAY' as const, direction: 'LONG' as const,
      strategyKey: 'ungated', strategyVersionId: 'csv_ungated_v1', setupGroupKey: `a|RELIANCE|x`, evidence: {}, ruleScore: 50, decision: { taken: true, reason: 'opened' },
    };
    await w.entrySetup(s);
    await w.entrySetup({ ...s, decision: { taken: false, reason: 'second write ignored' } });
    await w.outcome(intentId, { netPnl: 12.5 }, new Date());
    await w.outcome(intentId, { priceAfterClose: 503 }, new Date());
    const row = await db.aiDecisionRecord.findUnique({ where: { source_sourceId: { source: 'core', sourceId: intentId } } });
    expect(row?.decision).toEqual({ taken: true, reason: 'opened' });
    expect(row?.outcome).toEqual({ netPnl: 12.5, priceAfterClose: 503 });
    await db.aiDecisionRecord.delete({ where: { id: row?.id as string } });
  });
});

describe('broker trades into ai_decision_records (Task 13b) against SQL', () => {
  it('one record per closed F&O position tracker, joined to its verdicts; a rerun writes nothing', async () => {
    const u = await newUser();
    const trk = `trk_${rid()}`;
    await db.$executeRawUnsafe(
      `INSERT INTO "trade_trackers" ("id", "userId", "symbol", "exchange", "token", "kind", "entryPrice", "qty", "entryTime", "exitPrice", "exitTime", "status", "holdingHigh", "holdingLow", "updatedAt")
       VALUES ($1, $2, 'NIFTY14OCT2525000CE', 'NFO', '45000', 'POSITION', 100, 75, CURRENT_TIMESTAMP - interval '2 hours', 120, CURRENT_TIMESTAMP - interval '1 hour', 'CLOSED', 130, 90, CURRENT_TIMESTAMP)`,
      trk, u,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "sentinel_verdicts" ("id", "userId", "trackerId", "symbol", "verdict", "confidence", "thesisStatus", "recoveryAvailable", "reason", "evidence", "reviewInSec", "packet", "promptVersion", "triggeredBy", "netPnl")
       VALUES ($1, $2, $3, 'NIFTY14OCT2525000CE', 'HOLD', 'medium', 'INTACT', false, 'r', '{}'::jsonb, 60, '{}'::jsonb, 'p1', '["heartbeat"]'::jsonb, 0)`,
      `sv_${rid()}`, u, trk,
    );
    // createdAt defaults to now(), after the exit: move it inside the holding window.
    await db.$executeRawUnsafe(`UPDATE "sentinel_verdicts" SET "createdAt" = CURRENT_TIMESTAMP - interval '90 minutes' WHERE "trackerId" = $1`, trk);
    const jobs = { run: (_n: string, _o: unknown, fn: () => Promise<unknown>) => fn() };
    const cron = new BrokerCorpusCron(db as unknown as PrismaService, jobs as unknown as JobRunnerService);
    expect(await cron.sync(new Date())).toMatchObject({ written: 1 });
    expect(await cron.sync(new Date())).toMatchObject({ written: 0, already: 1 });
    const row = await db.aiDecisionRecord.findUnique({ where: { source_sourceId: { source: 'broker:tracker', sourceId: trk } } });
    expect(row).toMatchObject({ kind: 'BROKER_TRADE', userId: u, featureSet: null });
    expect((row?.decision as { verdictCount: number }).verdictCount).toBe(1);
    await db.aiDecisionRecord.delete({ where: { id: row?.id as string } });
  });
});
