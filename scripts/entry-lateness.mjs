// scripts/entry-lateness.mjs — R&D, read-only. Quantifies how late our entries
// are vs the momentum impulse, using chartink_alert_setups hitPrice as a
// per-minute intraday price proxy. No production changes.
//
// Per BUY trade (last N days): first-detection->entry lag, pre-entry run %,
// where entry sits in the range seen up to entry (0=low,1=high), and headroom
// left to the day's high. Split by outcome.
//
// CAVEAT: hitPrice is a per-minute scan-trigger proxy (not true OHLC); momentum
// scans sample up-moves. Directional, not exact.
//
// Run: node scripts/entry-lateness.mjs

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const DAYS = Number(process.env.DAYS ?? 10);

const pct = (a, p) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
const med = (a) => pct(a, 0.5);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');

async function main() {
  const trades = await prisma.$queryRawUnsafe(`
    SELECT symbol, "executedPrice" AS entry, "executedAt" AS exec_at, status
    FROM watch_entries
    WHERE side='BUY' AND "executedAt" IS NOT NULL AND "executedPrice" IS NOT NULL
      AND "createdAt" >= now() - interval '${DAYS} days'
  `);

  const rows = [];
  for (const t of trades) {
    const entry = +t.entry;
    const execAt = new Date(t.exec_at).getTime();
    const day = new Date(t.exec_at); day.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(day.getTime() + 24 * 3600 * 1000);
    const path = await prisma.$queryRawUnsafe(`
      SELECT "hitPrice" AS p, "processedAt" AS t FROM chartink_alert_setups
      WHERE symbol=$1 AND "processedAt" >= $2 AND "processedAt" < $3 AND "hitPrice" IS NOT NULL
      ORDER BY "processedAt" ASC
    `, t.symbol, day, dayEnd);
    if (path.length < 3) continue;
    const pts = path.map((x) => ({ p: +x.p, t: new Date(x.t).getTime() }));
    const pre = pts.filter((x) => x.t <= execAt);
    if (pre.length < 2) continue;
    const firstP = pts[0].p, firstT = pts[0].t;
    const preHi = Math.max(...pre.map((x) => x.p)), preLo = Math.min(...pre.map((x) => x.p));
    const dayHi = Math.max(...pts.map((x) => x.p));
    rows.push({
      symbol: t.symbol, status: t.status,
      lagMin: (execAt - firstT) / 60000,
      preRunPct: firstP > 0 ? (entry - firstP) / firstP * 100 : NaN,
      rangePos: preHi > preLo ? (entry - preLo) / (preHi - preLo) : NaN, // 0=at low, 1=at local high
      headroomPct: entry > 0 ? (dayHi - entry) / entry * 100 : NaN,       // room left above entry
      enteredNearTop: preHi > preLo ? ((entry - preLo) / (preHi - preLo) >= 0.8 ? 1 : 0) : 0,
    });
  }

  const show = (label, rs) => {
    if (!rs.length) { console.log(`${label}: (none)`); return; }
    const lag = rs.map((r) => r.lagMin), rp = rs.map((r) => r.rangePos).filter(Number.isFinite);
    const hr = rs.map((r) => r.headroomPct).filter(Number.isFinite), pr = rs.map((r) => r.preRunPct).filter(Number.isFinite);
    const nearTop = rs.reduce((s, r) => s + r.enteredNearTop, 0);
    console.log(`\n${label}  (n=${rs.length})`);
    console.log(`  first-detection → entry lag (min):  median ${f(med(lag))}  p25 ${f(pct(lag, .25))}  p75 ${f(pct(lag, .75))}`);
    console.log(`  pre-entry run from first alert (%):  median ${f(med(pr), 2)}  p75 ${f(pct(pr, .75), 2)}`);
    console.log(`  entry position in pre-entry range:   median ${f(med(rp), 2)}  (0=at low, 1=at local high)`);
    console.log(`  entered in top 20% of range:         ${nearTop}/${rs.length} = ${f(nearTop / rs.length * 100)}%`);
    console.log(`  headroom left to day high (%):       median ${f(med(hr), 2)}  p25 ${f(pct(hr, .25), 2)}`);
  };

  console.log(`\nENTRY LATENESS — BUY trades, last ${DAYS}d (path-proxy)`);
  console.log('='.repeat(60));
  show('ALL executed', rows);
  show('STOPPED', rows.filter((r) => r.status === 'STOPPED'));
  show('TARGET_HIT', rows.filter((r) => r.status === 'TARGET_HIT'));
  show('EXITED', rows.filter((r) => r.status === 'EXITED'));
  console.log(`\nCAVEAT: per-minute hitPrice proxy; impulses occurring before first alert (e.g. open spike) aren't captured in pre-run. Directional.`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error('FAILED:', e?.message ?? e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
