// scripts/backtest-sr-headroom.mjs
// R&D ONLY — throwaway measurement. Does NOT touch production code.
//
// Question: of the trades the levels-context strategy already takes, do the
// ones with more "headroom to the nearest opposing S/R wall" perform better?
// If yes, a headroom gate/score would be worth building.
//
// Method: replay the strategy session-by-session (same code path as the live
// scanner). On each entry, tag the trade with headroomATR = distance(entry ->
// nearest opposing evidence level) / ATR14, where the wall comes from our REAL
// SR code (computeVolumeNodes + adaptiveRoundNumbers + scoreAndCluster).
// Then report a threshold sweep: baseline vs keep-only headroomATR >= {0.5,1,1.5}.
//
// OI walls are EXCLUDED (no historical OI feed) — volume+round only.
// Indices (no candle volume) => wall falls back to nearest round number.
//
// Run: npx tsx scripts/backtest-sr-headroom.mjs

import 'reflect-metadata';
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
// Import the COMPILED dist JS (decorators already transformed by nest's tsc) so
// this runs under plain `node` — tsx/esbuild in this env won't honor
// experimentalDecorators. dist is kept current by the running `nest --watch`.
const dist = 'apps/api/dist/modules/signal-generator';
// CJS dynamic import: resolve named exports off the namespace or its .default.
async function load(rel, ...names) {
  const m = await import(pathToFileURL(resolve(repoRoot, `${dist}/${rel}`)).href);
  return names.map((n) => m[n] ?? m.default?.[n]);
}
const [LevelBookService] = await load('services/level-book.service.js', 'LevelBookService');
const [LevelsContextStrategy] = await load('strategies/levels-context.strategy.js', 'LevelsContextStrategy');
const [computeVolumeNodes] = await load('services/volume-profile.js', 'computeVolumeNodes');
const [adaptiveRoundNumbers, adaptiveRoundStep, roundScore] = await load('services/adaptive-round-numbers.js', 'adaptiveRoundNumbers', 'adaptiveRoundStep', 'roundScore');
const [scoreAndCluster] = await load('services/sr-evidence-scoring.js', 'scoreAndCluster');

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

// Cost model — copied verbatim from backtest-levels-context.mjs
const COSTS = {
  slippageAtrFraction: 0.05, brokeragePerOrder: 20, brokeragePctMax: 0.0003,
  stt: { optionsSell: 0.00025 }, gst: 0.18, exchangeSebi: 0.000006, stampBuy: 0.00003,
};
const LOT_SIZE = Number(process.env.LOT_SIZE ?? 75);
const YEARS_BACK = Number(process.env.YEARS_BACK ?? 10);
const STOCK_YEARS = Number(process.env.STOCK_YEARS ?? 2); // stocks only have ~1mo anyway
const VOL_BUFFER = 800; // trailing 5m bars fed to the volume profile (~10 sessions)
const THRESHOLDS = (process.env.THRESHOLDS ?? '0,0.25,0.5,0.75,1.0').split(',').map(Number); // headroomATR sweep (0 = baseline)

const GROUPS = [
  { label: 'NIFTY (index · round-only)',     pool: false, years: YEARS_BACK, symbols: [['NIFTY', 'NSE']] },
  { label: 'BANKNIFTY (index · round-only)', pool: false, years: YEARS_BACK, symbols: [['BANKNIFTY', 'NSE']] },
  { label: 'STOCKS pooled (volume+round)',   pool: true,  years: STOCK_YEARS,
    symbols: [['RELIANCE-EQ','NSE'],['HDFCBANK-EQ','NSE'],['ICICIBANK-EQ','NSE'],['INFY-EQ','NSE']] },
];

const prisma = new PrismaClient();

const istDay = (d) => new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** Group 5m bars into sessions by IST date; derive a daily candle for each. */
function toSessions(bars5m) {
  const byDay = new Map();
  for (const b of bars5m) {
    const k = istDay(b.timestamp);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(b);
  }
  const sessions = [];
  for (const [day, bars] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (bars.length < 25) continue;
    const highs = bars.map((x) => x.high), lows = bars.map((x) => x.low);
    sessions.push({
      day, bars,
      daily: {
        timestamp: bars[0].timestamp,
        open: bars[0].open, high: Math.max(...highs), low: Math.min(...lows),
        close: bars[bars.length - 1].close, volume: bars.reduce((s, x) => s + x.volume, 0),
      },
    });
  }
  return sessions;
}

