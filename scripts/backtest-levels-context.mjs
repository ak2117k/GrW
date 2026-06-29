// scripts/backtest-levels-context.mjs
// Backtest the levels-context strategy against historical candles.
// Run: npm run backtest:levels
// Env: DATABASE_URL (read from .env), YEARS_BACK=10 (default), SYMBOL=NIFTY (default)
//
// NOTE: This script is run via `tsx` which transpiles TypeScript on-the-fly.
// The TypeScript source files are imported directly — same code path as the
// live scanner, just driven by historical DB rows instead of live ticks.

import 'reflect-metadata';
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

// tsx re-exports createRequire-based resolution for TS files, but with ESM
// top-level await we can use dynamic import for the TS modules.
// Note: Node ESM loader on Windows rejects bare `c:\...` paths — must be a
// proper `file://` URL via pathToFileURL.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const { LevelBookService } = await import(
  pathToFileURL(
    resolve(repoRoot, 'apps/api/src/modules/signal-generator/services/level-book.service.ts'),
  ).href
);
const { LevelsContextStrategy } = await import(
  pathToFileURL(
    resolve(repoRoot, 'apps/api/src/modules/signal-generator/strategies/levels-context.strategy.ts'),
  ).href
);

// ANSI helpers
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

// Cost model — Indian options retail reality
// Ref: SEBI circular + NSE brokerage schedule (2024)
const COSTS = {
  slippageAtrFraction: 0.05,   // 0.05 × ATR14 per leg (entry + exit)
  brokeragePerOrder: 20,        // ₹20 flat per order (Zerodha / Groww style)
  brokeragePctMax: 0.0003,      // 0.03% cap — whichever is lower
  stt: {
    optionsSell: 0.00025,       // 0.025% on premium at sell
    equitySell: 0.001,
  },
  gst: 0.18,                    // 18% GST on brokerage
  exchangeSebi: 0.000006,       // NSE + SEBI turnover charge (per leg)
  stampBuy: 0.00003,            // 0.003% stamp on buy
};

const SYMBOL = process.env.SYMBOL ?? 'NIFTY';
const YEARS_BACK = Number(process.env.YEARS_BACK ?? 10);
// Lot size for cost model — NIFTY = 75 post-2024 revision; override via env
const LOT_SIZE = Number(process.env.LOT_SIZE ?? 75);

const prisma = new PrismaClient();

