// One-shot front-month roll for MCX commodities (CRUDEOIL, COPPER).
//
// WHY: MCX FUTCOM contracts are monthly. The seed/backfill scripts hardcoded
// April 2026 tokens; once that contract expired (~19th of the expiry month),
// our chart kept reading from a stale, thinly-traded token whose prices
// drifted away from the active front-month — producing visible chart gaps
// and a wrong header price.
//
// WHAT: this script reads Angel One's public ScripMaster JSON, finds the
// nearest non-expired FUTCOM contract for each tracked commodity, and
// rotates the existing instrument row's `token` field to point at it.
// Old candles for the row are deleted (they belong to the previous contract)
// so the chart shows a clean, single-contract series after re-backfill.
//
// WHEN: run this manually now to fix the current gap; the same logic runs
// daily via CommodityRollService (NestJS cron) so this only needs to be
// invoked by hand for the very first roll.
//
// AFTER: re-run scripts/backfill-mcx-candles.mjs to refill candles from the
// new token. The daily 23:35 IST cron will keep them current going forward.
//
// Usage:
//   node scripts/roll-mcx-front-month.mjs
//   DRY_RUN=1 node scripts/roll-mcx-front-month.mjs   # preview only
//   COMMODITIES=CRUDEOIL node scripts/roll-mcx-front-month.mjs
//
// Idempotent — if the DB token already matches today's front-month, this
// is a no-op for that commodity.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const SCRIPMASTER_URL =
  'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

const TRACKED = (process.env.COMMODITIES ?? 'CRUDEOIL,COPPER')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const DRY_RUN = process.env.DRY_RUN === '1';

const prisma = new PrismaClient();

/**
 * Angel One's expiry strings look like "29MAY2026". Parse to a Date at
 * UTC midnight so comparisons are timezone-safe (we only care about
 * day-granularity).
 */
function parseExpiry(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  const [, dd, mon, yyyy] = m;
  const months = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const monthIdx = months[mon];
  if (monthIdx === undefined) return null;
  return new Date(Date.UTC(Number(yyyy), monthIdx, Number(dd)));
}

async function fetchMaster() {
  console.log(`▶ Downloading ScripMaster from ${SCRIPMASTER_URL}`);
  const resp = await fetch(SCRIPMASTER_URL);
  if (!resp.ok) {
    throw new Error(`ScripMaster fetch failed: HTTP ${resp.status}`);
  }
  const all = await resp.json();
  console.log(`▶ Downloaded ${all.length} total instruments`);
  return all;
}

/**
 * For one commodity name, return the front-month FUTCOM record on MCX:
 * the row whose expiry is the smallest date that is still >= today.
 * Returns null if nothing matches (shouldn't happen for liquid commodities).
 */
function pickFrontMonth(master, name) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const candidates = master
    .filter(
      (r) =>
        r.exch_seg === 'MCX' &&
        r.instrumenttype === 'FUTCOM' &&
        r.name === name,
    )
    .map((r) => ({ ...r, _expiry: parseExpiry(r.expiry) }))
    .filter((r) => r._expiry && r._expiry >= today)
    .sort((a, b) => a._expiry - b._expiry);

  return candidates[0] ?? null;
}

async function rollOne(master, name) {
  console.log(`\n── ${name} ──`);

  const front = pickFrontMonth(master, name);
  if (!front) {
    console.log(`  ✖ no front-month FUTCOM found on MCX for ${name}`);
    return { name, status: 'NO_MATCH' };
  }
  console.log(
    `  Front-month: ${front.symbol} (token ${front.token}, expiry ${front.expiry}, lot ${front.lotsize})`,
  );

  const row = await prisma.instrument.findFirst({
    where: { symbol: name, exchange: 'MCX' },
    select: { id: true, token: true, symbol: true, lotSize: true },
  });
  if (!row) {
    console.log(`  ✖ no instruments row for symbol=${name}, exchange=MCX`);
    console.log(`    Run: node scripts/seed-mcx-commodities.mjs first`);
    return { name, status: 'NO_DB_ROW' };
  }

  if (row.token === String(front.token)) {
    console.log(`  ✓ already on front-month (token ${row.token}); no-op`);
    return { name, status: 'NOOP', token: row.token };
  }

  console.log(`  → rolling ${row.token} → ${front.token}`);

  if (DRY_RUN) {
    console.log(`  (DRY_RUN — no DB writes)`);
    return { name, status: 'DRY_RUN', oldToken: row.token, newToken: String(front.token) };
  }

  // Wipe candles for the old contract — they're a different price series
  // and would create the discontinuity the user just reported.
  const deleted = await prisma.candle.deleteMany({
    where: { instrumentId: row.id },
  });
  console.log(`  • cleared ${deleted.count} stale candles`);

  await prisma.instrument.update({
    where: { id: row.id },
    data: {
      token: String(front.token),
      lotSize: Number(front.lotsize) || row.lotSize,
      isActive: true,
    },
  });
  console.log(`  ✓ token updated; instrument row now points at ${front.symbol}`);

  return {
    name,
    status: 'ROLLED',
    oldToken: row.token,
    newToken: String(front.token),
    expiry: front.expiry,
    candlesCleared: deleted.count,
  };
}

async function main() {
  console.log(`=== MCX front-month roll ===`);
  console.log(`Tracking: ${TRACKED.join(', ')}${DRY_RUN ? '  (DRY RUN)' : ''}`);

  const master = await fetchMaster();
  const results = [];
  for (const name of TRACKED) {
    const r = await rollOne(master, name);
    results.push(r);
  }

  console.log(`\n=== Summary ===`);
  for (const r of results) {
    console.log(`  ${r.name.padEnd(12)} ${r.status}`);
  }

  const rolled = results.filter((r) => r.status === 'ROLLED');
  if (rolled.length > 0) {
    console.log(`\nNext steps:`);
    console.log(`  1. node scripts/backfill-mcx-candles.mjs   # refill candles`);
    console.log(`  2. Restart the API to pick up new token in MarketFeedService`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(`\nROLL FAILED:`, e?.message ?? e);
  if (e?.stack) console.error(e.stack);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
