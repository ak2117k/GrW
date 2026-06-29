import {
  TradingStrategy,
  MarketSnapshot,
  SignalOutput,
  CandleData,
  BacktestInput,
  BacktestResult,
} from '../../../common/interfaces/trading-strategy.interface';
import { LevelBook } from '../types/level-book.types';
import {
  LevelType,
  SetupType,
  SetupGrade,
  SetupContext,
  TimeOfDayWindow,
  IndicatorReadings,
  Regime,
} from '../types/setup-context.types';
import { StrongZone } from '../types/zone.types';
import { ema, rsi, macd, bollinger, roc } from './indicators';

const DISTANCE_GATE_ATR = 0.5;       // |spot - level| ≤ 0.5 × ATR14
                                     // (was 0.3 — too tight for low-vol
                                     // stocks where levels are spread
                                     // in wider ATR-multiples)
const BREAKOUT_BODY_ATR = 0.15;      // close must be > level + 0.15 × ATR (tightened from 0.1)
const BREAKOUT_WICK_MAX_RATIO = 0.3; // wick on the breakout side < 30% of full bar range
const VOLUME_RATIO_MIN = 1.2;        // 5m volume / VMA20
const PINBAR_BODY_PCT = 0.3;         // body ≤ 30% of full candle range
const SL_BUFFER_ATR = 0.25;          // SL = level + 0.25 × ATR (asymmetric direction-aware)
const RR_FLOOR_STRICT = 2.0;
const STALE_TICK_MS = 60_000;
// Trading-window bounds. The strategy now evaluates the FULL session
// (no midday-chop filter). Per-exchange:
//   NSE/BSE  : 09:00 – 15:30 IST (technically opens 09:15 but 09:00
//              gives breathing room for pre-open carryover)
//   MCX      : 09:00 – 23:30 IST (full evening session, 11:30 PM)
const SESSION_OPEN = '09:00';
const SESSION_CLOSE_NSE = '15:30';
const SESSION_CLOSE_MCX = '23:30';

// "Prime" sub-windows used only by gradeSetup to upgrade a setup to A
// when other confluence is also present. Outside these, B and C are
// still tradeable; we just don't auto-A them.
const PRIME_MORNING_START_NSE = '09:45';
const PRIME_MORNING_START_MCX = '09:15';
const PRIME_MORNING_END_NSE = '10:30';
const PRIME_MORNING_END_MCX = '10:00';
const PRIME_AFTERNOON_START = '14:45';
const PRIME_AFTERNOON_END = '15:15';
const CONFLUENCE_RADIUS_ATR = 0.1;
const VOLUME_RATIO_GRADE_A = 1.4;

// Regime thresholds — intraday-range / atr14. Above TRENDING, breakouts
// are the "trade-with-the-day" play; below CHOPPY, reversals dominate.
const REGIME_TRENDING_RATIO = 1.5;
const REGIME_CHOPPY_RATIO = 0.7;

/**
 * Classify the day's regime from intraday range vs ATR14. Pure function;
 * used by the service to label every analyze() call. When the input range
 * is zero (very early in the session before bars accumulate, or off-hours
 * data) we return 'normal' rather than fabricate a bias.
 */
export function classifyRegime(input: {
  intradayRange: number;
  atr14: number;
}): { regime: Regime; intradayRangeRatio: number } {
  const { intradayRange, atr14 } = input;
  if (
    !Number.isFinite(intradayRange) ||
    !Number.isFinite(atr14) ||
    atr14 <= 0 ||
    intradayRange <= 0
  ) {
    return { regime: 'normal', intradayRangeRatio: 0 };
  }
  const ratio = intradayRange / atr14;
  if (ratio >= REGIME_TRENDING_RATIO) return { regime: 'trending', intradayRangeRatio: ratio };
  if (ratio <= REGIME_CHOPPY_RATIO) return { regime: 'choppy', intradayRangeRatio: ratio };
  return { regime: 'normal', intradayRangeRatio: ratio };
}

