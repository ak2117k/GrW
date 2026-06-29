#!/usr/bin/env node
/**
 * One-shot correction for historical paper Trade rows that recorded the
 * wrong exitPrice (and hence wrong pnl) because of a bug in
 * TradeExecutionService.closeTrade — the close path fell back to the
 * cached LTP at simulation time instead of using the actual stop/target
 * trigger price the watch-monitor knew. Fixed forward in commit 9fb5bcd.
 *
 * This script walks closed paper Trade rows for the three affected exit
 * types and corrects exitPrice + pnl + pnlPercent from the canonical
 * trigger price persisted on the matching WatchEvent (SL_HIT_PRICE,
 * TARGET_HIT, TRAILING_STOP_HIT). `fees` is intentionally NOT touched —
 * SEBI/exchange charges depend on turnover, which is qty × price; the
 * tiny price-driven delta on charges is well below the rounding noise
 * already present in the fees model.
 *
 * Usage:
 *   node scripts/fix-paper-trade-exit-prices.mjs           # dry-run
 *   node scripts/fix-paper-trade-exit-prices.mjs --apply   # write
 *
 * Safe to run multiple times: rows whose exitPrice already matches the
 * WatchEvent trigger (within ±0.01) are skipped.
 */
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const PRICE_EPSILON = 0.01; // rupees — DB stores Float, allow tiny noise

// Map closedReason (on the linked WatchEntry) → WatchEventType that holds
// the canonical trigger price. We deliberately do NOT correct score-decay /
// manual / EOD stops: those paths never had a trigger price to assert,
// and the cached-LTP fallback there is the intended behaviour.
const REASON_TO_EVENT = {
  'loss-cut':       'SL_HIT_PRICE',
  'target-hit':     'TARGET_HIT',
  'trailing-stop':  'TRAILING_STOP_HIT',
};

const prisma = new PrismaClient();

function fmt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const s = n < 0 ? '-' : '';
  return `${s}₹${Math.abs(n).toFixed(2)}`;
}

