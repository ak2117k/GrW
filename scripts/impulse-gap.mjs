// scripts/impulse-gap.mjs — R&D, read-only. Uses REAL 1m candles.
// Measures, per BUY trade: how much of the day's open->high move was already
// complete when (a) Chartink first flagged it and (b) we entered; plus the
// minute-gap from the impulse (first +2% bar) to first-alert and to entry.
// No production changes.
//
// Run: node scripts/impulse-gap.mjs

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const DAYS = Number(process.env.DAYS ?? 12);
const IMPULSE_PCT = Number(process.env.IMPULSE_PCT ?? 2); // "impulse" = first bar up >= this% from day open

const pct = (a, p) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
const med = (a) => pct(a, 0.5);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');

async function main() {
  const trades = await prisma.$queryRawUnsafe(`
    SELECT symbol, "executedPrice" AS entry, "executedAt" AS exec_at, status
    FROM watch_entries
    WHERE side='BUY' AND "executedAt" IS NOT NULL AND "executedPrice" IS NOT NULL
      AND "createdAt" >= now() - interval '${DAYS} days'
  `);

  const rows = [];
  let noCandles = 0;
  for (const t of trades) {
    const day = new Date(t.exec_at); day.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(day.getTime() + 24 * 3600 * 1000);
    const execAt = new Date(t.exec_at).getTime();

    const candles = await prisma.$queryRawUnsafe(`
      SELECT c.timestamp AS t, c.open AS o, c.high AS h, c.low AS l, c.close AS cl
      FROM candles c JOIN instruments i ON i.id = c."instrumentId"
      WHERE (i.symbol=$1 OR i.symbol=$1||'-EQ') AND c.timeframe='1m'
        AND c.timestamp >= $2 AND c.timestamp < $3
      ORDER BY c.timestamp ASC
    `, t.symbol, day, dayEnd);
    if (candles.length < 20) { noCandles++; continue; }

    const cs = candles.map((x) => ({ t: new Date(x.t).getTime(), o: +x.o, h: +x.h, l: +x.l, c: +x.cl }));
    const dayOpen = cs[0].o;
    const dayHigh = Math.max(...cs.map((x) => x.h));
    const move = dayHigh - dayOpen;
    if (!(move > 0) || !(dayOpen > 0)) continue;

    const alertRow = await prisma.$queryRawUnsafe(`
      SELECT min("processedAt") AS t FROM chartink_alert_setups
      WHERE symbol=$1 AND "processedAt" >= $2 AND "processedAt" < $3
    `, t.symbol, day, dayEnd);
    const firstAlertT = alertRow[0]?.t ? new Date(alertRow[0].t).getTime() : null;

    const priceAt = (ms) => { let p = cs[0].c; for (const c of cs) { if (c.t <= ms) p = c.c; else break; } return p; };
    const fracDone = (ms) => Math.max(0, Math.min(1, (priceAt(ms) - dayOpen) / move));

    // impulse = first bar whose high tags +IMPULSE_PCT from day open
    let impulseT = null;
    for (const c of cs) { if ((c.h - dayOpen) / dayOpen * 100 >= IMPULSE_PCT) { impulseT = c.t; break; } }

    rows.push({
      symbol: t.symbol, status: t.status,
      fracAtAlert: firstAlertT ? fracDone(firstAlertT) : NaN,
      fracAtEntry: fracDone(execAt),
      impToAlertMin: impulseT && firstAlertT ? (firstAlertT - impulseT) / 60000 : NaN,
      impToEntryMin: impulseT ? (execAt - impulseT) / 60000 : NaN,
      hadImpulse: impulseT ? 1 : 0,
    });
  }

  const show = (label, rs) => {
    if (!rs.length) { console.log(`\n${label}: (none)`); return; }
    const fa = rs.map((r) => r.fracAtAlert).filter(Number.isFinite);
    const fe = rs.map((r) => r.fracAtEntry).filter(Number.isFinite);
    const ia = rs.map((r) => r.impToAlertMin).filter(Number.isFinite);
    const ie = rs.map((r) => r.impToEntryMin).filter(Number.isFinite);
    const imp = rs.reduce((s, r) => s + r.hadImpulse, 0);
    console.log(`\n${label}  (n=${rs.length}, hit +${IMPULSE_PCT}% impulse: ${imp})`);
    console.log(`  move-done @ first-alert:  median ${f(med(fa) * 100)}%  p75 ${f(pct(fa, .75) * 100)}%   (frac of open→high already gone)`);
    console.log(`  move-done @ OUR ENTRY:    median ${f(med(fe) * 100)}%  p75 ${f(pct(fe, .75) * 100)}%`);
    console.log(`  impulse(+${IMPULSE_PCT}%) → first-alert: median ${f(med(ia))} min`);
    console.log(`  impulse(+${IMPULSE_PCT}%) → OUR ENTRY:   median ${f(med(ie))} min`);
  };

  console.log(`\nIMPULSE-vs-ENTRY GAP — BUY trades last ${DAYS}d, REAL 1m candles`);
  console.log('='.repeat(60));
  console.log(`trades=${trades.length}  with 1m candles=${rows.length}  no-candles=${noCandles}`);
  show('ALL', rows);
  show('STOPPED', rows.filter((r) => r.status === 'STOPPED'));
  show('TARGET_HIT', rows.filter((r) => r.status === 'TARGET_HIT'));
  show('EXITED', rows.filter((r) => r.status === 'EXITED'));
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error('FAILED:', e?.message ?? e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