/**
 * Build the IndicatorReadings payload (EMA9/21, RSI14, MACD, Bollinger,
 * ROC10 + per-indicator alignment + agreement) from a window of recent
 * candles. Pure function — no I/O, no class state — so it's safe to call
 * from both the strategy's setup pipeline and the standalone
 * /signals/indicators endpoint.
 *
 * `isLong=true` flips alignment so "agrees with setup" stays +1 for BUY
 * setups; for standalone callers (no setup direction) pass the price
 * direction or default to true.
 */
export function buildIndicatorReadings(
  candles: CandleData[],
  spot: number,
  isLong: boolean,
): IndicatorReadings {
  const closes = candles.map((c) => c.close);
  const ema9Val = ema(closes, 9);
  const ema21Val = ema(closes, 21);
  const rsi14Val = rsi(closes, 14);
  const macdVal = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const roc10Val = roc(closes, 10);

  const macdHistogram = macdVal ? macdVal.histogram : null;

  // Bollinger position normalised to [-1, +1] using `(spot - middle) /
  // (upper - middle)`. When upper === middle (zero-volatility window)
  // we report 0 to avoid div-by-zero.
  let bollingerPosition: number | null = null;
  if (bb) {
    const denom = bb.upper - bb.middle;
    if (denom > 0) {
      const raw = (spot - bb.middle) / denom;
      bollingerPosition = Math.max(-1, Math.min(1, raw));
    } else {
      bollingerPosition = 0;
    }
  }

  // Per-indicator bullish-vote (+1 bullish, -1 bearish, 0 neutral). For
  // SELL setups we flip at the end so "agrees with setup" stays +1.
  const emaVote: 1 | 0 | -1 =
    ema9Val == null || ema21Val == null ? 0 : ema9Val > ema21Val ? 1 : -1;

  let rsiVote: 1 | 0 | -1 = 0;
  if (rsi14Val != null) {
    // 50<rsi<70 = bullish trend zone; 30<rsi<50 = bearish trend zone.
    // Outside [30,70] is "stretched" → neutral (0) regardless of side.
    if (rsi14Val > 50 && rsi14Val < 70) rsiVote = 1;
    else if (rsi14Val > 30 && rsi14Val < 50) rsiVote = -1;
    else rsiVote = 0;
  }

  const macdVote: 1 | 0 | -1 =
    macdHistogram == null ? 0 : macdHistogram > 0 ? 1 : macdHistogram < 0 ? -1 : 0;

  const bbVote: 1 | 0 | -1 =
    bollingerPosition == null
      ? 0
      : bollingerPosition > 0
        ? 1
        : bollingerPosition < 0
          ? -1
          : 0;

  const momentumVote: 1 | 0 | -1 =
    roc10Val == null ? 0 : roc10Val > 0 ? 1 : roc10Val < 0 ? -1 : 0;

  const flip = (v: 1 | 0 | -1): 1 | 0 | -1 =>
    v === 1 ? -1 : v === -1 ? 1 : 0;
  const align = (v: 1 | 0 | -1): 1 | 0 | -1 => (isLong ? v : flip(v));

  const alignment = {
    ema: align(emaVote),
    rsi: align(rsiVote),
    macd: align(macdVote),
    bollinger: align(bbVote),
    momentum: align(momentumVote),
  };
  const agreement =
    alignment.ema +
    alignment.rsi +
    alignment.macd +
    alignment.bollinger +
    alignment.momentum;

  return {
    ema9: ema9Val,
    ema21: ema21Val,
    rsi14: rsi14Val,
    macdHistogram,
    bollingerPosition,
    roc10: roc10Val,
    alignment,
    agreement,
  };
}