async function main() {
  // Pull all closed paper trades whose linked WatchEntry was closed for one
  // of the affected reasons. Join is two-hop: Trade.id == WatchEntry.paperTradeId,
  // then WatchEntry.id → WatchEvent.watchEntryId.
  const affectedEntries = await prisma.watchEntry.findMany({
    where: {
      paperTradeId: { not: null },
      closedReason: { in: Object.keys(REASON_TO_EVENT) },
    },
    select: {
      id: true,
      symbol: true,
      side: true,
      closedReason: true,
      closedAt: true,
      paperTradeId: true,
      // partial-exit context for trailing-stop reconstructions:
      partialQty: true,
      partialExitPrice: true,
      partialExitedAt: true,
      remainingQty: true,
    },
    orderBy: { closedAt: 'asc' },
  });

  const candidates = [];
  let skipped = { noTrade: 0, noEvent: 0, alreadyCorrect: 0, badData: 0 };

  for (const entry of affectedEntries) {
    const trade = await prisma.trade.findUnique({
      where: { id: entry.paperTradeId },
    });
    if (!trade || trade.status !== 'CLOSED' || !trade.isPaperTrade) {
      skipped.noTrade++;
      continue;
    }

    const wantEvent = REASON_TO_EVENT[entry.closedReason];
    // Take the latest matching trigger event for this entry — partial-exit
    // can write multiple events over a session in edge cases.
    const triggerEvent = await prisma.watchEvent.findFirst({
      where: { watchEntryId: entry.id, eventType: wantEvent },
      orderBy: { createdAt: 'desc' },
      select: { price: true, createdAt: true },
    });
    if (!triggerEvent || triggerEvent.price == null || triggerEvent.price <= 0) {
      skipped.noEvent++;
      continue;
    }

    const correctExitPrice = triggerEvent.price;
    const currentExitPrice = trade.exitPrice ?? 0;
    if (Math.abs(correctExitPrice - currentExitPrice) <= PRICE_EPSILON) {
      skipped.alreadyCorrect++;
      continue;
    }

    if (!trade.entryPrice || trade.entryPrice <= 0 || !trade.quantity) {
      skipped.badData++;
      continue;
    }

    const sideMul = trade.side === 'BUY' ? 1 : -1;

    // For the final close, the slice is the CURRENT trade.quantity (which
    // already reflects any earlier partial reduction). The cumulative pnl
    // is partial.slicePnl + final.slicePnl. For single-close exits
    // (loss-cut / target-hit) the partial leg is absent → just final.slicePnl.
    let partialSlicePnl = 0;
    if (entry.closedReason === 'trailing-stop' && entry.partialExitedAt) {
      const partialPx = entry.partialExitPrice ?? 0;
      const partialQty = entry.partialQty ?? 0;
      if (partialPx > 0 && partialQty > 0) {
        partialSlicePnl = sideMul * (partialPx - trade.entryPrice) * partialQty;
      } else {
        // We can't fully reconstruct — fall through to single-leg math
        // (will be wrong by the partial-leg pnl, which the user can fix
        // by re-running once the partial-exit bug is also fixed forward).
      }
    }
    const finalSlicePnl =
      sideMul * (correctExitPrice - trade.entryPrice) * trade.quantity;
    const correctPnl = partialSlicePnl + finalSlicePnl;
    const correctPnlPct =
      (sideMul * (correctExitPrice - trade.entryPrice) / trade.entryPrice) * 100;

    candidates.push({
      tradeId: trade.id,
      symbol: entry.symbol,
      side: trade.side,
      qty: trade.quantity,
      entryPrice: trade.entryPrice,
      closedReason: entry.closedReason,
      oldExitPrice: trade.exitPrice ?? 0,
      newExitPrice: correctExitPrice,
      oldPnl: trade.pnl ?? 0,
      newPnl: correctPnl,
      pnlDiff: correctPnl - (trade.pnl ?? 0),
      newPnlPct: correctPnlPct,
      hasPartial:
        entry.closedReason === 'trailing-stop' && entry.partialExitedAt != null,
    });
  }

  // Print
  console.log(`\nCandidates for correction: ${candidates.length}`);
  console.log(`Skipped: noTrade=${skipped.noTrade}, noEvent=${skipped.noEvent}, alreadyCorrect=${skipped.alreadyCorrect}, badData=${skipped.badData}\n`);

  if (candidates.length === 0) {
    console.log('Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  console.log('Symbol       Reason          Side Qty    Entry        Old exit     New exit     Old pnl       New pnl       Δ pnl        Partial?');
  console.log('-'.repeat(140));
  let totalOldPnl = 0;
  let totalNewPnl = 0;
  for (const c of candidates) {
    totalOldPnl += c.oldPnl;
    totalNewPnl += c.newPnl;
    console.log(
      [
        c.symbol.padEnd(12),
        c.closedReason.padEnd(15),
        c.side.padEnd(4),
        String(c.qty).padEnd(6),
        fmt(c.entryPrice).padEnd(12),
        fmt(c.oldExitPrice).padEnd(12),
        fmt(c.newExitPrice).padEnd(12),
        fmt(c.oldPnl).padEnd(13),
        fmt(c.newPnl).padEnd(13),
        fmt(c.pnlDiff).padEnd(12),
        c.hasPartial ? 'yes' : 'no',
      ].join(' '),
    );
  }
  console.log('-'.repeat(140));
  console.log(
    `Totals: oldPnl=${fmt(totalOldPnl)}  newPnl=${fmt(totalNewPnl)}  ` +
      `swing=${fmt(totalNewPnl - totalOldPnl)} on ${candidates.length} trades\n`,
  );

  if (!APPLY) {
    console.log('DRY-RUN — no rows were modified.');
    console.log('Re-run with --apply to commit the corrections to the DB.');
    await prisma.$disconnect();
    return;
  }

  // Backup BEFORE we touch anything. Snapshot the full Trade rows we're
  // about to modify so a restore is `prisma.trade.update({ where: { id },
  // data: <row> })` per row. Filename embeds an ISO timestamp + run count.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.resolve(
    process.cwd(),
    `tmp-trade-exit-price-backup-${stamp}.json`,
  );
  const beforeRows = [];
  for (const c of candidates) {
    const row = await prisma.trade.findUnique({ where: { id: c.tradeId } });
    if (row) beforeRows.push(row);
  }
  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        purpose:
          'Pre-correction snapshot of Trade rows being patched by ' +
          'scripts/fix-paper-trade-exit-prices.mjs. Restore by re-applying ' +
          'each row via prisma.trade.update({ where: { id }, data: <row> }).',
        rows: beforeRows,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`Backup written: ${backupPath} (${beforeRows.length} rows)\n`);

  // Apply
  let updated = 0;
  for (const c of candidates) {
    await prisma.trade.update({
      where: { id: c.tradeId },
      data: {
        exitPrice: c.newExitPrice,
        pnl: c.newPnl,
        pnlPercent: c.newPnlPct,
      },
    });
    updated++;
  }
  console.log(`Applied: ${updated} trade rows updated.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
