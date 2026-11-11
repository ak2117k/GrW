import { heikinCloses, lastEma, macdHistogram, rsi } from '../../overnight-scorecard/domain/indicators';
import { classifyTrend, mergeTrendBars, TREND_MAX_BARS, type TrendBar, type TrendTag } from '../../signal-trader/domain/trend-tag';
import { ENTRY_ENGINE, type Bar1m, type Direction } from './entry-decision';

/**
 * ENTRY GATES (2026-11-11). Prod: at 09:50 IST the engine entered NIFTY / BANKNIFTY / SENSEX CE in one pass,
 * within 6 s, at the TOP of a 35-min run with no pullback (NIFTY +90 pts, BANKNIFTY +400, SENSEX +340 from the
 * 09:25 lows) — all three pulled back together and were cut (−₹4.9k). The direction was right: a re-entry on the
 * same BANKNIFTY strike at 10:28, after the pullback had turned, made +₹7k. Owner: "the engine is not considering
 * the macd and other indicators before taking the trade". Three gates run AFTER the news + trend + OI decision
 * (entryDecision) has said ENTER; none of them can create an entry, they only hold one back:
 *
 *   INDICATORS — the signal-trader's 15m trend tag (Heikin-Ashi EMA20/80 + MACD(12,26,9) histogram, trend-tag.ts)
 *                must not be AGAINST the entry, and the MACD histogram must be positive or rising (mirror for PE)
 *                → else NO_TRADE. RSI(14) on 15m closes at / beyond the overbought (CE) / oversold (PE) line →
 *                WAIT (an extreme line: see ENTRY_ENGINE.rsiOverbought for why not 70). An UNKNOWN tag (< 120 bars)
 *                never blocks; it is recorded.
 *   CHASE      — how far the price already ran, in N15 (ATR14 of 15-minute session bars): from the last 30-min low
 *                (CE; high for PE) → WAIT at / beyond ENTRY_ENGINE.maxFromSwingN15 (a later scan can still enter after
 *                a pullback: nothing is skipped for the day). The distance from the 15m EMA20 is recorded too.
 *   Bars are the session's only ({@link sessionBars}): the hub's flat off-hours index bars are dropped.
 *   CLUSTER    — NIFTY / BANKNIFTY / SENSEX / FINNIFTY / MIDCPNIFTY / BANKEX are one bet: at most one open engine
 *                position per direction in the cluster and one new cluster entry per scan pass (a guard, like the
 *                cooldowns: the decision stays ENTER, the paper trade is not opened).
 *
 * Every threshold is a named constant in {@link ENTRY_ENGINE} (entry-decision.ts, "entry gates"). Pure: no I/O, no clock.
 */

/** The correlated index cluster: one bet, whatever the venue. */
export const INDEX_CLUSTER: readonly string[] = Object.freeze(['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX']);
export const inIndexCluster = (u: string) => INDEX_CLUSTER.includes(String(u).toUpperCase());

const MIN = 60_000;
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 10_000) / 10_000);

// ───────────────────────────── session bars ─────────────────────────────

/** The trading session's bucket-start window (IST minutes after midnight) by the price line's exchange. */
export function sessionWindow(lineExchange: string): { fromMin: number; toMin: number } {
  return String(lineExchange).toUpperCase() === 'MCX' ? { fromMin: 9 * 60, toMin: 23 * 60 + 55 } : { fromMin: 9 * 60 + 15, toMin: 15 * 60 + 30 };
}

const istMin = (ts: number) => Math.floor(((ts + 330 * MIN) % (24 * 60 * MIN)) / MIN);

/**
 * Only real session bars. Prod (2026-11-11 calibration): the hub writes FLAT index bars outside market hours
 * (o = h = l = c = the last close, all evening, all night, on holidays) and a pre-open 09:00–09:15 bar whose
 * high is the auction's (NIFTY 25576 on 11-11, 160 pts above the day's real high). Fed to RSI they read ~96
 * (dozens of zero-change bars, no losses), and they dilute the ATR. Kept: bars that START inside the venue's
 * session window and are not a frozen copy (o = h = l = c = the previous kept close). Works on 1m or 15m bars.
 */