export interface AnalyzeInput {
  candles: CandleData[];
  levelBook: LevelBook;
  /** "HH:MM" 24h IST clock for the current scan tick. */
  nowIst: string;
  /**
   * Reference time in epoch-ms used by the staleness gate. Live mode omits
   * this — the strategy falls back to Date.now(). Backtest replays must
   * pass the replay-clock here (e.g. the bar's timestamp), otherwise the
   * staleness check would compare wall-clock against historical ticks and
   * bail every time.
   */
  nowMs?: number;
  /**
   * Pre-computed higher-timeframe trend bias. The strategy never recomputes
   * this internally — the caller (SignalGeneratorService) fetches the
   * higher-TF candles and runs ema9/ema21 on the closed bar. Null when the
   * working TF has no higher TF (1d) or when the higher TF couldn't be
   * computed (insufficient candles).
   */
  higherTimeframeTrend?: {
    tf: string;
    ema9: number;
    ema21: number;
    bias: 'bullish' | 'bearish' | 'neutral';
  } | null;
  /**
   * Daily regime classification produced by classifyRegime() in the service
   * layer. Optional — undefined is treated as 'normal' (no bias) so legacy
   * callers and unit fixtures keep working unchanged.
   */
  regime?: Regime;
  /**
   * Active strong/medium zones for this token. Pre-fetched by
   * SignalGeneratorService from ZoneRepository.findActiveByToken so the
   * strategy stays pure (no DB / detector calls here). Empty array when
   * no zones are loaded — TP1 falls back to the fixed 1×R default.
   */
  zones?: StrongZone[];
  /** Optional gate-trace callback for backtest harnesses. */
  debug?: (event: string, detail?: Record<string, unknown>) => void;
}

interface CandidateLevel {
  type: LevelType;
  value: number;
}

export class LevelsContextStrategy implements TradingStrategy {
  readonly name = 'levels-context';
  readonly description =
    'Intraday breakout/reversal scanner anchored on PDH/PDL/OR/VWAP/round-number levels with R:R + time-of-day + volume gates.';
  readonly supportedSegments = ['OPTIONS', 'EQUITY', 'FUTURES', 'COMMODITY'];
  readonly preferredTimeframes = ['15m', '1h'];

  private params: Record<string, unknown> = {
    rrFloor: RR_FLOOR_STRICT,
    distanceGateAtr: DISTANCE_GATE_ATR,
    volumeRatioMin: VOLUME_RATIO_MIN,
    // Live default is strict — only A/B grades go to the auto-trader.
    // Backtest harnesses can flip this to true to surface the ceiling
    // (what the strategy *would* trade if Grade C were allowed).
    includeGradeC: false,
    // When true, evaluate against candles[length-1] (the latest bar,
    // possibly in-progress). Used by existing unit tests that put the
    // trigger candle at the end of the array. Live + backtest paths
    // should leave this false so the strategy waits for the bar to
    // CLOSE before detecting volume / pattern.
    evaluateOnLastBar: false,
  };

