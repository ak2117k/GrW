import { readChart, type ChartBar } from '../../exit-discipline/chart-read';

/**
 * TRADE AGENT EXIT AUTHORITY (design §4.2): the alarm look carries a FRESH chart read of the position's UNDERLYING —
 * the existing pure `readChart` (exit-discipline/chart-read.ts) on closed 5m / 15m session bars and N15, plus the
 * session VWAP — so the agent verifies the alarm on facts, never on a chart it cannot see. Read only for a live
 * tracker whose packet shows an alarm; anything that fails is `{ unavailable: '<why>' }`.
 */

/** DI token: the underlying's closed 5m / 15m bars and N15 (repositories/alarm-chart.reader.ts, alarmChartReaderFor). */
export const ALARM_CHART_READER = Symbol('ALARM_CHART_READER');

/** The read (structurally the executor's ChartData). */
export interface AlarmChartData {
  ref: { exchange: string; token: string; symbol: string };
  bars5: ChartBar[];
  bars15: ChartBar[];
  n15: number | null;
}

export interface AlarmChartReader {
  /** Never throws in the executor's implementation; null when the underlying cannot be resolved or read. */
  read(trackerId: string, now: Date): Promise<AlarmChartData | null>;
}

/** The alarm read is bounded by this; a slower read is `unavailable`. */
export const ALARM_CHART_TIMEOUT_MS = 3_000;
/** How many of the latest closed bars' closes the packet shows per timeframe. */
const CLOSES_SHOWN = 3;
const IST_MS = 5.5 * 3_600_000;

/** `alarm.chart` (ContextPacket.alarm.chart). `type`s so they stay Prisma-JSON assignable. */
export type AlarmChartBlock = {
  /** The underlying the bars are of (the index, an MCX contract's nearest future, or a stock's cash line). */
  underlying: string;
  /** ISO time of the read. */
  asOf: string;
  /** The last closed 5-minute / 15-minute bar closes, oldest first, and the bar start time (ISO) of the last one. */
  closes5: number[];
  last5At: string | null;
  closes15: number[];
  last15At: string | null;
  /** Today's session VWAP from closed 5-minute bars with volume; null when there is no volume (an index). */
  vwap: number | null;
  /** N15 — ATR14 of 15-minute session bars, the underlying's 15-minute noise unit; null when not measurable. */
  n15: number | null;
  /** The 15-minute Supertrend (10, 3) on closed bars, and its line. */
  supertrend15: 'UP' | 'DOWN' | null;
  supertrendLine15: number | null;
  /** readChart's verdict: `against` the position (any test failed, or nothing measurable ⇒ known false). */
  known: boolean;
  against: boolean;
  /** readChart's reasons, in words. */
  reasons: string[];
  /** The underlying's move against the position from its best point (points) and the K15 × N15 that counts as "wrong". */
  adverseFromBest: number | null;
  needPts: number | null;
  /** The thesis invalidation the closes were tested against (null when absent or on the wrong scale). */
  invalidation: number | null;
};
export type AlarmChartUnavailable = { unavailable: string };
export type PacketAlarmChart = AlarmChartBlock | AlarmChartUnavailable;

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const iso = (ms: number | undefined) => (fin(ms) ? new Date(ms).toISOString() : null);

/** Today's (IST day of `nowMs`) session VWAP from closed 5-minute bars carrying volume; null without volume. Pure. */
export function sessionVwap(bars5: readonly ChartBar[], nowMs: number): number | null {
  const day = Math.floor((nowMs + IST_MS) / 86_400_000);
  let pv = 0;
  let v = 0;
  for (const b of bars5) {
    if (Math.floor((b.ts + IST_MS) / 86_400_000) !== day) continue;
    const vol = b.volume;
    if (!fin(vol) || vol <= 0 || ![b.high, b.low, b.close].every(fin)) continue;
    pv += ((b.high + b.low + b.close) / 3) * vol;
    v += vol;
  }
  return v > 0 ? r2(pv / v) : null;
}

/** The `alarm.chart` block from a read. Pure. */
export function alarmChartBlock(
  data: AlarmChartData,
  i: { bull: boolean; underlyingNow: number | null; invalidation: number | null; bestUnderlying: number | null; k15: number; now: Date },
): AlarmChartBlock {
  const r = readChart({
    bull: i.bull, underlyingNow: i.underlyingNow, invalidation: i.invalidation, bestUnderlying: i.bestUnderlying,
    bars5: data.bars5, bars15: data.bars15, n15: data.n15, k15: i.k15,
  });
  const closes = (b: readonly ChartBar[]) => b.slice(-CLOSES_SHOWN).map((x) => x.close).filter(fin);
  return {
    underlying: data.ref.symbol,
    asOf: i.now.toISOString(),
    closes5: closes(data.bars5),
    last5At: iso(data.bars5.at(-1)?.ts),
    closes15: closes(data.bars15),
    last15At: iso(data.bars15.at(-1)?.ts),
    vwap: sessionVwap(data.bars5, i.now.getTime()),
    n15: r.measured.n15,
    supertrend15: r.measured.supertrend15,
    supertrendLine15: r.measured.supertrendLine15,
    known: r.known,
    against: r.against,
    reasons: r.reasons,
    adverseFromBest: r.measured.adverseFromBest,
    needPts: r.measured.needPts,
    invalidation: r.measured.invalidation,
  };
}