export function sessionBars<B extends { ts: number; open: number; high: number; low: number; close: number }>(bars: readonly B[], lineExchange: string): B[] {
  const w = sessionWindow(lineExchange);
  const out: B[] = [];
  for (const b of bars) {
    const m = istMin(b.ts);
    if (m < w.fromMin || m >= w.toMin) continue;
    const day = new Date(b.ts + 330 * MIN).getUTCDay();
    if (day === 0 || day === 6) continue;
    const prev = out[out.length - 1];
    if (prev && b.open === b.close && b.high === b.close && b.low === b.close && b.close === prev.close) continue;
    out.push(b);
  }
  return out;
}

/**
 * 1-minute bars rolled into epoch-aligned 15m buckets (IST :00/:15/:30/:45, like the repository's date_bin), only
 * buckets COMPLETED by `at` (trend-tag mergeTrendBars). For callers without the 15m loader: the replays.
 */
export function rollTo15m(bars: readonly Bar1m[], at: Date): TrendBar[] {
  const w = 15 * MIN;
  const by = new Map<number, TrendBar>();
  for (const b of [...bars].sort((x, y) => x.ts - y.ts)) {
    if (!(b.low > 0 && b.high >= b.low)) continue;
    const k = Math.floor(b.ts / w) * w;
    const p = by.get(k);
    if (!p) by.set(k, { ts: k, open: b.open, high: b.high, low: b.low, close: b.close });
    else by.set(k, { ...p, high: Math.max(p.high, b.high), low: Math.min(p.low, b.low), close: b.close });
  }
  return mergeTrendBars([], [...by.values()], at);
}

// ───────────────────────────── indicators ─────────────────────────────

export interface IndicatorReading {
  /** The direction the reading was taken for. */
  direction: Direction;
  /** trend-tag.ts against that direction: WITH / AGAINST / MIXED / UNKNOWN. */
  tag: TrendTag;
  /** UP / DOWN when EMA alignment and MACD agree, else MIXED; null with too few bars. */
  trend: 'UP' | 'DOWN' | 'MIXED' | null;
  ema20: number | null;
  ema80: number | null;
  /** MACD(12,26,9) histogram of Heikin-Ashi 15m closes: the last completed bar and the one before. */
  macdHist: number | null;
  macdPrevHist: number | null;
  /** RSI(14) of the real 15m closes. */
  rsi: number | null;
  bars: number;
  lastBarAt: string | null;
  source: string;
  reason?: string;
}

/** The 15m indicators for `direction` from completed 15m bars (oldest first; trend-tag mergeTrendBars). */
export function indicatorReading(bars15: readonly TrendBar[], direction: Direction, now: Date, source: string): IndicatorReading {
  const tag = classifyTrend({ kind: direction === 'BULLISH' ? 'CE' : 'PE', side: 'BUY', bars: bars15, now, source });
  const bars = bars15.slice(-TREND_MAX_BARS);
  const m = bars.length ? macdHistogram(heikinCloses(bars)) : null;
  const rs = rsi(bars.map((b) => b.close), ENTRY_ENGINE.rsiPeriod);
  return {
    direction,
    tag: tag.tag,
    trend: tag.trend,
    ema20: tag.ema20,
    ema80: tag.ema80,
    macdHist: tag.tag === 'UNKNOWN' ? null : r4(m?.hist ?? null),
    macdPrevHist: tag.tag === 'UNKNOWN' ? null : r4(m?.prevHist ?? null),
    rsi: r2(rs),
    bars: tag.candleCount,
    lastBarAt: tag.lastBarAt,
    source,
    ...(tag.reason ? { reason: tag.reason } : {}),
  };
}

export type GateVerdict = 'PASS' | 'BLOCK' | 'WAIT' | 'UNKNOWN';

export interface GateResult {
  verdict: GateVerdict;
  /** The reading in a few words, for the trade's entryReason summary ("indicators: ✓ WITH, MACD 32.1 rising, RSI 84"). */
  compact: string;
  /** The full explanation (the decision's reasons). */
  reason: string;
}