  // The TradingStrategy interface forces `analyze(MarketSnapshot)`. The
  // scanner wraps a LevelBook lookup into MarketSnapshot.metadata so we
  // accept either shape.
  analyze(data: MarketSnapshot | AnalyzeInput): SignalOutput | null {
    const input: AnalyzeInput | null = this.unwrap(data);
    if (!input) return null;
    const { candles, levelBook, nowIst, nowMs, debug } = input;
    const higherTimeframeTrend = input.higherTimeframeTrend ?? null;
    const regime: Regime = input.regime ?? 'normal';
    // Diagnostic ratio echoed into setup metadata (intradayRange / atr14).
    const intradayRange = Math.max(0, levelBook.todayHigh - levelBook.todayLow);
    const intradayRangeRatio =
      levelBook.atr14 > 0 && intradayRange > 0 ? intradayRange / levelBook.atr14 : 0;

    if (candles.length < 25) { debug?.('reject:not-enough-candles'); return null; }
    if (this.isStale(levelBook, nowMs ?? Date.now())) { debug?.('reject:stale'); return null; }
    if (!this.inTradingWindow(nowIst, levelBook.exchange)) { debug?.('reject:outside-window', { nowIst, exchange: levelBook.exchange }); return null; }

    // Evaluate against the most-recent CLOSED bar (length-2), not the
    // in-progress one (length-1). candles[length-1] is typically a
    // partially-formed bar whose volume is incomplete and OHLC pattern
    // is still mutating, so using it produces false "low-volume"
    // rejections on otherwise-active breakouts. Closed bar gives:
    //   • Complete volume vs VMA20 (no premature confirmation reject)
    //   • Stable OHLC for pinbar/engulfing/breakout detection
    // Tests can opt back into evaluating-on-last-bar via setParameters
    // (their fixtures put the trigger at length-1).
    const useLastBar = this.params.evaluateOnLastBar === true;
    const triggerIdx = useLastBar ? candles.length - 1 : candles.length - 2;
    const last = candles[triggerIdx];
    if (!last) { debug?.('reject:no-trigger-bar'); return null; }
    const vmaWindow = useLastBar
      ? candles.slice(-21, -1) // 20 bars BEFORE last
      : candles.slice(-22, -2); // 20 bars BEFORE the closed bar
    const vma20 = this.vma(vmaWindow);
    const lastVolume = Number(last.volume) || 0;
    const volumeRatio = vma20 > 0 ? lastVolume / vma20 : 0;
    debug?.('in-window', { atr14: levelBook.atr14, volumeRatio, spot: levelBook.spot });

    const candidates = this.collectLevels(levelBook);
    // Track the closest distance-rejected level so the final rejection
    // message reports something actionable ("nearest level is PDH at
    // 295.9, you're 4.1 away") instead of whichever level happened to
    // be last in iteration. anyDistancePassed acts as a one-way switch:
    // if at least one level passed distance, we don't surface the
    // distance message at all (the more informative reject:confirmation
    // events from later iterations are better signal).
    const distGate = DISTANCE_GATE_ATR * levelBook.atr14;
    let closestRejected: { type: string; value: number; dist: number } | null = null;
    let anyDistancePassed = false;

    for (const lvl of candidates) {
      const dist = Math.abs(levelBook.spot - lvl.value);
      if (dist > distGate) {
        if (!anyDistancePassed && (!closestRejected || dist < closestRejected.dist)) {
          closestRejected = { type: lvl.type, value: lvl.value, dist };
        }
        continue;
      }
      anyDistancePassed = true;
      debug?.('pass:distance', { type: lvl.type, value: lvl.value });

      const reversal = this.detectReversal(last, lvl, levelBook.atr14);
      const breakout = !reversal && this.detectBreakout(last, lvl, levelBook.atr14, volumeRatio, levelBook.spot);
      if (!breakout && !reversal) { debug?.('reject:confirmation', { type: lvl.type, volumeRatio }); continue; }
      debug?.('pass:confirmation', { type: lvl.type, kind: breakout ? 'BREAKOUT' : 'REVERSAL' });

      const setupType: SetupType = breakout ? 'BREAKOUT' : 'REVERSAL';
      const isLong = this.directionFromSetup(setupType, last, lvl.value);
      const slTarget = this.computeSlAndTarget({
        setupType, isLong, level: lvl.value, atr: levelBook.atr14,
        levelBook, candidates, triggerCandle: last,
        zones: input.zones ?? [],
      });
      if (!slTarget) continue;

      const rr =
        Math.abs(slTarget.target - slTarget.entry) /
        Math.max(Math.abs(slTarget.entry - slTarget.stoploss), 1e-6);
      if (rr < (this.params.rrFloor as number)) { debug?.('reject:rr', { rr }); continue; }
      debug?.('pass:rr', { rr });

      // Regime gate — counter-regime setups (REVERSAL on trending day,
      // BREAKOUT on choppy day) historically lose; reject outright instead
      // of merely demoting in gradeSetup.
      const regimeMismatch =
        (regime === 'trending' && setupType === 'REVERSAL') ||
        (regime === 'choppy' && setupType === 'BREAKOUT');
      if (regimeMismatch) {
        debug?.('reject:regime-mismatch', {
          regime, setupType, intradayRangeRatio,
        });
        continue;
      }

      // Multi-timeframe trend filter — last gate before grading. Runs only
      // on pre-computed higher-TF bias (see AnalyzeInput.higherTimeframeTrend).
      // Strategy stays pure: no DB / broker calls here.
      if (higherTimeframeTrend && higherTimeframeTrend.bias !== 'neutral') {
        const conflict =
          (isLong && higherTimeframeTrend.bias === 'bearish') ||
          (!isLong && higherTimeframeTrend.bias === 'bullish');
        if (conflict) {
          debug?.('reject:mtf-conflict', {
            tf: higherTimeframeTrend.tf,
            bias: higherTimeframeTrend.bias,
            side: isLong ? 'BUY' : 'SELL',
          });
          continue;
        }
      }

      const indicators = this.computeIndicators(candles, levelBook.spot, isLong);
      debug?.('pass:indicators', { agreement: indicators.agreement });

      const grade = this.gradeSetup({
        candidates, level: lvl, atr: levelBook.atr14,
        volumeRatio, nowIst, agreement: indicators.agreement,
        exchange: levelBook.exchange,
        regime, setupType,
      });
      if (grade === 'C' && !this.params.includeGradeC) {
        debug?.('reject:grade-c', { volumeRatio, agreement: indicators.agreement });
        continue;
      }
      debug?.('pass:grade', { grade, agreement: indicators.agreement });

      // Coarse classification. Anything before 12:00 IST is "morning"
      // session-feel, after is "afternoon-trend". MCX evening (15:30+)
      // also reads as afternoon — closest semantic for now.
      const window: TimeOfDayWindow =
        nowIst < '12:00' ? 'morning-trend' : 'afternoon-trend';

      const setupContext: SetupContext = {
        levelType: lvl.type,
        setupType,
        levelValue: lvl.value,
        grade,
        entry: slTarget.entry,
        stoploss: slTarget.stoploss,
        target: slTarget.target,
        partialTakeAt: slTarget.partialTakeAt,
        triggerCandle: {
          time: Math.floor(last.timestamp.getTime() / 1000),
          ohlc: [last.open, last.high, last.low, last.close],
        },
        levelBookSnapshot: {
          pdh: levelBook.pdh, pdl: levelBook.pdl,
          orh: levelBook.orh, orl: levelBook.orl,
          vwap: levelBook.vwap,
          todayHigh: levelBook.todayHigh, todayLow: levelBook.todayLow,
        },
        atr14: levelBook.atr14,
        volumeRatio,
        timeOfDayWindow: window,
        indicators,
        higherTimeframeTrend,
        regime,
        intradayRangeRatio,
        tp1Source: slTarget.tp1Source,
        tp1Obstacle: slTarget.tp1Obstacle,
      };

      const reason = this.buildReason(setupContext, levelBook);

      return {
        symbol: levelBook.symbol,
        exchange: levelBook.exchange,
        side: isLong ? 'BUY' : 'SELL',
        entryPrice: slTarget.entry,
        targetPrice: slTarget.target,
        stoplossPrice: slTarget.stoploss,
        confidence: Math.round(rr * 25), // crude 0-100 from R:R
        reason,
        timeframe: '5m',
        metadata: setupContext,
      };
    }

    // No level produced a tradeable setup. Surface the closest
    // distance-rejected level only if NONE of the levels passed
    // distance — otherwise the reject:confirmation events are the
    // more informative signal.
    if (!anyDistancePassed && closestRejected) {
      debug?.('reject:distance', {
        type: closestRejected.type,
        value: closestRejected.value,
        dist: closestRejected.dist,
        gate: distGate,
      });
    }
    return null;
  }

