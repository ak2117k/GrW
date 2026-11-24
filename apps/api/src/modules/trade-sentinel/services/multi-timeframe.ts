/**
 * The owner's top-down read of a trade, one timeframe at a time (3m, 15m, 30m, 1h, 1d):
 *   1. trend = EMA20 vs EMA80 on closes,
 *   2. does MACD(12,26,9) agree (histogram sign AND its slope over the last 3 bars),
 *   3. where price sits vs the two EMAs (and "testing" one within 0.25 x ATR14 of that timeframe),
 *   4. swing structure from pivots on 1d / 1h / 30m / 15m,
 * then an alignment summary. No single winner: every timeframe is reported; the daily is labelled the
 * higher-timeframe bias.
 *
 * PURE: no I/O, no clock. Bars are epoch-ms UTC, oldest first. Volume is ignored on purpose (15m
 * volumes in our DB are garbage).
 */
import { emaSeries } from '../../overnight-scorecard/domain/indicators';

export interface Bar {
  /** Bar open time, epoch ms (UTC). */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Tf = '3m' | '15m' | '30m' | '1h' | '1d';
export const TIMEFRAMES: readonly Tf[] = ['1d', '1h', '30m', '15m', '3m'];
/** Timeframes that also get a swing-structure read. */
const STRUCTURE_TFS: ReadonlySet<Tf> = new Set<Tf>(['1d', '1h', '30m', '15m']);

export type Trend = 'UP' | 'DOWN' | 'FLAT';
export type HistSlope = 'RISING' | 'FALLING' | 'FLAT';
export type Location = 'ABOVE_BOTH' | 'BETWEEN' | 'BELOW_BOTH';
export type Verdict = 'BULLISH_CONFIRMED' | 'BEARISH_CONFIRMED' | 'BULLISH_WEAKENING' | 'BEARISH_WEAKENING' | 'MIXED';

export interface Structure {
  kind: 'UPTREND' | 'DOWNTREND' | 'RANGE';
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
}

export interface TimeframeRead {
  available: true;
  tf: Tf;
  bars: number;
  close: number;
  ema20: number;
  ema80: number;
  atr14: number;
  trend: Trend;
  macdHist: number;
  histSlope: HistSlope;
  macdAgrees: boolean;
  location: Location;
  testing: null | 'EMA20' | 'EMA80';
  structure?: Structure;
  verdict: Verdict;
}

export interface TimeframeUnavailable {
  available: false;
  tf: Tf;
  reason: string;
}

export type TimeframeResult = TimeframeRead | TimeframeUnavailable;

export interface Alignment {
  bullish: number;
  bearish: number;
  /** Available timeframes that are neither confirmed bullish nor confirmed bearish (weakening or mixed). */
  mixed: number;
  unavailable: number;
  /** The daily read: its verdict, or 'UNAVAILABLE'. */
  higherTimeframeBias: Verdict | 'UNAVAILABLE';
  /** Available timeframes whose lean (bull / bear / none) differs from the daily's. Empty when the daily is unavailable. */
  disagreeWithDaily: Tf[];
  summary: string;
}

export interface MultiTimeframeView {
  timeframes: Record<Tf, TimeframeResult>;
  alignment: Alignment;
  /** With `now` given: the newest bar of each source, IST text (null = none). Lets the reader see how fresh the read is. */
  lastBarIst?: { '1m': string | null; '15m': string | null; '1d': string | null };
  /** With `now` given: the reference levels for a room check (null when unreadable). */
  levels?: DayLevels;
}

/** Previous completed session's high / low, today's range so far, and the daily ATR14 (all on the underlying's scale). */
export interface DayLevels {
  prevDayHigh: number | null;
  prevDayLow: number | null;
  todayHigh: number | null;
  todayLow: number | null;
  dailyAtr14: number | null;
}

export interface MultiTimeframeInput {
  exchange: string;
  '1m'?: readonly Bar[];
  '15m'?: readonly Bar[];
  '1d'?: readonly Bar[];
  /**
   * Epoch ms. When given: (a) a source whose newest bar is older than the session it should cover is
   * STALE and every timeframe built from it is reported unavailable with that reason — never a read of
   * old bars presented as current; (b) today's forming daily bar is built from today's 15m bars when
   * the daily series does not have it yet, so 1d reflects today's move.
   */
  now?: number;
}

/** Intraday source lag allowed past the latest expected bar (bars arrive late; 15m is stamped at its open). */
export const STALE_LAG_MIN = { '1m': 10, '15m': 35 } as const;

const istText = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ');
const istDayStartUtc = (ms: number) => {
  const d = new Date(ms + 330 * 60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 330 * 60_000;
};
const isWeekend = (dayStartUtc: number) => {
  const wd = new Date(dayStartUtc + 330 * 60_000).getUTCDay();
  return wd === 0 || wd === 6;
};

/**
 * The newest instant an intraday source should have a bar for: `now` inside today's session, else the
 * close of the latest weekday session at or before `now`. Holidays are not known here, so the day after
 * one can read stale — stated as stale, which is the safe direction. Pure.
 */
export function expectedLatestBar(now: number, exchange: string): number {
  const s = sessionFor(exchange);
  let day = istDayStartUtc(now);
  for (let i = 0; i < 10; i++) {
    if (!isWeekend(day)) {
      const open = day + s.open * 60_000;
      const close = day + s.close * 60_000;
      if (now >= open) return Math.min(now, close);
    }
    day -= DAY_MS;
  }
  return now;
}

/** Null when fresh, else the reason. 1d must include the previous weekday's (or today's) bar. Pure. */
export function staleReason(source: '1m' | '15m' | '1d', bars: readonly Bar[], now: number, exchange: string): string | null {
  if (bars.length === 0) return null; // "no bars" is reported by the builder itself
  const last = bars[bars.length - 1].ts;
  if (source === '1d') {
    let prev = istDayStartUtc(now) - DAY_MS;
    while (isWeekend(prev)) prev -= DAY_MS;
    // Daily bars are stamped at IST midnight (or 00:00 UTC by some sources): allow the whole previous weekday.
    return last >= prev - 330 * 60_000 ? null : `stale: newest daily bar is ${istText(last).slice(0, 10)} — the previous session is missing`;
  }
  const expected = expectedLatestBar(now, exchange);
  const lag = STALE_LAG_MIN[source] * 60_000;
  return last >= expected - lag ? null : `stale: newest ${source} bar is ${istText(last)} IST, expected one near ${istText(expected)} IST`;
}

/**
 * The daily series with today's forming bar appended (built from today's in-session 15m bars) when the
 * series has no bar for today yet. Pure.
 */
export function withTodayDaily(daily: readonly Bar[], fifteen: readonly Bar[], exchange: string, now: number): Bar[] {
  const today = istDayStartUtc(now);
  const out = [...daily];
  if (out.length && out[out.length - 1].ts >= today - 330 * 60_000) return out; // already has today (either stamp)
  const todays = sessionBars(sanitizeBars(fifteen), exchange).filter((b) => b.ts >= today && b.ts <= now);
  if (todays.length === 0) return out;
  out.push({
    ts: today,
    open: todays[0].open,
    high: Math.max(...todays.map((b) => b.high)),
    low: Math.min(...todays.map((b) => b.low)),
    close: todays[todays.length - 1].close,
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** EMA80 needs history to settle: fewer bars than this and the timeframe is reported unavailable. */
export const MIN_BARS = 100;
/** "Testing" an EMA: close within this many ATR14 of it. */
export const TEST_ATR = 0.25;
/** EMA20 and EMA80 closer than this many ATR14 = no trend (FLAT). */
export const FLAT_TREND_ATR = 0.1;
/** Histogram change over 3 bars smaller than this many ATR14 = FLAT slope. */
export const FLAT_SLOPE_ATR = 0.01;
/** Pivot half-width: a swing high is the highest of PIVOT_K bars each side. */
export const PIVOT_K = 2;

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

interface Session {
  open: number;
  close: number;
}
/** IST minutes-of-day [open, close). */
const NSE_SESSION: Session = { open: 9 * 60 + 15, close: 15 * 60 + 30 };
const MCX_SESSION: Session = { open: 9 * 60, close: 23 * 60 + 30 };

export function sessionFor(exchange: string): Session {
  return String(exchange ?? '').toUpperCase() === 'MCX' ? MCX_SESSION : NSE_SESSION;
}

// ---------------------------------------------------------------------------------------------
// Bar hygiene + aggregation
// ---------------------------------------------------------------------------------------------

const finitePos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/** Drop bars with non-positive / NaN OHLC, high < low, or a bad timestamp; sort oldest first; dedupe by ts. */
export function sanitizeBars(bars: readonly Bar[] | undefined | null): Bar[] {
  if (!bars) return [];
  const ok = bars.filter(
    (b) =>
      b != null &&
      Number.isFinite(b.ts) &&
      finitePos(b.open) &&
      finitePos(b.high) &&
      finitePos(b.low) &&
      finitePos(b.close) &&
      b.high >= b.low,
  );
  ok.sort((a, b) => a.ts - b.ts);
  const out: Bar[] = [];
  for (const b of ok) {
    if (out.length && out[out.length - 1].ts === b.ts) out[out.length - 1] = b;
    else out.push({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close });
  }
  return out;
}

const istMinuteOfDay = (ts: number) => Math.floor((((ts + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
const istDay = (ts: number) => Math.floor((ts + IST_OFFSET_MS) / DAY_MS);

/** Keep only bars that open inside the exchange's regular session (drops 08:45 / 09:00 pre-open prints on NSE). */
export function sessionBars(bars: readonly Bar[], exchange: string): Bar[] {
  const s = sessionFor(exchange);
  return sanitizeBars(bars).filter((b) => {
    const m = istMinuteOfDay(b.ts);
    return m >= s.open && m < s.close;
  });
}

/**
 * Aggregate intraday bars into `minutes`-wide bars, session-anchored (09:15 IST for NSE/NFO/BFO,
 * 09:00 for MCX): bucket = floor(minutesSinceOpen / minutes) within each IST day. Out-of-session
 * and bad bars are dropped first. The last bucket of a session may be partial (e.g. 15:15–15:30 for 1h),
 * and the newest bucket may still be forming — both are kept, as on a chart.
 */
export function aggregateBars(bars: readonly Bar[], minutes: number, exchange = 'NSE'): Bar[] {
  if (!(minutes > 0)) return [];
  const s = sessionFor(exchange);
  const out: Bar[] = [];
  let key: number | null = null;
  for (const b of sessionBars(bars, exchange)) {
    const day = istDay(b.ts);
    const bucket = Math.floor((istMinuteOfDay(b.ts) - s.open) / minutes);
    const k = day * 10_000 + bucket;
    if (k !== key) {
      key = k;
      const ts = day * DAY_MS - IST_OFFSET_MS + (s.open + bucket * minutes) * 60_000;
      out.push({ ts, open: b.open, high: b.high, low: b.low, close: b.close });
    } else {
      const cur = out[out.length - 1];
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------------------------

/** MACD(12,26,9) histogram series aligned to the end of `closes` (oldest first). Empty when too short. */
export function macdHistSeries(closes: readonly number[]): number[] {
  const fast = emaSeries(closes, 12); // fast[j] ↔ closes[j + 11]
  const slow = emaSeries(closes, 26); // slow[i] ↔ closes[i + 25]
  if (slow.length === 0) return [];
  const macd = slow.map((v, i) => fast[i + 14] - v);
  const signal = emaSeries(macd, 9); // signal[j] ↔ macd[j + 8]
  return signal.map((sig, j) => macd[j + 8] - sig);
}

/** Wilder ATR(period). null when fewer than period + 1 bars. */
export function atr(bars: readonly Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  let a = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

/** Fractal pivots: a swing high is above the K bars before it and not below the K bars after it (likewise lows). */
export function pivots(bars: readonly Bar[], k = PIVOT_K): { highs: Array<{ i: number; price: number }>; lows: Array<{ i: number; price: number }> } {
  const highs: Array<{ i: number; price: number }> = [];
  const lows: Array<{ i: number; price: number }> = [];
  for (let i = k; i < bars.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= k; j++) {
      if (!(bars[i].high > bars[i - j].high) || bars[i].high < bars[i + j].high) isHigh = false;
      if (!(bars[i].low < bars[i - j].low) || bars[i].low > bars[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ i, price: bars[i].high });
    if (isLow) lows.push({ i, price: bars[i].low });
  }
  return { highs, lows };
}

/** HH + HL = UPTREND, LH + LL = DOWNTREND, else RANGE (also when fewer than two swings of either kind). */
export function swingStructure(bars: readonly Bar[], k = PIVOT_K): Structure {
  const { highs, lows } = pivots(bars, k);
  const ref = bars.length ? bars[bars.length - 1].close : 0;
  const lastHigh = highs.length ? round(highs[highs.length - 1].price, ref) : null;
  const lastLow = lows.length ? round(lows[lows.length - 1].price, ref) : null;
  if (highs.length < 2 || lows.length < 2) return { kind: 'RANGE', lastSwingHigh: lastHigh, lastSwingLow: lastLow };
  const [h1, h2] = [highs[highs.length - 2].price, highs[highs.length - 1].price];
  const [l1, l2] = [lows[lows.length - 2].price, lows[lows.length - 1].price];
  const kind = h2 > h1 && l2 > l1 ? 'UPTREND' : h2 < h1 && l2 < l1 ? 'DOWNTREND' : 'RANGE';
  return { kind, lastSwingHigh: lastHigh, lastSwingLow: lastLow };
}

/** 4 dp under 100, 2 dp otherwise (`ref` picks the scale; defaults to the value itself). */
export function round(x: number, ref: number = x): number {
  const dp = Math.abs(ref) < 100 ? 4 : 2;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------------------------
// One timeframe
// ---------------------------------------------------------------------------------------------

/**
 * The read of one timeframe from already-built, sanitized bars (oldest first). Unavailable when fewer
 * than {@link MIN_BARS} bars (EMA80 is not meaningful yet).
 */
export function timeframeRead(bars: readonly Bar[], tf: Tf, opts: { structure?: boolean } = {}): TimeframeResult {
  const clean = sanitizeBars(bars);
  if (clean.length < MIN_BARS) return { available: false, tf, reason: `only ${clean.length} bars (need ${MIN_BARS})` };
  const closes = clean.map((b) => b.close);
  const close = closes[closes.length - 1];
  const e20s = emaSeries(closes, 20);
  const e80s = emaSeries(closes, 80);
  const hist = macdHistSeries(closes);
  const a = atr(clean, 14);
  if (!e20s.length || !e80s.length || hist.length < 3 || a === null) {
    return { available: false, tf, reason: 'indicators could not be computed' };
  }
  const ema20 = e20s[e20s.length - 1];
  const ema80 = e80s[e80s.length - 1];
  const h = hist[hist.length - 1];
  const dHist = h - hist[hist.length - 3];

  const trend: Trend = Math.abs(ema20 - ema80) < FLAT_TREND_ATR * a ? 'FLAT' : ema20 > ema80 ? 'UP' : 'DOWN';
  const histSlope: HistSlope = Math.abs(dHist) < FLAT_SLOPE_ATR * a ? 'FLAT' : dHist > 0 ? 'RISING' : 'FALLING';
  const location: Location = close > Math.max(ema20, ema80) ? 'ABOVE_BOTH' : close < Math.min(ema20, ema80) ? 'BELOW_BOTH' : 'BETWEEN';
  const d20 = Math.abs(close - ema20);
  const d80 = Math.abs(close - ema80);
  const band = TEST_ATR * a;
  const testing = d20 <= band || d80 <= band ? (d20 <= d80 ? 'EMA20' : 'EMA80') : null;

  const macdAgrees =
    (trend === 'UP' && h > 0 && histSlope !== 'FALLING') || (trend === 'DOWN' && h < 0 && histSlope !== 'RISING');
  const verdict = verdictOf(trend, h, histSlope, location);

  const out: TimeframeRead = {
    available: true,
    tf,
    bars: clean.length,
    close: round(close),
    ema20: round(ema20, close),
    ema80: round(ema80, close),
    atr14: round(a, close),
    trend,
    macdHist: round(h, close),
    histSlope,
    macdAgrees,
    location,
    testing,
    verdict,
  };
  if (opts.structure) out.structure = swingStructure(clean);
  return out;
}

/**
 * UP trend: MACD positive and not falling = CONFIRMED; MACD positive but falling, or negative but
 * rising = WEAKENING; negative and not rising = MIXED. Price below both EMAs caps an UP trend at
 * WEAKENING. Mirror for DOWN. FLAT = MIXED.
 */
function verdictOf(trend: Trend, h: number, slope: HistSlope, loc: Location): Verdict {
  if (trend === 'FLAT') return 'MIXED';
  const up = trend === 'UP';
  const signOk = up ? h > 0 : h < 0;
  const slopeAgainst = up ? slope === 'FALLING' : slope === 'RISING';
  const slopeWith = up ? slope === 'RISING' : slope === 'FALLING';
  const locAgainst = up ? loc === 'BELOW_BOTH' : loc === 'ABOVE_BOTH';
  let strength: 'CONFIRMED' | 'WEAKENING' | 'MIXED';
  if (signOk && !slopeAgainst) strength = 'CONFIRMED';
  else if (signOk || slopeWith) strength = 'WEAKENING';
  else strength = 'MIXED';
  if (strength === 'CONFIRMED' && locAgainst) strength = 'WEAKENING';
  if (strength === 'MIXED') return 'MIXED';
  return `${up ? 'BULLISH' : 'BEARISH'}_${strength}` as Verdict;
}

// ---------------------------------------------------------------------------------------------
// All timeframes + alignment
// ---------------------------------------------------------------------------------------------

export function multiTimeframeView(input: MultiTimeframeInput): MultiTimeframeView {
  const ex = input.exchange;
  const now = input.now;
  const one = input['1m'];
  const fifteen = input['15m'];
  let daily = sanitizeBars(input['1d']);

  // Staleness (only with `now`): a stale source yields no timeframe at all, with the reason. Judged on SESSION bars
  // (2026-11-24): a flat off-hours copy or a pre-open print is not a fresh bar of a series the timeframes never use.
  // A series with no session bar at all is judged on what it has (its newest bar names how old it is).
  const judged = (b: readonly Bar[]) => {
    const s = sessionBars(b, ex);
    return s.length ? s : sanitizeBars(b);
  };
  const stale1m = now !== undefined && one ? staleReason('1m', judged(one), now, ex) : null;
  const stale15 = now !== undefined && fifteen ? staleReason('15m', judged(fifteen), now, ex) : null;
  if (now !== undefined && fifteen && !stale15) daily = withTodayDaily(daily, fifteen, ex, now);
  const stale1d = now !== undefined && input['1d'] ? staleReason('1d', daily, now, ex) : null;

  const build = (tf: Tf, bars: Bar[] | null, missing: string, stale: string | null): TimeframeResult =>
    stale
      ? { available: false, tf, reason: stale }
      : bars === null
        ? { available: false, tf, reason: missing }
        : timeframeRead(bars, tf, { structure: STRUCTURE_TFS.has(tf) });

  const timeframes: Record<Tf, TimeframeResult> = {
    '3m': build('3m', one ? aggregateBars(one, 3, ex) : null, 'no 1m bars', stale1m),
    '15m': build('15m', fifteen ? sessionBars(fifteen, ex) : null, 'no 15m bars', stale15),
    '30m': build('30m', fifteen ? aggregateBars(fifteen, 30, ex) : null, 'no 15m bars', stale15),
    '1h': build('1h', fifteen ? aggregateBars(fifteen, 60, ex) : null, 'no 15m bars', stale15),
    '1d': build('1d', input['1d'] ? daily : null, 'no daily bars', stale1d),
  };
  const lastOf = (b: readonly Bar[] | undefined) => {
    const s = sanitizeBars(b);
    return s.length ? istText(s[s.length - 1].ts) : null;
  };
  return {
    timeframes,
    alignment: alignmentOf(timeframes),
    ...(now !== undefined ? { lastBarIst: { '1m': lastOf(one), '15m': lastOf(fifteen), '1d': lastOf(daily) }, levels: dayLevels(daily, fifteen ?? [], ex, now) } : {}),
  };
}

type Lean = 'BULL' | 'BEAR' | 'NONE';
const leanOf = (v: Verdict): Lean => (v.startsWith('BULLISH') ? 'BULL' : v.startsWith('BEARISH') ? 'BEAR' : 'NONE');

export function alignmentOf(tfs: Record<Tf, TimeframeResult>): Alignment {
  let bullish = 0;
  let bearish = 0;
  let mixed = 0;
  let unavailable = 0;
  const reads: TimeframeRead[] = [];
  for (const tf of TIMEFRAMES) {
    const r = tfs[tf];
    if (!r.available) {
      unavailable++;
      continue;
    }
    reads.push(r);
    if (r.verdict === 'BULLISH_CONFIRMED') bullish++;
    else if (r.verdict === 'BEARISH_CONFIRMED') bearish++;
    else mixed++;
  }
  const d = tfs['1d'];
  const higherTimeframeBias = d.available ? d.verdict : 'UNAVAILABLE';
  const disagreeWithDaily = d.available ? reads.filter((r) => r.tf !== '1d' && leanOf(r.verdict) !== leanOf(d.verdict)).map((r) => r.tf) : [];

  const parts = TIMEFRAMES.map((tf) => fragment(tfs[tf]));
  let tail: string;
  if (!reads.length) tail = 'no timeframe has enough bars';
  else {
    const leans = new Set(reads.map((r) => leanOf(r.verdict)));
    const allConfirmed = reads.every((r) => r.verdict.endsWith('CONFIRMED'));
    if (leans.size === 1 && !leans.has('NONE')) {
      const side = leans.has('BULL') ? 'bullish' : 'bearish';
      tail = allConfirmed ? `timeframes aligned ${side}` : `timeframes lean ${side}, not all confirmed`;
    } else tail = 'timeframes disagree';
  }
  const summary = `${parts.join(', ')} — ${tail}`;
  return { bullish, bearish, mixed, unavailable, higherTimeframeBias, disagreeWithDaily, summary };
}

/** One clause per timeframe, e.g. "1d down (testing EMA80 13.06 from below)", "1h up but MACD falling", "15m mixed". */
function fragment(r: TimeframeResult): string {
  if (!r.available) return `${r.tf} n/a`;
  if (r.verdict === 'MIXED') {
    const lean = r.trend === 'FLAT' ? 'flat EMAs' : `EMAs ${r.trend.toLowerCase()} but MACD against`;
    return `${r.tf} mixed (${lean}${testingNote(r, ', ')})`;
  }
  const up = r.trend === 'UP';
  let s = `${r.tf} ${up ? 'up' : 'down'}`;
  if (r.verdict.endsWith('WEAKENING')) {
    const reasons: string[] = [];
    if (up ? r.macdHist <= 0 : r.macdHist >= 0) reasons.push(`MACD ${up ? 'below' : 'above'} zero`);
    if (up ? r.histSlope === 'FALLING' : r.histSlope === 'RISING') reasons.push(`MACD ${up ? 'falling' : 'rising'}`);
    else if (up ? r.histSlope === 'RISING' && r.macdHist <= 0 : r.histSlope === 'FALLING' && r.macdHist >= 0) reasons.push(`MACD turning ${up ? 'up' : 'down'}`);
    if (up ? r.location === 'BELOW_BOTH' : r.location === 'ABOVE_BOTH') reasons.push(`price ${up ? 'below' : 'above'} both EMAs`);
    if (reasons.length) s += ` but ${reasons.join(', ')}`;
  }
  const t = testingNote(r, '');
  if (t) s += ` (${t})`;
  if (r.structure && r.structure.kind !== 'RANGE' && (r.structure.kind === 'UPTREND') !== up) s += `, structure ${r.structure.kind.toLowerCase()}`;
  return s;
}

function testingNote(r: TimeframeRead, prefix: string): string {
  if (!r.testing) return '';
  const lvl = r.testing === 'EMA20' ? r.ema20 : r.ema80;
  const side = r.close >= lvl ? 'above' : 'below';
  return `${prefix}testing ${r.testing} ${lvl} from ${side}`;
}

/** Room-check levels: the last COMPLETED daily bar before today, today's in-session 15m range, daily ATR14. Pure. */
export function dayLevels(daily: readonly Bar[], fifteen: readonly Bar[], exchange: string, now: number): DayLevels {
  const today = istDayStartUtc(now);
  const d = sanitizeBars(daily);
  const prev = [...d].reverse().find((b) => b.ts < today - 330 * 60_000) ?? null;
  const todays = sessionBars(sanitizeBars(fifteen), exchange).filter((b) => b.ts >= today && b.ts <= now);
  const completed = d.filter((b) => b.ts < today - 330 * 60_000);
  const a = completed.length > 15 ? atr(completed, 14) : null;
  return {
    prevDayHigh: prev ? round(prev.high) : null,
    prevDayLow: prev ? round(prev.low) : null,
    todayHigh: todays.length ? round(Math.max(...todays.map((b) => b.high))) : null,
    todayLow: todays.length ? round(Math.min(...todays.map((b) => b.low))) : null,
    dailyAtr14: a !== null ? round(a) : null,
  };
}