const fmt = (x: number | null, d = 2) => (x === null ? 'n/a' : x.toFixed(d));

/**
 * The indicators gate for an entry in `r.direction`: tag AGAINST → BLOCK; MACD histogram neither on the entry's side
 * of zero nor moving toward it → BLOCK; RSI at / beyond the line → WAIT; UNKNOWN tag → UNKNOWN (never blocks; RSI
 * is still checked when readable). Else PASS.
 */
export function indicatorGate(r: IndicatorReading): GateResult {
  const s = r.direction === 'BULLISH' ? 1 : -1;
  const side = r.direction === 'BULLISH' ? 'CE' : 'PE';
  const h = r.macdHist;
  const p = r.macdPrevHist;
  const slope = h === null || p === null ? '' : h > p ? ' rising' : h < p ? ' falling' : ' flat';
  const compact = `${r.tag}, MACD ${fmt(h, 1)}${slope}, RSI ${fmt(r.rsi, 0)}`;
  const read = `15m tag ${r.tag}${r.trend ? ` (${r.trend})` : ''}, EMA20 ${fmt(r.ema20)} / EMA80 ${fmt(r.ema80)}, MACD hist ${fmt(h, 3)} (prev ${fmt(p, 3)}), RSI(${ENTRY_ENGINE.rsiPeriod}) ${fmt(r.rsi, 1)}; ${r.bars} bars, ${r.source}`;
  const rsiWait =
    r.rsi !== null && (s > 0 ? r.rsi >= ENTRY_ENGINE.rsiOverbought : r.rsi <= ENTRY_ENGINE.rsiOversold)
      ? `RSI ${fmt(r.rsi, 1)} ${s > 0 ? `≥ ${ENTRY_ENGINE.rsiOverbought} (overbought)` : `≤ ${ENTRY_ENGINE.rsiOversold} (oversold)`}, wait for it to cool`
      : null;
  if (r.tag === 'UNKNOWN') {
    if (rsiWait) return { verdict: 'WAIT', compact, reason: `${rsiWait}; tag UNKNOWN (${r.reason ?? 'too few bars'}); ${read}` };
    return { verdict: 'UNKNOWN', compact, reason: `tag UNKNOWN, not blocking (${r.reason ?? 'too few 15m bars'}); ${read}` };
  }
  if (r.tag === 'AGAINST') return { verdict: 'BLOCK', compact, reason: `15m trend AGAINST a ${side} (EMA20/80 and MACD both ${s > 0 ? 'bearish' : 'bullish'}); ${read}` };
  const macdOk = h !== null && (s * h > 0 || (p !== null && s * (h - p) > 0));
  if (!macdOk) return { verdict: 'BLOCK', compact, reason: `MACD histogram ${fmt(h, 3)} neither ${s > 0 ? 'positive' : 'negative'} nor ${s > 0 ? 'rising' : 'falling'} (prev ${fmt(p, 3)}); ${read}` };
  if (rsiWait) return { verdict: 'WAIT', compact, reason: `${rsiWait}; ${read}` };
  return { verdict: 'PASS', compact, reason: read };
}

// ───────────────────────────── chase / extension ─────────────────────────────

export interface ExtensionReading {
  direction: Direction;
  price: number | null;
  /** ATR14 of completed 15m bars (mean true range). */
  n15: number | null;
  /** The 30-min low (CE) / high (PE) of closed 1m bars. */
  swingRef: number | null;
  /** (price − swingRef) / N15 for CE; (swingRef − price) / N15 for PE. ≥ 0. */
  fromSwingN15: number | null;
  /** EMA20 of completed 15m real closes. */
  ema20: number | null;
  /** (price − EMA20) / N15 for CE; (EMA20 − price) / N15 for PE. Negative = on the other side of it. */
  fromEma20N15: number | null;
}

const istDay = (ts: number) => Math.floor((ts + 330 * MIN) / (24 * 60 * MIN));

/**
 * Mean true range of the last `period` completed 15m bars. A session's first bar is its own high − low: the
 * overnight gap is not an intraday swing (11-11 NIFTY: the 09:15 bar's TR with the gap was 354 vs a 132 range,
 * one bar lifting N15 by ~30%).
 */