  backtest(_input: BacktestInput): BacktestResult {
    // Backtesting is implemented in scripts/backtest-levels-context.mjs
    // which calls analyze() directly with replayed candle/level-book inputs.
    // The TradingStrategy interface requires this method — we throw to
    // signal callers to use the dedicated harness instead.
    throw new Error(
      'LevelsContextStrategy: use scripts/backtest-levels-context.mjs for backtesting.',
    );
  }

  getParameters(): Record<string, unknown> {
    return { ...this.params };
  }

  setParameters(params: Record<string, unknown>): void {
    this.params = { ...this.params, ...params };
  }

  // ─────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────

  private unwrap(data: MarketSnapshot | AnalyzeInput): AnalyzeInput | null {
    if ('levelBook' in data && 'nowIst' in data) {
      return data as AnalyzeInput;
    }
    const snapshot = data as MarketSnapshot;
    const meta = (snapshot as unknown as { metadata?: AnalyzeInput }).metadata;
    if (!meta || !meta.levelBook || !meta.nowIst) return null;
    return {
      candles: snapshot.candles,
      levelBook: meta.levelBook,
      nowIst: meta.nowIst,
      higherTimeframeTrend: meta.higherTimeframeTrend ?? null,
      regime: meta.regime,
      zones: meta.zones ?? [],
    };
  }

