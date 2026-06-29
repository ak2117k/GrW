// scripts/cf-real-candles.mjs — R&D, read-only. Counterfactual stop-rule sim on
// REAL OHLC (1m, 5m fallback). For each executed BUY trade, replay alternative
// fixed stop widths from the actual entry and see what each nets. No prod changes.
//
// Conservative: if a bar's LOW breaches the stop AND its HIGH reaches target in
// the same bar, the STOP is assumed to fill first (kills the proxy's optimism).
//
// Run: node scripts/cf-real-candles.mjs

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const DAYS = Number(process.env.DAYS ?? 12);
const STOPS = [0.4, 0.75, 1.0, 1.5, 2.0]; // fixed % stop widths to test (~0.4 ≈ current)

const med = (a) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

async function candlesFor(symbol, day, dayEnd) {
  for (const tf of ['1m', '5m']) {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT c.timestamp AS t, c.high AS h, c.low AS l, c.close AS cl
      FROM candles c JOIN instruments i ON i.id = c."instrumentId"
      WHERE (i.symbol=$1 OR i.symbol=$1||'-EQ') AND c.timeframe=$4
        AND c.timestamp >= $2 AND c.timestamp < $3
      ORDER BY c.timestamp ASC
    `, symbol, day, dayEnd, tf);
    if (rows.length >= 15) return rows.map((x) => ({ t: new Date(x.t).getTime(), h: +x.h, l: +x.l, c: +x.cl }));
  }
  return null;
}

// Return outcome % for a fixed stop width applied from entry over the bar path.
function simulate(bars, entry, target, stopPct) {
  const stopLevel = stopPct === null ? -Infinity : entry * (1 - stopPct / 100);
  for (const b of bars) {
    const hitStop = stopPct !== null && b.l <= stopLevel;
    const hitTarget = b.h >= target;
    if (hitStop) return { pnl: (stopLevel - entry) / entry * 100, kind: 'stop' }; // conservative: stop first
    if (hitTarget) return { pnl: (target - entry) / entry * 100, kind: 'win' };
  }
  return { pnl: (bars[bars.length - 1].c - entry) / entry * 100, kind: 'eod' };
}

async function main() {
  const trades = await prisma.$queryRawUnsafe(`
    SELECT symbol, "executedPrice" AS entry, "profitTarget" AS target, "executedAt" AS exec_at, status
    FROM watch_entries
    WHERE side='BUY' AND "executedAt" IS NOT NULL AND "executedPrice" IS NOT NULL AND "profitTarget" IS NOT NULL
      AND "createdAt" >= now() - interval '${DAYS} days'
  `);

  const rules = [...STOPS.map((x) => ({ name: `fixed -${x}%`, x })), { name: 'no stop (tgt/EOD)', x: null }];
  const agg = {}; for (const r of rules) agg[r.name] = { wins: 0, stop: 0, eod: 0, total: 0 };
  let covered = 0, noData = 0;
  const recAboveEntry = [], avail = { target: 0, n: 0 }; // independent recovery stats

  for (const t of trades) {
    const day = new Date(t.exec_at); day.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(day.getTime() + 24 * 3600 * 1000);
    const all = await candlesFor(t.symbol, day, dayEnd);
    if (!all) { noData++; continue; }
    const entry = +t.entry, target = +t.target, execAt = new Date(t.exec_at).getTime();
    const bars = all.filter((b) => b.t >= execAt);
    if (bars.length < 3 || !(entry > 0) || !(target > entry)) { noData++; continue; }
    covered++;

    // independent: did price recover above entry / reach target at all after entry?
    const maxH = Math.max(...bars.map((b) => b.h));
    recAboveEntry.push((maxH - entry) / entry * 100);
    avail.n++; if (maxH >= target) avail.target++;

    for (const r of rules) {
      const o = simulate(bars, entry, target, r.x);
      agg[r.name][o.kind === 'win' ? 'wins' : o.kind === 'stop' ? 'stop' : 'eod']++;
      agg[r.name].total += o.pnl;
    }
  }

  console.log(`\nCOUNTERFACTUAL ON REAL CANDLES — BUY trades last ${DAYS}d`);
  console.log('='.repeat(64));
  console.log(`trades=${trades.length}  covered (real OHLC)=${covered}  no-candles=${noData}`);
  console.log(`(coverage skews to the large-cap universe we backfill; small-cap open-spike names under-covered)`);
  console.log(`\nmax recovery above entry after our entry: median +${f(med(recAboveEntry))}%  | reached target intraday: ${avail.target}/${avail.n} = ${f(avail.target / avail.n * 100, 0)}%`);
  console.log(`\nFixed-stop sim from actual entry (conservative: stop fills before target in a straddling bar):`);
  console.log(`  rule                wins  stop   eod   total%   avg%/trade`);
  for (const r of rules) {
    const a = agg[r.name];
    console.log(`  ${r.name.padEnd(18)} ${String(a.wins).padStart(4)} ${String(a.stop).padStart(5)} ${String(a.eod).padStart(5)} ${f(a.total, 1).padStart(8)} ${f(a.total / covered, 3).padStart(11)}`);
  }
  console.log(`\nCAVEAT: coverage ${covered}/${trades.length}; 1m/5m granularity still misses sub-bar wicks. Directional but far better than the hitPrice proxy.`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error('FAILED:', e?.message ?? e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