async function main() {
  console.log(`\n${c.bold}LevelsContext Backtest — ${SYMBOL}, ${YEARS_BACK}y${c.reset}`);
  console.log('='.repeat(50));

  // Load instrument
  const inst = await prisma.instrument.findFirst({
    where: { symbol: SYMBOL, exchange: 'NSE' },
    select: { id: true, token: true, symbol: true, exchange: true },
  });
  if (!inst) {
    throw new Error(
      `Instrument ${SYMBOL} not found in DB (exchange=NSE). ` +
      `Run \`npm run db:seed\` or seed the instruments table first.`,
    );
  }
  console.log(`${c.cyan}▶${c.reset} Instrument: ${inst.symbol} (${inst.exchange}, token ${inst.token})`);

  // Load daily candles to seed the LevelBook each session
  const fromDate = new Date(Date.now() - YEARS_BACK * 365 * 24 * 60 * 60 * 1000);
  const dailyCandles = await prisma.candle.findMany({
    where: { instrumentId: inst.id, timeframe: '1d', timestamp: { gte: fromDate } },
    orderBy: { timestamp: 'asc' },
  });
  console.log(`${c.cyan}▶${c.reset} Daily candles loaded: ${dailyCandles.length}`);
  if (dailyCandles.length < 20) {
    console.log(
      `${c.yellow}⚠${c.reset}  Fewer than 20 daily candles — backtest will be thin. ` +
      `Run \`npm run backfill\` to populate historical data.`,
    );
  }

  // ─── Session-by-session replay ───────────────────────────────────────────
  const trades = [];
  let sessionsProcessed = 0;
  let sessionsSkipped = 0;

  // Diagnostic counters — show which gate is rejecting most candidates
  const diag = {};
  const bump = (k) => { diag[k] = (diag[k] ?? 0) + 1; };

  for (let i = 14; i < dailyCandles.length; i++) {
    const dayCandle = dailyCandles[i];
    // Session date: align to market open (09:15 IST = 03:45 UTC)
    const sessionDate = new Date(dayCandle.timestamp);
    // Build the IST midnight for this day, then add 09:15
    const sessionOpen = new Date(
      Date.UTC(
        sessionDate.getUTCFullYear(),
        sessionDate.getUTCMonth(),
        sessionDate.getUTCDate(),
        3, 45, 0, 0, // 09:15 IST = 03:45 UTC
      ),
    );
    const sessionClose = new Date(
      Date.UTC(
        sessionDate.getUTCFullYear(),
        sessionDate.getUTCMonth(),
        sessionDate.getUTCDate(),
        10, 0, 0, 0, // 15:30 IST = 10:00 UTC
      ),
    );

    // Load 5-min candles for this session
    const fiveMin = await prisma.candle.findMany({
      where: {
        instrumentId: inst.id,
        timeframe: '5m',
        timestamp: { gte: sessionOpen, lt: sessionClose },
      },
      orderBy: { timestamp: 'asc' },
    });

    // Need at least 25 bars (5 bars OR + 20 bars strategy window)
    if (fiveMin.length < 25) {
      sessionsSkipped++;
      continue;
    }
    sessionsProcessed++;

    // Seed LevelBook with the 14 daily candles BEFORE today
    const lbs = new LevelBookService();
    lbs.seedSession({
      token: inst.token,
      symbol: inst.symbol,
      exchange: inst.exchange,
      recentDailyCandles: dailyCandles.slice(i - 14, i).map((d) => ({
        timestamp: d.timestamp,
        open: Number(d.open),
        high: Number(d.high),
        low: Number(d.low),
        close: Number(d.close),
        volume: Number(d.volume),
      })),
    });

    // Lock Opening Range from the first 3 five-minute bars (09:15–09:30 IST)
    const orCandles = fiveMin.slice(0, 3);
    const orHigh = Math.max(...orCandles.map((bar) => Number(bar.high)));
    const orLow = Math.min(...orCandles.map((bar) => Number(bar.low)));
    lbs.lockOpeningRange(inst.token, { high: orHigh, low: orLow });

    // Replay bars 4 onward through the strategy
    const strategy = new LevelsContextStrategy();
    // Default mode = strict (only A/B grades). RELAX_GRADE_C=1 includes C.
    if (process.env.RELAX_GRADE_C === '1') {
      strategy.setParameters({ includeGradeC: true });
    }
    let openTrade = null;

    for (let j = 4; j < fiveMin.length; j++) {
      const bar = fiveMin[j];
      const barClose = Number(bar.close);
      const barHigh = Number(bar.high);
      const barLow = Number(bar.low);
      const barVol = Number(bar.volume);

      // Update the level book with this bar's close as the tick
      lbs.updateFromTick({
        token: inst.token,
        ltp: barClose,
        volume: barVol,
        timestamp: bar.timestamp,
      });

      const lb = lbs.getLevels(inst.token);
      if (!lb) continue;

      // Fake freshness so the staleness gate (60s) passes for historical replay
      lb.lastTickAt = bar.timestamp;

      // Build IST clock string "HH:MM" for time-of-day gate
      const istMs = bar.timestamp.getTime() + 5.5 * 3600 * 1000;
      const istDate = new Date(istMs);
      const nowIst = istDate.toISOString().slice(11, 16); // "HH:MM"

      // Build the rolling 25-bar candle window the strategy expects
      const candleWindow = fiveMin.slice(Math.max(0, j - 24), j + 1).map((bar) => ({
        timestamp: bar.timestamp,
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: Number(bar.volume),
      }));

      if (!openTrade) {
        // Look for entry signal — pass replay clock so the staleness gate
        // measures against historical bar time, not real wall-clock.
        const out = strategy.analyze({
          candles: candleWindow,
          levelBook: lb,
          nowIst,
          nowMs: bar.timestamp.getTime(),
          debug: (event) => bump(event),
        });
        if (out) {
          // Apply entry slippage
          const slip = lb.atr14 * COSTS.slippageAtrFraction * (out.side === 'BUY' ? 1 : -1);
          openTrade = {
            entryTime: bar.timestamp,
            entryPrice: out.entryPrice + slip,
            sl: out.stoplossPrice,
            target: out.targetPrice,
            side: out.side,
            atr14: lb.atr14,
            ctx: out.metadata,
          };
        }
      } else {
        // Check for SL / target hit during this bar
        let exitReason = null;
        if (openTrade.side === 'BUY') {
          if (barHigh >= openTrade.target) exitReason = 'TARGET';
          else if (barLow <= openTrade.sl) exitReason = 'SL';
        } else {
          // SELL
          if (barLow <= openTrade.target) exitReason = 'TARGET';
          else if (barHigh >= openTrade.sl) exitReason = 'SL';
        }

        // Force exit at last bar of session (EOD square-off)
        const isLastBar = j === fiveMin.length - 1;
        if (exitReason || isLastBar) {
          // Determine gross exit price
          const rawExit =
            exitReason === 'TARGET' ? openTrade.target
            : exitReason === 'SL' ? openTrade.sl
            : barClose; // EOD

          // Apply exit slippage (adverse direction)
          const exitSlip =
            lb.atr14 * COSTS.slippageAtrFraction * (openTrade.side === 'BUY' ? -1 : 1);
          const finalExit = rawExit + exitSlip;

          // Gross P&L per point (1 lot = LOT_SIZE qty)
          const grossPnlPt =
            openTrade.side === 'BUY'
              ? finalExit - openTrade.entryPrice
              : openTrade.entryPrice - finalExit;
          const grossPnl = grossPnlPt * LOT_SIZE;

          // Cost model — 1 round trip (2 orders)
          const orderValue = openTrade.entryPrice * LOT_SIZE;
          const brokerage = 2 * Math.min(COSTS.brokeragePerOrder, orderValue * COSTS.brokeragePctMax);
          const gst = brokerage * COSTS.gst;
          const stt = orderValue * COSTS.stt.optionsSell; // options sell STT
          const stamp = orderValue * COSTS.stampBuy;       // stamp on buy leg
          const exch = orderValue * COSTS.exchangeSebi * 2; // both legs
          const totalCosts = brokerage + gst + stt + stamp + exch;

          trades.push({
            entryTime: openTrade.entryTime,
            exitTime: bar.timestamp,
            side: openTrade.side,
            entry: openTrade.entryPrice,
            exit: finalExit,
            grossPnl,
            totalCosts,
            netPnl: grossPnl - totalCosts,
            exitReason: exitReason ?? 'EOD',
            ctx: openTrade.ctx,
          });
          openTrade = null;
        }
      }
    }
  }

  console.log(`${c.cyan}▶${c.reset} Sessions processed: ${sessionsProcessed}, skipped (thin data): ${sessionsSkipped}`);

  console.log(`\n${c.bold}Gate diagnostics${c.reset}`);
  for (const [k, v] of Object.entries(diag).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)}: ${v}`);
  }

  // ─── Aggregate ───────────────────────────────────────────────────────────
  const total = trades.length;
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const winRate = total === 0 ? 0 : wins / total;
  const grossTotal = trades.reduce((s, t) => s + t.grossPnl, 0);
  const costsTotal = trades.reduce((s, t) => s + t.totalCosts, 0);
  const netTotal = trades.reduce((s, t) => s + t.netPnl, 0);

  const winningTrades = trades.filter((t) => t.netPnl > 0);
  const losingTrades = trades.filter((t) => t.netPnl <= 0);
  const avgWin = winningTrades.length === 0 ? 0 :
    winningTrades.reduce((s, t) => s + t.netPnl, 0) / winningTrades.length;
  const avgLoss = losingTrades.length === 0 ? 0 :
    losingTrades.reduce((s, t) => s + t.netPnl, 0) / losingTrades.length;
  const rrRealized = avgLoss === 0 ? 0 : Math.abs(avgWin / avgLoss);

  // Max drawdown
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.netPnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  // Sharpe (annualized, rough — daily net P&L series)
  const dailyPnl = {};
  for (const t of trades) {
    const day = t.entryTime.toISOString().slice(0, 10);
    dailyPnl[day] = (dailyPnl[day] ?? 0) + t.netPnl;
  }
  const dailySeries = Object.values(dailyPnl);
  const meanDaily = dailySeries.length === 0 ? 0 :
    dailySeries.reduce((a, b) => a + b, 0) / dailySeries.length;
  const stdDaily = dailySeries.length < 2 ? 0 :
    Math.sqrt(
      dailySeries.reduce((s, x) => s + (x - meanDaily) ** 2, 0) /
      (dailySeries.length - 1),
    );
  const sharpe = stdDaily === 0 ? 0 : (meanDaily / stdDaily) * Math.sqrt(252);

  // Breakdown by setup type
  const bySetup = {};
  for (const t of trades) {
    const k = t.ctx?.setupType ?? 'UNKNOWN';
    if (!bySetup[k]) bySetup[k] = { n: 0, wins: 0, pnl: 0 };
    bySetup[k].n++;
    if (t.netPnl > 0) bySetup[k].wins++;
    bySetup[k].pnl += t.netPnl;
  }

  // Breakdown by grade
  const byGrade = {};
  for (const t of trades) {
    const k = t.ctx?.grade ?? 'UNKNOWN';
    if (!byGrade[k]) byGrade[k] = { n: 0, wins: 0, pnl: 0 };
    byGrade[k].n++;
    if (t.netPnl > 0) byGrade[k].wins++;
    byGrade[k].pnl += t.netPnl;
  }

  // Exit reason distribution
  const byExit = {};
  for (const t of trades) {
    const k = t.exitReason;
    if (!byExit[k]) byExit[k] = 0;
    byExit[k]++;
  }

  // ─── Report ──────────────────────────────────────────────────────────────
  const winColor = winRate >= 0.45 ? c.green : c.red;
  const sharpeColor = sharpe >= 0.5 ? c.green : c.yellow;
  const netColor = netTotal >= 0 ? c.green : c.red;

  console.log('');
  console.log(`${c.bold}BACKTEST REPORT${c.reset}`);
  console.log('='.repeat(50));
  console.log(`Symbol         : ${SYMBOL}  |  Period: ${YEARS_BACK}y`);
  console.log(`Sessions       : ${sessionsProcessed} days replayed, ${sessionsSkipped} skipped`);
  console.log(`Lot size       : ${LOT_SIZE} qty  |  Cost model: Indian retail options`);
  console.log('');
  console.log(`${c.bold}── Summary ──${c.reset}`);
  console.log(`Total trades   : ${total}`);
  console.log(`Win rate       : ${winColor}${(winRate * 100).toFixed(1)}%${c.reset}  (gate: ≥ 45%)`);
  console.log(`Avg win        : ${c.green}₹${avgWin.toFixed(0)}${c.reset}`);
  console.log(`Avg loss       : ${c.red}₹${avgLoss.toFixed(0)}${c.reset}`);
  console.log(`R:R (realized) : ${rrRealized.toFixed(2)}  (gate: ≥ 1.5)`);
  console.log(`Gross P&L      : ₹${grossTotal.toFixed(0)}`);
  console.log(`Total costs    : ₹${costsTotal.toFixed(0)}  (${total > 0 ? (costsTotal / Math.abs(grossTotal) * 100).toFixed(1) : '–'}% of gross)`);
  console.log(`Net P&L        : ${netColor}₹${netTotal.toFixed(0)}${c.reset}`);
  console.log(`Max drawdown   : ₹${maxDd.toFixed(0)}`);
  console.log(`Sharpe (ann.)  : ${sharpeColor}${sharpe.toFixed(2)}${c.reset}  (gate: > 0)`);

  console.log('');
  console.log(`${c.bold}── By setup type ──${c.reset}`);
  if (Object.keys(bySetup).length === 0) {
    console.log('  (no trades)');
  } else {
    for (const [k, v] of Object.entries(bySetup)) {
      const wr = v.n === 0 ? 0 : (v.wins / v.n) * 100;
      console.log(`  ${k.padEnd(12)}: ${String(v.n).padStart(4)} trades  ${wr.toFixed(1).padStart(5)}% win  net ₹${v.pnl.toFixed(0)}`);
    }
  }

  console.log('');
  console.log(`${c.bold}── By grade ──${c.reset}`);
  if (Object.keys(byGrade).length === 0) {
    console.log('  (no trades)');
  } else {
    for (const [k, v] of Object.entries(byGrade)) {
      const wr = v.n === 0 ? 0 : (v.wins / v.n) * 100;
      console.log(`  Grade ${k.padEnd(8)}: ${String(v.n).padStart(4)} trades  ${wr.toFixed(1).padStart(5)}% win  net ₹${v.pnl.toFixed(0)}`);
    }
  }

  console.log('');
  console.log(`${c.bold}── Exit reasons ──${c.reset}`);
  for (const [k, n] of Object.entries(byExit)) {
    const pct = total === 0 ? 0 : (n / total) * 100;
    console.log(`  ${k.padEnd(8)}: ${n} (${pct.toFixed(1)}%)`);
  }

  console.log('');
  console.log(`${c.bold}── Validation gate status ──${c.reset}`);
  const gateWinRate = winRate >= 0.45 ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset}`;
  const gateRR = rrRealized >= 1.5 ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset}`;
  const gateSharpe = sharpe > 0 ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset}`;
  const gateDD = maxDd > 0 ? `${c.green}DOCUMENTED${c.reset}` : `${c.yellow}N/A${c.reset}`;
  console.log(`  Win rate ≥ 45%           : ${gateWinRate}  (${(winRate * 100).toFixed(1)}%)`);
  console.log(`  R:R realized ≥ 1.5       : ${gateRR}  (${rrRealized.toFixed(2)})`);
  console.log(`  Positive Sharpe          : ${gateSharpe}  (${sharpe.toFixed(2)})`);
  console.log(`  Max DD documented        : ${gateDD}  (₹${maxDd.toFixed(0)})`);

  const allPass = winRate >= 0.45 && rrRealized >= 1.5 && sharpe > 0;
  console.log('');
  if (total === 0) {
    console.log(`${c.yellow}${c.bold}⚠  NO TRADES — likely thin/missing 5m candle data in DB.${c.reset}`);
    console.log(`   Run backfill scripts to populate historical 5m candles, then re-run.`);
  } else if (allPass) {
    console.log(`${c.green}${c.bold}✓  STRATEGY PASSES VALIDATION GATE — eligible for forward paper.${c.reset}`);
  } else {
    console.log(`${c.yellow}${c.bold}⚠  STRATEGY DID NOT PASS ALL GATES — review thresholds before live use.${c.reset}`);
  }
  console.log('');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(`\n${c.red}${c.bold}BACKTEST FAILED:${c.reset}`, e.message ?? e);
  if (e.stack) console.error(c.dim + e.stack + c.reset);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