  private isStale(book: LevelBook, nowMs: number): boolean {
    return nowMs - book.lastTickAt.getTime() > STALE_TICK_MS;
  }

  private inTradingWindow(nowIst: string, exchange: string): boolean {
    const close = exchange === 'MCX' ? SESSION_CLOSE_MCX : SESSION_CLOSE_NSE;
    return this.between(nowIst, SESSION_OPEN, close);
  }

  private between(hhmm: string, lo: string, hi: string): boolean {
    return hhmm >= lo && hhmm <= hi;
  }

  private collectLevels(book: LevelBook): CandidateLevel[] {
    const out: CandidateLevel[] = [
      { type: 'PDH', value: book.pdh },
      { type: 'PDL', value: book.pdl },
      { type: 'VWAP', value: book.vwap },
    ];
    if (book.orh !== null) out.push({ type: 'ORH', value: book.orh });
    if (book.orl !== null) out.push({ type: 'ORL', value: book.orl });
    for (const r of book.roundNumbers) out.push({ type: 'ROUND', value: r });
    if (book.topVolStrikes) {
      for (const s of book.topVolStrikes) out.push({ type: 'VOL_STRIKE', value: s });
    }
    return out.filter((l) => Number.isFinite(l.value) && l.value > 0);
  }

  private detectBreakout(
    candle: CandleData,
    level: CandidateLevel,
    atr: number,
    volumeRatio: number,
    spot: number,
  ): boolean {
    if (Math.abs(spot - level.value) < 0.01) return false; // spot AT the level is not a breakout
    if (volumeRatio < VOLUME_RATIO_MIN) return false;
    const buffer = BREAKOUT_BODY_ATR * atr;
    const above = candle.close > level.value + buffer;
    const below = candle.close < level.value - buffer;
    if (!above && !below) return false;

    // Wick-quality gate: close must be near the breakout-side extreme of
    // the bar. A long upper wick on a "BUY breakout" candle (close near
    // the low of the bar) is a fakeout, not a real break — reject it.
    const range = candle.high - candle.low;
    if (range <= 0) return false;
    if (above) {
      const upperWick = candle.high - candle.close;
      if (upperWick / range >= BREAKOUT_WICK_MAX_RATIO) return false;
    } else {
      const lowerWick = candle.close - candle.low;
      if (lowerWick / range >= BREAKOUT_WICK_MAX_RATIO) return false;
    }
    return true;
  }

  private detectReversal(candle: CandleData, level: CandidateLevel, atr: number): boolean {
    const range = candle.high - candle.low;
    if (range <= 0) return false;
    const body = Math.abs(candle.close - candle.open);
    if (body / range > PINBAR_BODY_PCT) return false;

    // upper wick into a level above current (resistance rejection)
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const tagsLevelFromBelow = candle.high >= level.value && candle.close < level.value;
    const tagsLevelFromAbove = candle.low <= level.value && candle.close > level.value;
    if (tagsLevelFromBelow && upperWick / range > 0.5) return true;
    if (tagsLevelFromAbove && lowerWick / range > 0.5) return true;
    return false;
  }

  private directionFromSetup(
    setup: SetupType,
    last: CandleData,
    level: number,
  ): boolean {
    if (setup === 'BREAKOUT') return last.close > level;
    // REVERSAL: rejection at resistance (close < level) → SELL; bounce at support (close > level) → BUY
    return last.close > level;
  }

