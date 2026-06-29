// scripts/cf-stop-sim.mjs  — R&D, read-only. No production changes.
// Counterfactual stop-rule simulation over recent BUY stop-outs.
// Reconstructs each symbol's intraday price path from chartink_alert_setups
// hitPrice (per-minute proxy) and replays alternative stop rules in R units.
//
// CAVEAT: hitPrice is a per-minute POINT sample, not a bar low/high. It misses
// intra-minute dips, so it UNDERSTATES stop breaches -> wider-stop results are
// OPTIMISTIC. The momentum scan also samples up-moves more, biasing the same way.
// Treat outputs as a directional upper-ish estimate, not ground truth.
//
// Run: node scripts/cf-stop-sim.mjs

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const DAYS = Number(process.env.DAYS ?? 10);

async function main() {
  const stops = await prisma.$queryRawUnsafe(`
    SELECT id, symbol, "executedPrice" AS entry, "profitTarget" AS target,
           "currentPrice" AS stop_px, "executedAt" AS exec_at, "closedAt" AS closed_at
    FROM watch_entries
    WHERE status='STOPPED' AND side='BUY' AND "executedPrice" IS NOT NULL
      AND "currentPrice" IS NOT NULL AND "executedAt" IS NOT NULL
      AND "createdAt" >= now() - interval '${DAYS} days'
  `);

  // Rules in PERCENT terms (stable; avoids divide-by-tiny-risk). Fixed % stops
  // below entry; grace ignores stop for first N min then applies the realized stop.
  const rules = [
    { name: 'baseline (realized stop)', kind: 'realized' },
    { name: 'fixed -0.5%',  kind: 'fixed', x: 0.5 },
    { name: 'fixed -1.0%',  kind: 'fixed', x: 1.0 },
    { name: 'fixed -1.5%',  kind: 'fixed', x: 1.5 },
    { name: 'fixed -2.0%',  kind: 'fixed', x: 2.0 },
    { name: 'grace10 +realized', kind: 'grace', graceMin: 10 },
    { name: 'grace20 +realized', kind: 'grace', graceMin: 20 },
    { name: 'no stop (target/EOD)', kind: 'none' },
  ];

  const agg = {};
  for (const r of rules) agg[r.name] = { wins: 0, stopped: 0, eod: 0, totalPct: 0, nodata: 0 };
  let withData = 0, noData = 0, recPct = [], dumpPct = [], riskPctArr = [];

  for (const s of stops) {
    const entry = +s.entry, target = +s.target, stop = +s.stop_px;
    if (!(entry > 0) || !(entry > stop)) continue;
    const realizedStopPct = (stop - entry) / entry * 100;  // negative
    const targetPct = (target - entry) / entry * 100;
    riskPctArr.push(-realizedStopPct);
    const day = new Date(s.closed_at); day.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(day.getTime() + 24 * 3600 * 1000);

    const path = await prisma.$queryRawUnsafe(`
      SELECT "hitPrice" AS p, "processedAt" AS t FROM chartink_alert_setups
      WHERE symbol = $1 AND "processedAt" >= $2 AND "processedAt" < $3 AND "hitPrice" IS NOT NULL
      ORDER BY "processedAt" ASC
    `, s.symbol, s.exec_at, dayEnd);

    if (path.length === 0) { noData++; for (const r of rules) agg[r.name].nodata++; continue; }
    withData++;
    const pts = path.map((x) => ({ p: +x.p, t: new Date(x.t).getTime() }));
    const t0 = new Date(s.exec_at).getTime();
    const maxP = Math.max(...pts.map((x) => x.p));
    recPct.push((maxP - entry) / entry * 100);
    const lastP = pts[pts.length - 1].p;
    if (maxP < entry) dumpPct.push((lastP - entry) / entry * 100);

    for (const r of rules) {
      const stopLevel = r.kind === 'fixed' ? entry * (1 - r.x / 100) : stop; // realized/grace use realized stop
      let outcome = null;
      for (const pt of pts) {
        const graced = r.kind === 'grace' && (pt.t - t0) / 60000 < r.graceMin;
        if (pt.p >= target) { outcome = targetPct; agg[r.name].wins++; break; }
        if (r.kind !== 'none' && !graced && pt.p <= stopLevel) {
          outcome = (stopLevel - entry) / entry * 100; agg[r.name].stopped++; break;
        }
      }
      if (outcome === null) { outcome = (lastP - entry) / entry * 100; agg[r.name].eod++; } // EOD exit
      agg[r.name].totalPct += outcome;
    }
  }

  const n = withData + noData;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const med = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  console.log(`\nBUY stop-outs (last ${DAYS}d): ${n}  | with path data: ${withData}  no-data: ${noData}`);
  console.log(`realized stop distance: avg ${avg(riskPctArr).toFixed(2)}%  median ${med(riskPctArr).toFixed(2)}%  (how tight our stop is)`);
  console.log(`recovery (maxP vs entry), with-data: avg +${avg(recPct).toFixed(2)}%  median +${med(recPct).toFixed(2)}%`);
  console.log(`dump (lastP vs entry) for never-recovered: avg ${avg(dumpPct).toFixed(2)}%  median ${med(dumpPct).toFixed(2)}%  (n=${dumpPct.length})`);
  console.log(`\nRule sim (PERCENT, equal-weight, over ${withData} with-data trades; no-data excluded):`);
  console.log(`  rule                    wins  stopped  eod   totalP&L%   avg%/trade`);
  for (const r of rules) {
    const a = agg[r.name];
    console.log(`  ${r.name.padEnd(22)} ${String(a.wins).padStart(4)} ${String(a.stopped).padStart(7)} ${String(a.eod).padStart(5)} ${a.totalPct.toFixed(1).padStart(9)} ${(a.totalPct / withData).toFixed(3).padStart(11)}`);
  }
  console.log(`\nCAVEAT: hitPrice misses intra-minute lows -> wider-stop "stopped" counts are UNDER-counted,`);
  console.log(`so wider-stop totals are OPTIMISTIC. no-data (${noData}) excluded — some may be dumps. Directional only.`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error('FAILED:', e?.message ?? e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