/** headroomATR via our real SR pipeline (volume nodes + round numbers, no OI). */
function headroomAtr(entry, side, atr14, volBuf) {
  if (!(atr14 > 0) || !(entry > 0)) return Infinity;
  const candidates = [];
  if (volBuf.length >= 10) {
    for (const n of computeVolumeNodes(volBuf, atr14, entry)) candidates.push({ price: n.price, kind: 'VOLUME', score: n.score });
  }
  const step = adaptiveRoundStep(entry);
  const grid = adaptiveRoundNumbers(entry);
  for (const r of grid) { const rs = roundScore(r, step); if (rs > 0) candidates.push({ price: r, kind: 'ROUND', score: rs }); }
  const levels = scoreAndCluster(candidates, entry, atr14, { softRoundGrid: grid });
  const want = side === 'BUY' ? 'resistance' : 'support';
  const opp = levels.filter((l) => l.side === want);
  if (opp.length === 0) return Infinity;
  const nearest = opp.reduce((b, l) => (Math.abs(l.price - entry) < Math.abs(b.price - entry) ? l : b));
  return Math.abs(nearest.price - entry) / atr14;
}

/** Replay one instrument; return tagged trades (each carries headroomAtr). */
async function replaySymbol(symbol, exchange, years) {
  // Multiple instrument rows can share a symbol (seed vs feed); pick the id that
  // actually holds the 5m candles.
  const insts = await prisma.instrument.findMany({ where: { symbol, exchange }, select: { id: true, token: true, symbol: true, exchange: true } });
  if (insts.length === 0) { console.log(`  ${c.yellow}skip${c.reset} ${symbol}: not in DB`); return []; }
  let inst = insts[0], best = -1;
  for (const cand of insts) {
    const n = await prisma.candle.count({ where: { instrumentId: cand.id, timeframe: '5m' } });
    if (n > best) { best = n; inst = cand; }
  }
  const fromDate = new Date(Date.now() - years * 365 * 24 * 60 * 60 * 1000);
  const rows = await prisma.candle.findMany({
    where: { instrumentId: inst.id, timeframe: '5m', timestamp: { gte: fromDate } },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, open: true, high: true, low: true, close: true, volume: true },
  });
  const bars5m = rows.map((r) => ({ timestamp: r.timestamp, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
  const sessions = toSessions(bars5m);
  console.log(`  ${c.cyan}▶${c.reset} ${symbol}: ${bars5m.length} 5m bars → ${sessions.length} sessions`);
  if (sessions.length < 16) return [];

  const trades = [];
  const volBuf = [];
  for (let i = 14; i < sessions.length; i++) {
    const sess = sessions[i];
    const lbs = new LevelBookService();
    lbs.seedSession({
      token: inst.token, symbol: inst.symbol, exchange: inst.exchange,
      recentDailyCandles: sessions.slice(i - 14, i).map((s) => s.daily),
    });
    const or3 = sess.bars.slice(0, 3);
    lbs.lockOpeningRange(inst.token, { high: Math.max(...or3.map((b) => b.high)), low: Math.min(...or3.map((b) => b.low)) });
    const strategy = new LevelsContextStrategy();
    if (process.env.RELAX_GRADE_C === '1') strategy.setParameters({ includeGradeC: true });

    let open = null;
    const fm = sess.bars;
    for (let j = 0; j < fm.length; j++) {
      const bar = fm[j];
      volBuf.push({ high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
      if (volBuf.length > VOL_BUFFER) volBuf.shift();
      if (j < 4) continue;

      lbs.updateFromTick({ token: inst.token, ltp: bar.close, volume: bar.volume, timestamp: bar.timestamp });
      const lb = lbs.getLevels(inst.token);
      if (!lb) continue;
      lb.lastTickAt = bar.timestamp;
      const nowIst = new Date(bar.timestamp.getTime() + 5.5 * 3600 * 1000).toISOString().slice(11, 16);
      const candleWindow = fm.slice(Math.max(0, j - 24), j + 1);

      if (!open) {
        const out = strategy.analyze({ candles: candleWindow, levelBook: lb, nowIst, nowMs: bar.timestamp.getTime() });
        if (out) {
          const slip = lb.atr14 * COSTS.slippageAtrFraction * (out.side === 'BUY' ? 1 : -1);
          open = {
            entryTime: bar.timestamp, entryPrice: out.entryPrice + slip,
            sl: out.stoplossPrice, target: out.targetPrice, side: out.side, atr14: lb.atr14,
            hr: headroomAtr(out.entryPrice, out.side, lb.atr14, volBuf.slice(0, -1)),
            ctx: out.metadata,
          };
        }
      } else {
        let reason = null;
        if (open.side === 'BUY') { if (bar.high >= open.target) reason = 'TARGET'; else if (bar.low <= open.sl) reason = 'SL'; }
        else { if (bar.low <= open.target) reason = 'TARGET'; else if (bar.high >= open.sl) reason = 'SL'; }
        const lastBar = j === fm.length - 1;
        if (reason || lastBar) {
          const raw = reason === 'TARGET' ? open.target : reason === 'SL' ? open.sl : bar.close;
          const exitSlip = open.atr14 * COSTS.slippageAtrFraction * (open.side === 'BUY' ? -1 : 1);
          const exit = raw + exitSlip;
          const grossPt = open.side === 'BUY' ? exit - open.entryPrice : open.entryPrice - exit;
          const gross = grossPt * LOT_SIZE;
          const ov = open.entryPrice * LOT_SIZE;
          const brokerage = 2 * Math.min(COSTS.brokeragePerOrder, ov * COSTS.brokeragePctMax);
          const costs = brokerage + brokerage * COSTS.gst + ov * COSTS.stt.optionsSell + ov * COSTS.stampBuy + ov * COSTS.exchangeSebi * 2;
          trades.push({ entryTime: open.entryTime, side: open.side, netPnl: gross - costs, headroomAtr: open.hr, exitReason: reason ?? 'EOD' });
          open = null;
        }
      }
    }
  }
  return trades;
}

function metrics(trades) {
  const total = trades.length;
  if (total === 0) return { total: 0 };
  const W = trades.filter((t) => t.netPnl > 0), L = trades.filter((t) => t.netPnl <= 0);
  const avgWin = W.length ? W.reduce((s, t) => s + t.netPnl, 0) / W.length : 0;
  const avgLoss = L.length ? L.reduce((s, t) => s + t.netPnl, 0) / L.length : 0;
  const netTotal = trades.reduce((s, t) => s + t.netPnl, 0);
  const daily = {};
  for (const t of trades) { const d = t.entryTime.toISOString().slice(0, 10); daily[d] = (daily[d] ?? 0) + t.netPnl; }
  const ds = Object.values(daily);
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  const std = ds.length < 2 ? 0 : Math.sqrt(ds.reduce((s, x) => s + (x - mean) ** 2, 0) / (ds.length - 1));
  let peak = 0, eq = 0, mdd = 0;
  for (const t of trades) { eq += t.netPnl; if (eq > peak) peak = eq; if (peak - eq > mdd) mdd = peak - eq; }
  return {
    total, winRate: W.length / total, avgWin, avgLoss,
    rr: avgLoss === 0 ? 0 : Math.abs(avgWin / avgLoss),
    netTotal, netPerTrade: netTotal / total,
    sharpe: std === 0 ? 0 : (mean / std) * Math.sqrt(252), maxDd: mdd,
  };
}

function printSweep(label, trades) {
  console.log(`\n${c.bold}${label}${c.reset}  (${trades.length} base trades)`);
  if (trades.length === 0) { console.log('  (no trades)'); return; }
  console.log('  thr   trades  win%   avgR   net₹/trade    netP&L₹     Sharpe   maxDD₹');
  const base = metrics(trades);
  for (const thr of THRESHOLDS) {
    const sub = thr === 0 ? trades : trades.filter((t) => t.headroomAtr >= thr);
    const m = metrics(sub);
    if (m.total === 0) { console.log(`  ≥${thr.toFixed(1)}      0     —`); continue; }
    const kept = ((m.total / base.total) * 100).toFixed(0);
    const tag = thr === 0 ? 'base' : `≥${thr.toFixed(1)}`;
    const col = thr === 0 ? c.dim : (m.sharpe > base.sharpe && m.rr > base.rr && m.netPerTrade > base.netPerTrade) ? c.green : c.reset;
    console.log(`  ${col}${tag.padEnd(5)} ${String(m.total).padStart(5)} (${kept.padStart(3)}%) ${(m.winRate * 100).toFixed(1).padStart(5)}  ${m.rr.toFixed(2).padStart(5)}  ${m.netPerTrade.toFixed(0).padStart(9)}  ${m.netTotal.toFixed(0).padStart(11)}  ${m.sharpe.toFixed(2).padStart(6)}  ${m.maxDd.toFixed(0).padStart(8)}${c.reset}`);
  }
  // headroom distribution
  const hrs = trades.map((t) => t.headroomAtr).filter((h) => Number.isFinite(h)).sort((a, b) => a - b);
  const inf = trades.length - hrs.length;
  const q = (p) => (hrs.length ? hrs[Math.min(hrs.length - 1, Math.floor(p * hrs.length))].toFixed(2) : '—');
  console.log(`  ${c.dim}headroomATR dist: p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)}  (+${inf} with no wall = full room)${c.reset}`);
}

async function main() {
  console.log(`\n${c.bold}S/R HEADROOM BACKTEST (R&D)${c.reset}  lot=${LOT_SIZE}  thresholds=${THRESHOLDS.join(',')}`);
  console.log('='.repeat(70));
  for (const g of GROUPS) {
    console.log(`\n${c.cyan}━━ ${g.label} ━━${c.reset}`);
    let pooled = [];
    for (const [sym, exch] of g.symbols) {
      const t = await replaySymbol(sym, exch, g.years);
      if (g.pool) pooled = pooled.concat(t);
      else printSweep(g.label, t);
    }
    if (g.pool) printSweep(g.label, pooled);
  }
  console.log(`\n${c.dim}Green threshold rows = Sharpe AND avgR AND net/trade all beat baseline.`);
  console.log(`OI walls excluded (no historical feed) — live forward-test only.${c.reset}\n`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(`${c.red}FAILED:${c.reset}`, e?.message ?? e);
  if (e?.stack) console.error(c.dim + e.stack + c.reset);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