  private computeSlAndTarget(args: {
    setupType: SetupType;
    isLong: boolean;
    level: number;
    atr: number;
    levelBook: LevelBook;
    candidates: CandidateLevel[];
    triggerCandle: CandleData;
    zones?: StrongZone[];
  }): {
    entry: number;
    stoploss: number;
    target: number;
    partialTakeAt: number;
    tp1Source: 'obstacle' | 'fixed';
    tp1Obstacle: { classification: 'STRONG' | 'MEDIUM'; touchCount: number; nearEdge: number } | null;
  } | null {
    const { setupType, isLong, level, atr, candidates, triggerCandle, zones = [] } = args;
    const buffer = SL_BUFFER_ATR * atr;

    let entry: number;
    if (setupType === 'BREAKOUT') {
      const trigger = BREAKOUT_BODY_ATR * atr;
      entry = isLong ? level + trigger : level - trigger;
    } else {
      entry = triggerCandle.close;
    }

    const stoploss = isLong ? level - buffer : level + buffer;
    const slDist = Math.abs(entry - stoploss);
    if (slDist <= 0) return null;
    const minTargetDist = 2 * slDist;

    const opposing = candidates
      .filter((c) => (isLong ? c.value > entry : c.value < entry))
      .sort((a, b) => Math.abs(a.value - entry) - Math.abs(b.value - entry));
    const target =
      opposing.length > 0 && Math.abs(opposing[0].value - entry) >= minTargetDist
        ? opposing[0].value
        : (isLong ? entry + minTargetDist : entry - minTargetDist);

    const defaultTp1 = isLong ? entry + slDist : entry - slDist;

    // Obstacle-aware TP1. See docs/superpowers/specs/2026-05-05-tp1-at-obstacle-design.md §Algorithm.
    const TP1_OBSTACLE_BUFFER_ATR = 0.1;
    const MIN_TP1_R = 0.4;
    const obstacleBuffer = TP1_OBSTACLE_BUFFER_ATR * atr;

    const obstacleCandidates = zones
      .filter((z) =>
        (z.classification === 'STRONG' || z.classification === 'MEDIUM') &&
        z.touchCount >= 3,
      )
      .map((z) => ({
        classification: z.classification as 'STRONG' | 'MEDIUM',
        touchCount: z.touchCount,
        nearEdge: isLong ? z.lower : z.upper,
      }))
      .filter((z) =>
        isLong
          ? z.nearEdge > entry && z.nearEdge < target
          : z.nearEdge < entry && z.nearEdge > target,
      );

    const closest = isLong
      ? obstacleCandidates.reduce<typeof obstacleCandidates[number] | null>(
          (best, z) => (best === null || z.nearEdge < best.nearEdge ? z : best),
          null,
        )
      : obstacleCandidates.reduce<typeof obstacleCandidates[number] | null>(
          (best, z) => (best === null || z.nearEdge > best.nearEdge ? z : best),
          null,
        );

    let partialTakeAt = defaultTp1;
    let tp1Source: 'obstacle' | 'fixed' = 'fixed';
    let tp1Obstacle:
      | { classification: 'STRONG' | 'MEDIUM'; touchCount: number; nearEdge: number }
      | null = null;

    if (closest) {
      const rawObstacleTp1 = isLong
        ? closest.nearEdge - obstacleBuffer
        : closest.nearEdge + obstacleBuffer;
      const clampedTp1 = isLong
        ? Math.min(rawObstacleTp1, target - 1e-6)
        : Math.max(rawObstacleTp1, target + 1e-6);
      const obstacleR = Math.abs(clampedTp1 - entry) / slDist;
      if (obstacleR >= MIN_TP1_R) {
        partialTakeAt = clampedTp1;
        tp1Source = 'obstacle';
        tp1Obstacle = {
          classification: closest.classification,
          touchCount: closest.touchCount,
          nearEdge: closest.nearEdge,
        };
      }
    }

    return { entry, stoploss, target, partialTakeAt, tp1Source, tp1Obstacle };
  }

