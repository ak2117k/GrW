/**
 * One-shot script: remove all paper trades from the journal so the user
 * can start clean tomorrow. April-May 2026 entries had broken fills
 * (entry=exit prices, ₹0 exits, -100%/+100% returns) — the user reviewed
 * the journal and asked for them to be wiped.
 *
 * Scope:
 *   - DELETE FROM trades WHERE isPaperTrade = true
 *   - DELETE FROM ai_trade_analyses where tradeId matches (orphan cleanup —
 *     tradeId is a plain string column, no FK cascade)
 *
 * Live trades are left alone. WatchEntry rows are left alone (separate
 * lifecycle data, paperTradeId is also a plain string so no FK issues).
 *
 * Run with: npx ts-node scripts/clear-paper-trade-journal.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Clearing paper trade journal ---');

  const paperTradeCount = await prisma.trade.count({
    where: { isPaperTrade: true },
  });
  const liveTradeCount = await prisma.trade.count({
    where: { isPaperTrade: false },
  });
  console.log(`Before: ${paperTradeCount} paper, ${liveTradeCount} live`);

  if (paperTradeCount === 0) {
    console.log('Nothing to delete. Exiting.');
    return;
  }

  // Capture the IDs first so we can orphan-clean ai_trade_analyses.
  const paperTradeIds = await prisma.trade.findMany({
    where: { isPaperTrade: true },
    select: { id: true },
  });
  const ids = paperTradeIds.map((t) => t.id);

  // Orphan AI analyses (tradeId is a plain string column — no FK cascade).
  const analysisDeleted = await prisma.aITradeAnalysis.deleteMany({
    where: { tradeId: { in: ids } },
  });
  console.log(`Deleted ${analysisDeleted.count} AITradeAnalysis rows`);

  // Now the trades themselves.
  const tradesDeleted = await prisma.trade.deleteMany({
    where: { isPaperTrade: true },
  });
  console.log(`Deleted ${tradesDeleted.count} paper trades`);

  // Confirm.
  const remaining = await prisma.trade.count({
    where: { isPaperTrade: true },
  });
  const liveRemaining = await prisma.trade.count({
    where: { isPaperTrade: false },
  });
  console.log(`After: ${remaining} paper (expect 0), ${liveRemaining} live (untouched)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