export function atr15(bars15: readonly TrendBar[], period = ENTRY_ENGINE.atrPeriod): number | null {
  if (bars15.length < period + 1) return null;
  const tail = bars15.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < tail.length; i++) {
    const b = tail[i];
    const pc = tail[i - 1].close;
    sum += istDay(b.ts) !== istDay(tail[i - 1].ts) ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  const n = sum / period;
  return n > 0 ? n : null;
}

/** How far the price ran for an entry in `direction` at `at` (1m bars for the swing, 15m bars for N15 / EMA20). */
export function extensionReading(i: { bars15: readonly TrendBar[]; bars1m: readonly Bar1m[]; price: number | null; at: Date; direction: Direction }): ExtensionReading {
  const t = i.at.getTime();
  const s = i.direction === 'BULLISH' ? 1 : -1;
  const n15 = atr15(i.bars15);
  const recent = i.bars1m.filter((b) => b.ts >= t - ENTRY_ENGINE.swingLookbackMin * MIN && b.ts + MIN <= t && b.low > 0 && b.high > 0);
  const swingRef = recent.length ? (s > 0 ? Math.min(...recent.map((b) => b.low)) : Math.max(...recent.map((b) => b.high))) : null;
  const ema20 = lastEma(i.bars15.map((b) => b.close), ENTRY_ENGINE.extEmaPeriod);
  const p = i.price !== null && i.price > 0 ? i.price : null;
  const ok = p !== null && n15 !== null;
  return {
    direction: i.direction,
    price: p,
    n15: r2(n15),
    swingRef,
    fromSwingN15: ok && swingRef !== null ? r2(Math.max(0, (s * (p! - swingRef)) / n15!)) : null,
    ema20: r2(ema20),
    fromEma20N15: ok && ema20 !== null ? r2((s * (p! - ema20)) / n15!) : null,
  };
}

/** The chase gate: WAIT when a gated distance is at / beyond its threshold; UNKNOWN (never blocks) when unreadable. */
export function chaseGate(e: ExtensionReading): GateResult {
  const side = e.direction === 'BULLISH' ? 'low' : 'high';
  const compact = `${fmt(e.fromSwingN15)} N15 off the ${ENTRY_ENGINE.swingLookbackMin}-min ${side}, ${fmt(e.fromEma20N15, 1)} N15 past EMA20`;
  const read = `price ${e.price ?? 'n/a'}, ${ENTRY_ENGINE.swingLookbackMin}-min ${side} ${e.swingRef ?? 'n/a'}, 15m EMA20 ${fmt(e.ema20)}, N15 (ATR${ENTRY_ENGINE.atrPeriod} of 15m) ${fmt(e.n15)}; wait at ≥ ${ENTRY_ENGINE.maxFromSwingN15} N15 off the ${side}`;
  if (e.fromSwingN15 === null && e.fromEma20N15 === null) return { verdict: 'UNKNOWN', compact, reason: `unreadable, not blocking; ${read}` };
  const over: string[] = [];
  if (e.fromSwingN15 !== null && e.fromSwingN15 >= ENTRY_ENGINE.maxFromSwingN15) over.push(`${e.fromSwingN15} ≥ ${ENTRY_ENGINE.maxFromSwingN15} N15 off the ${side}`);
  const emaMax = ENTRY_ENGINE.maxFromEma20N15;
  if (emaMax !== null && e.fromEma20N15 !== null && e.fromEma20N15 >= emaMax) over.push(`${e.fromEma20N15} ≥ ${emaMax} N15 past the EMA20`);
  if (over.length) return { verdict: 'WAIT', compact, reason: `already extended (${over.join('; ')}), wait for a pullback; ${read}` };
  return { verdict: 'PASS', compact, reason: read };
}

// ───────────────────────────── cluster ─────────────────────────────

export interface ClusterFacts {
  underlying: string;
  direction: Direction;
  /** Open engine positions anywhere in the index cluster (this underlying included), per direction; null = unreadable. */
  openBullish: number | null;
  openBearish: number | null;
  /** Underlyings of the cluster already entered (paper trade opened) earlier in this scan pass. */
  enteredThisPass: readonly string[];
}