  private gradeSetup(args: {
    candidates: CandidateLevel[];
    level: CandidateLevel;
    atr: number;
    volumeRatio: number;
    nowIst: string;
    agreement: number;
    exchange: string;
    regime: Regime;
    setupType: SetupType;
  }): SetupGrade {
    const { candidates, level, atr, volumeRatio, nowIst, agreement, exchange, regime, setupType } = args;
    const confluence = candidates.filter(
      (c) =>
        c !== level && Math.abs(c.value - level.value) <= CONFLUENCE_RADIUS_ATR * atr,
    ).length;
    // Prime A-grade window: highest-quality post-open (after the settle)
    // and pre-close commit. NSE: 09:45-10:30 + 14:45-15:15.
    // MCX: 09:15-10:00 + 14:45-15:15 (same afternoon).
    const primeMorningStart = exchange === 'MCX' ? PRIME_MORNING_START_MCX : PRIME_MORNING_START_NSE;
    const primeMorningEnd = exchange === 'MCX' ? PRIME_MORNING_END_MCX : PRIME_MORNING_END_NSE;
    const primeWindow =
      this.between(nowIst, primeMorningStart, primeMorningEnd) ||
      this.between(nowIst, PRIME_AFTERNOON_START, PRIME_AFTERNOON_END);
    let base: SetupGrade;
    if (confluence >= 1 && volumeRatio >= VOLUME_RATIO_GRADE_A && primeWindow) base = 'A';
    else if (volumeRatio >= VOLUME_RATIO_MIN) base = 'B';
    else base = 'C';

    // Indicator-confluence adjustment: strong agreement (≥4) bumps up one
    // tier; meaningful opposition (≤-2) bumps down one tier; otherwise the
    // base grade stands.
    let postIndicator: SetupGrade = base;
    if (agreement >= 4) {
      if (base === 'B') postIndicator = 'A';
      else if (base === 'C') postIndicator = 'B';
      else postIndicator = 'A';
    } else if (agreement <= -2) {
      if (base === 'A') postIndicator = 'B';
      else if (base === 'B') postIndicator = 'C';
      else postIndicator = 'C';
    }

    // Regime bias — favors the matching setup type, bumps up one tier on
    // alignment. Mismatched setups are rejected upstream, so this branch
    // only applies the upgrade case here.
    const regimeFavoursSetup =
      (regime === 'trending' && setupType === 'BREAKOUT') ||
      (regime === 'choppy' && setupType === 'REVERSAL');
    if (regimeFavoursSetup) {
      if (postIndicator === 'C') return 'B';
      if (postIndicator === 'B') return 'A';
      return 'A';
    }
    return postIndicator;
  }

  private computeIndicators(
    candles: CandleData[],
    spot: number,
    isLong: boolean,
  ): IndicatorReadings {
    // Delegates to the module-level buildIndicatorReadings helper so the
    // standalone /signals/indicators endpoint and the setup pipeline both
    // run through one code path. Single source of truth — analyze()
    // continues to produce byte-identical IndicatorReadings.
    return buildIndicatorReadings(candles, spot, isLong);
  }

  private vma(candles: CandleData[]): number {
    if (candles.length === 0) return 0;
    // Median, not arithmetic mean. Some Indian-broker historical APIs
    // occasionally write a single-day cumulative volume into one bar
    // (artifacts of session-close reporting). One 50M-vol bar in a
    // 20-bar window can pull the mean up 1000x and make every
    // subsequent bar look like 0.001× "average". Median is robust
    // to those outliers without breaking the VMA semantics for the
    // 99% of bars that are clean. Coerce to Number defensively in
    // case any candle still carries bigint volume.
    const vols = candles
      .map((c) => Number(c.volume))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    if (vols.length === 0) return 0;
    const mid = Math.floor(vols.length / 2);
    return vols.length % 2 === 0 ? (vols[mid - 1] + vols[mid]) / 2 : vols[mid];
  }

  private buildReason(ctx: SetupContext, book: LevelBook): string {
    const dir = ctx.setupType === 'BREAKOUT' ? 'broke' : 'rejected';
    return `${book.symbol} ${dir} ${ctx.levelType} (${ctx.levelValue}). Volume ${ctx.volumeRatio.toFixed(2)}× VMA20. SL ${ctx.stoploss.toFixed(2)}, target ${ctx.target.toFixed(2)}, R:R ${(Math.abs(ctx.target - ctx.entry) / Math.abs(ctx.entry - ctx.stoploss)).toFixed(2)}. Grade ${ctx.grade}.`;
  }
}
