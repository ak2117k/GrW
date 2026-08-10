/**
 * Run the S/R accuracy backtest over a CSV of candles.
 *
 *   npx ts-node apps/api/scripts/sr-backtest.ts <file.csv> [timeframe] [barsPerSession]
 *
 * CSV columns (header required, order free):
 *   time,open,high,low,close,volume
 * `time` may be unix seconds, unix ms, or anything Date can parse.
 *
 * Exists as a script rather than an endpoint because a backtest is an offline
 * question, and because the local `candles` table is explicitly not a
 * backtest-grade store (see backtest.service.ts) — the data has to come from a
 * broker export or a DB dump either way.
 */
import { readFileSync } from 'fs';
import { backtestSrLevels, type BacktestCandle } from '../src/modules/signal-generator/services/sr-backtest';

function parseTime(raw: string): number {
  const n = Number(raw);
  if (Number.isFinite(n)) return n > 1e11 ? Math.floor(n / 1000) : n;
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  throw new Error(`unparseable time: ${raw}`);
}

function loadCsv(path: string): BacktestCandle[] {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV has no rows');
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV missing column: ${name}`);
    return i;
  };
  const [ti, oi, hi, li, ci, vi] = ['time', 'open', 'high', 'low', 'close', 'volume'].map(idx);

  return lines.slice(1).map((line) => {
    const f = line.split(',');
    return {
      time: parseTime(f[ti]),
      open: Number(f[oi]),
      high: Number(f[hi]),
      low: Number(f[li]),
      close: Number(f[ci]),
      volume: Number(f[vi]) || 0,
    };
  });
}

function pct(v: number | null): string {
  return v === null ? '     —' : `${(v * 100).toFixed(1).padStart(5)}%`;
}

const [, , file, timeframe = '15m', barsPerSession = '25'] = process.argv;
if (!file) {
  // eslint-disable-next-line no-console
  console.error('usage: sr-backtest.ts <file.csv> [timeframe] [barsPerSession]');
  process.exit(1);
}

const candles = loadCsv(file);
const report = backtestSrLevels(candles, {
  timeframe,
  barsPerSession: Number(barsPerSession),
});

/* eslint-disable no-console */
console.log(`\nS/R accuracy — ${report.timeframe}, ${report.candles} candles\n`);
console.log('Level    tested   held   broke   hold%    breaks  target  stop  timeout   follow%');
console.log('─'.repeat(82));
for (const kind of ['PDH', 'PDL', 'ROUND', 'VWAP'] as const) {
  const k = report.byKind[kind];
  const f = report.followThrough[kind];
  console.log(
    `${kind.padEnd(8)}${String(k.tested).padStart(6)}${String(k.held).padStart(7)}` +
      `${String(k.broke).padStart(8)}  ${pct(k.holdRate)}   ${String(f.breaks).padStart(6)}` +
      `${String(f.reachedTarget).padStart(8)}${String(f.hitStop).padStart(6)}` +
      `${String(f.timedOut).padStart(9)}   ${pct(f.rate)}`,
  );
}
console.log('─'.repeat(82));
console.log(
  `OVERALL follow-through: ${pct(report.overall.rate)} over ${report.overall.breaks} breaks ` +
    `(${report.overall.reachedTarget} reached target, ${report.overall.hitStop} stopped, ` +
    `${report.overall.timedOut} timed out)\n`,
);
if (report.overall.rate === null) {
  console.log('No resolved breaks — the sample is too small to say anything.\n');
}