/** The correlated-bet cap. Not in the cluster → PASS; an unreadable open count blocks (fails closed, like the cooldowns). */
export function clusterGate(c: ClusterFacts): GateResult {
  if (!inIndexCluster(c.underlying)) return { verdict: 'PASS', compact: 'not an index', reason: `${c.underlying.toUpperCase()} is not in the index cluster` };
  const open = c.direction === 'BULLISH' ? c.openBullish : c.openBearish;
  const dir = c.direction.toLowerCase();
  const compact = `${open ?? '?'} ${dir} open, ${c.enteredThisPass.length} entered this scan`;
  const why: string[] = [];
  if (open === null) why.push('open cluster positions unreadable');
  else if (open >= ENTRY_ENGINE.maxClusterOpenPerDirection) why.push(`${open} ${dir} engine position(s) already open in the index cluster (max ${ENTRY_ENGINE.maxClusterOpenPerDirection} per direction)`);
  if (c.enteredThisPass.length >= ENTRY_ENGINE.maxClusterEntriesPerPass) why.push(`${c.enteredThisPass.join(', ')} already entered for the index cluster in this scan (max ${ENTRY_ENGINE.maxClusterEntriesPerPass} per pass)`);
  const members = `cluster ${INDEX_CLUSTER.join('/')} is one bet`;
  if (why.length) return { verdict: 'BLOCK', compact, reason: `${why.join('; ')}; ${members}` };
  return { verdict: 'PASS', compact, reason: members };
}

// ───────────────────────────── combine ─────────────────────────────

const mark = (g: GateResult) => (g.verdict === 'PASS' ? '✓' : g.verdict === 'UNKNOWN' ? '?' : g.verdict === 'WAIT' ? 'WAIT' : '✗');

/**
 * One reason line in the decision's "component: verdict — detail" form. The part before " — " is what the trade's
 * entryReason summary keeps (entry-engine.service: "news: ✓; trend: ✓; oi: ✓; indicators: ✓ WITH, MACD 32.1 rising, RSI 84; …").
 */
export function gateLine(name: string, g: GateResult): string {
  return `${name}: ${mark(g)} ${g.compact} — ${g.reason}`;
}

export interface GateReadings {
  indicators: IndicatorReading | null;
  extension: ExtensionReading | null;
}

export interface GatedAction {
  /** ENTER_* unchanged, NO_TRADE (indicators BLOCK) or WAIT (RSI / chase). */
  action: 'ENTER_CE' | 'ENTER_PE' | 'NO_TRADE' | 'WAIT';
  indicators: GateResult;
  chase: GateResult;
  /** Reason lines (gateLine). */
  reasons: string[];
}

const notRead = (why: string): GateResult => ({ verdict: 'UNKNOWN', compact: 'not read', reason: `not read (${why}), not blocking` });

/**
 * Applies the indicators + chase gates to the news / trend / OI action. Only an ENTER can change: indicators BLOCK →
 * NO_TRADE, then any WAIT → WAIT. A NO_TRADE stays NO_TRADE (the readings are still recorded as reasons).
 */
export function applyEntryGates(action: 'ENTER_CE' | 'ENTER_PE' | 'NO_TRADE', g: GateReadings, unreadWhy = 'no bars'): GatedAction {
  const ind = g.indicators ? indicatorGate(g.indicators) : notRead(unreadWhy);
  const ch = g.extension ? chaseGate(g.extension) : notRead(unreadWhy);
  const reasons = [gateLine('indicators', ind), gateLine('chase', ch)];
  if (action === 'NO_TRADE') return { action, indicators: ind, chase: ch, reasons };
  if (ind.verdict === 'BLOCK') return { action: 'NO_TRADE', indicators: ind, chase: ch, reasons };
  if (ind.verdict === 'WAIT' || ch.verdict === 'WAIT') return { action: 'WAIT', indicators: ind, chase: ch, reasons };
  return { action, indicators: ind, chase: ch, reasons };
}

