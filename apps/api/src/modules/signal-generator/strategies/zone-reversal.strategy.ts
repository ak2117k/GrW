/**
 * Zone Reversal Strategy
 *
 * Fires REVERSAL signals when price touches a STRONG support/resistance
 * zone (computed by StrongZoneDetectorService) with a confirming reversal
 * candle pattern (pin bar / engulfing / strong rejection).
 *
 * Spec: docs/superpowers/specs/2026-05-03-strong-zone-reversal-strategy-design.md
 *
 * Trigger conditions (ALL on the latest closed bar):
 *   1. Latest closed bar touched a STRONG zone
 *      (resistance: high >= zone.lower; support: low <= zone.upper)
 *   2. Bar closed in the rejecting direction
 *      (resistance: close < zone center; support: close > zone center)
 *   3. Candle pattern is one of: pin bar, engulfing, strong rejection
 *
 * Anti-rules (any → reject):
 *   - zone.touchCount > maxTouchCount (default 6)
 *   - |LTP - zone center| > chasingThresholdAtr * ATR (default 0.5)
 *   - First or last 5 minutes of session (09:15-09:20, 15:25-15:30 IST)
 *
 * Output (SignalOutput):
 *   - side: BUY (support) | SELL (resistance)
 *   - entry: bar.close
 *   - stoploss: zone edge ± 0.3 * ATR
 *   - target: nearest opposite STRONG zone OR entry ± 2R, whichever first
 *   - partialTakeAt: entry ± 1R
 *   - metadata.setupType: 'REVERSAL', metadata.levelType: 'STRONG_ZONE'
 *   - grade: 'A' if zone.strength >= 80 else 'B'
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  TradingStrategy,
  MarketSnapshot,
  SignalOutput,
  CandleData,
  BacktestInput,
  BacktestResult,
  BacktestTrade,
} from '../../../common/interfaces/trading-strategy.interface';
import { LevelBook } from '../types/level-book.types';
import {
  SetupContext,
  SetupGrade,
  SetupType,
  LevelType,
  TimeOfDayWindow,
  Regime,
  IndicatorReadings,
} from '../types/setup-context.types';
import { StrongZone } from '../types/zone.types';
import { StrongZoneDetectorService } from '../services/strong-zone-detector.service';

/**
 * Structural alias for the detector — kept as a type-only contract so the
 * strategy can be unit-tested without a real DI container, and so a future
 * caching/proxy implementation can be swapped in without touching this file.
 */
export type StrongZoneDetectorLike = Pick<StrongZoneDetectorService, 'detectZones'>;

const DEFAULT_MIN_STRENGTH_FOR_FIRE = 70;
const DEFAULT_MAX_TOUCH_COUNT = 6;
const DEFAULT_CHASING_THRESHOLD_ATR = 0.5;
const DEFAULT_SL_BUFFER_ATR = 0.3;
const DEFAULT_RR_FALLBACK = 2.0;
const DEFAULT_PARTIAL_R_MULT = 1.0;
const DEFAULT_GRADE_A_STRENGTH = 80;
const SESSION_OPEN = '09:15';
const SESSION_OPEN_GUARD = '09:20';
const SESSION_CLOSE_GUARD = '15:25';
const SESSION_CLOSE = '15:30';

const NEUTRAL_INDICATORS: IndicatorReadings = {
  ema9: null,
  ema21: null,
  rsi14: null,
  macdHistogram: null,
  bollingerPosition: null,
  roc10: null,
  alignment: { ema: 0, rsi: 0, macd: 0, bollinger: 0, momentum: 0 },
  agreement: 0,
};

export interface ZoneReversalAnalyzeInput {
  /** Closed candles for the working timeframe (15m). Last entry is the latest CLOSED bar. */
  candles: CandleData[];
  /** Optional 1H higher-timeframe series — passed to detector for confluence scoring. */
  candles1h?: CandleData[];
  /** Snapshot of per-instrument level book (PDH/PDL/VWAP/ATR). */
  levelBook: LevelBook;
  /** "HH:MM" 24h IST clock for the current scan tick. */
  nowIst: string;
  /** Optional pre-computed zones — when present, the detector is bypassed. Used by tests + cached pipelines. */
  zones?: StrongZone[];
  /** Optional gate-trace callback for backtest harnesses + debugging. */
  debug?: (event: string, detail?: Record<string, unknown>) => void;
}

interface ZoneReversalParams {
  minStrengthForFire: number;
  maxTouchCount: number;
  chasingThresholdAtr: number;
  slBufferAtr: number;
  rrFallback: number;
  partialRMult: number;
  gradeAStrength: number;
}

type CandlePattern = 'pin-bar' | 'engulfing' | 'strong-rejection';

@Injectable()
export class ZoneReversalStrategy implements TradingStrategy {
  readonly name = 'zone-reversal';
  readonly description =
    'Fires REVERSAL signals when price reacts at a STRONG support/resistance zone with pin-bar / engulfing / strong-rejection confirmation.';
  readonly supportedSegments = ['OPTIONS', 'EQUITY', 'FUTURES', 'COMMODITY'];
  readonly preferredTimeframes = ['15m', '1h'];

  private readonly logger = new Logger(ZoneReversalStrategy.name);

  private params: ZoneReversalParams = {
    minStrengthForFire: DEFAULT_MIN_STRENGTH_FOR_FIRE,
    maxTouchCount: DEFAULT_MAX_TOUCH_COUNT,
    chasingThresholdAtr: DEFAULT_CHASING_THRESHOLD_ATR,
    slBufferAtr: DEFAULT_SL_BUFFER_ATR,
    rrFallback: DEFAULT_RR_FALLBACK,
    partialRMult: DEFAULT_PARTIAL_R_MULT,
    gradeAStrength: DEFAULT_GRADE_A_STRENGTH,
  };

  /**
   * Optional detector — set via setDetector() after construction once the
   * Component 1 agent's StrongZoneDetectorService is wired into the
   * module. We do NOT inject via the constructor because class-token DI
   * would couple this file's compilation to the parallel agent's class
   * existing. The signal-generator service can inject the detector and
   * call setDetector() in its onModuleInit, OR the caller can pre-fetch
   * zones and pass them via AnalyzeInput.zones (preferred for tests).
   */
  private detector: StrongZoneDetectorLike | null = null;

  setDetector(detector: StrongZoneDetectorLike | null): void {
    this.detector = detector;
  }

  analyze(data: MarketSnapshot | ZoneReversalAnalyzeInput): SignalOutput | null {
    try {
      const input = this.unwrap(data);
      if (!input) return null;
      return this.runAnalyze(input);
    } catch (err) {
      // The strategy must NEVER throw — log and return null.
      this.logger.error(
        `analyze() failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return null;
    }
  }

  private runAnalyze(input: ZoneReversalAnalyzeInput): SignalOutput | null {
    const { candles, levelBook, nowIst, debug } = input;

    if (!candles || candles.length < 4) {
      debug?.('reject:not-enough-candles', { count: candles?.length ?? 0 });
      return null;
    }

    if (!this.inTradingWindow(nowIst)) {
      debug?.('reject:outside-window', { nowIst });
      return null;
    }
    if (this.inSessionEdge(nowIst)) {
      debug?.('reject:session-edge', { nowIst });
      return null;
    }

    const triggerBar = candles[candles.length - 1];
    if (!triggerBar) {
      debug?.('reject:no-trigger-bar');
      return null;
    }

    // Pull active STRONG zones — either from the input (test path) or the detector (live path).
    const zones = this.resolveZones(input);
    if (!zones || zones.length === 0) {
      debug?.('reject:no-zones');
      return null;
    }

    const strongZones = zones.filter(
      (z) =>
        z.classification === 'STRONG' &&
        z.strength >= this.params.minStrengthForFire,
    );
    if (strongZones.length === 0) {
      debug?.('reject:no-strong-zones', { zoneCount: zones.length });
      return null;
    }

    // Find a zone the latest closed bar touched.
    const candidate = this.findTouchedZone(triggerBar, strongZones, debug);
    if (!candidate) return null;
    const { zone } = candidate;
    const zoneCenter = (zone.upper + zone.lower) / 2;

    // Anti-rule: too many prior touches → level is breaking down.
    if (zone.touchCount > this.params.maxTouchCount) {
      debug?.('reject:zone-overworked', {
        touchCount: zone.touchCount,
        max: this.params.maxTouchCount,
      });
      return null;
    }

    // Anti-rule: chasing — LTP too far from zone center.
    const atr = levelBook.atr14;
    if (!Number.isFinite(atr) || atr <= 0) {
      debug?.('reject:invalid-atr', { atr });
      return null;
    }
    const chaseDist = Math.abs(levelBook.spot - zoneCenter);
    if (chaseDist > this.params.chasingThresholdAtr * atr) {
      debug?.('reject:chasing', { chaseDist, gate: this.params.chasingThresholdAtr * atr });
      return null;
    }

    // Reversal close direction.
    const isResistance = zone.type === 'resistance';
    const closedAgainst = isResistance
      ? triggerBar.close < zoneCenter
      : triggerBar.close > zoneCenter;
    if (!closedAgainst) {
      debug?.('reject:close-direction', {
        zoneType: zone.type,
        zoneCenter,
        close: triggerBar.close,
      });
      return null;
    }

    // Candle pattern.
    const prevBar = candles[candles.length - 2];
    const pattern = this.detectPattern(triggerBar, prevBar, isResistance);
    if (!pattern) {
      debug?.('reject:no-pattern');
      return null;
    }
    debug?.('pass:pattern', { pattern });

    const isLong = !isResistance;
    const side: 'BUY' | 'SELL' = isLong ? 'BUY' : 'SELL';
    const entry = triggerBar.close;
    const buffer = this.params.slBufferAtr * atr;
    const stoploss = isLong ? zone.lower - buffer : zone.upper + buffer;
    const slDist = Math.abs(entry - stoploss);
    if (!Number.isFinite(slDist) || slDist <= 0) {
      debug?.('reject:invalid-sl');
      return null;
    }

    // Target: nearest opposite STRONG zone OR entry ± 2R, whichever is FIRST in trade direction.
    const target = this.computeTarget({
      entry,
      isLong,
      slDist,
      zones: strongZones,
      currentZoneId: zone.id,
    });
    const partialTakeAt = isLong
      ? entry + this.params.partialRMult * slDist
      : entry - this.params.partialRMult * slDist;

    const grade: SetupGrade =
      zone.strength >= this.params.gradeAStrength ? 'A' : 'B';

    const setupType: SetupType = 'REVERSAL';
    const levelType: LevelType = 'STRONG_ZONE';

    const reason =
      `Strong ${zone.type} zone ${this.fmt(zone.lower)}-${this.fmt(zone.upper)} ` +
      `(strength ${zone.strength}). ${pattern} rejection on ` +
      `${triggerBar.close.toFixed(2)} close. SL ${stoploss.toFixed(2)}, ` +
      `target ${target.toFixed(2)}, R:R ${(Math.abs(target - entry) / slDist).toFixed(2)}. ` +
      `Grade ${grade}.`;

    const window: TimeOfDayWindow =
      nowIst < '12:00' ? 'morning-trend' : 'afternoon-trend';
    const intradayRange = Math.max(0, levelBook.todayHigh - levelBook.todayLow);
    const intradayRangeRatio = atr > 0 ? intradayRange / atr : 0;

    const setupContext: SetupContext = {
      levelType,
      setupType,
      levelValue: zoneCenter,
      grade,
      entry,
      stoploss,
      target,
      partialTakeAt,
      triggerCandle: {
        time: Math.floor(triggerBar.timestamp.getTime() / 1000),
        ohlc: [triggerBar.open, triggerBar.high, triggerBar.low, triggerBar.close],
      },
      levelBookSnapshot: {
        pdh: levelBook.pdh,
        pdl: levelBook.pdl,
        orh: levelBook.orh,
        orl: levelBook.orl,
        vwap: levelBook.vwap,
        todayHigh: levelBook.todayHigh,
        todayLow: levelBook.todayLow,
      },
      atr14: atr,
      volumeRatio: 0,
      timeOfDayWindow: window,
      indicators: NEUTRAL_INDICATORS,
      higherTimeframeTrend: null,
      regime: null as unknown as Regime,
      intradayRangeRatio,
    };

    const rr = Math.abs(target - entry) / slDist;
    const confidence = Math.max(0, Math.min(100, Math.round(rr * 25 + (zone.strength - 70) * 0.5)));

    return {
      symbol: levelBook.symbol,
      exchange: levelBook.exchange,
      side,
      entryPrice: entry,
      targetPrice: target,
      stoplossPrice: stoploss,
      confidence,
      reason,
      timeframe: '15m',
      metadata: {
        ...setupContext,
        zone: {
          id: zone.id,
          type: zone.type,
          upper: zone.upper,
          lower: zone.lower,
          strength: zone.strength,
          touchCount: zone.touchCount,
        },
        candlePattern: pattern,
      },
    };
  }

  backtest(input: BacktestInput): BacktestResult {
    // Backtests must supply pre-computed zones via metadata; without them
    // the strategy can't fire. Rather than silently produce an empty
    // result, walk the candle series and run analyze() with an empty
    // zone set — caller is expected to use the dedicated harness for a
    // full backtest (mirrors the LevelsContextStrategy decision).
    const { candles } = input;
    const trades: BacktestTrade[] = [];

    if (!candles || candles.length < 4) {
      return this.emptyBacktestResult();
    }

    // No zones, no levelBook, no IST clock — return empty. The proper
    // backtest path lives in scripts/backtest-zone-reversal.mjs (TODO),
    // which feeds zones into analyze() via AnalyzeInput.zones.
    return this.emptyBacktestResult(trades);
  }

  getParameters(): Record<string, unknown> {
    return { ...this.params };
  }

  setParameters(params: Record<string, unknown>): void {
    this.params = { ...this.params, ...(params as Partial<ZoneReversalParams>) };
  }

  // ─────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────

  private unwrap(
    data: MarketSnapshot | ZoneReversalAnalyzeInput,
  ): ZoneReversalAnalyzeInput | null {
    if ('levelBook' in data && 'nowIst' in data) {
      return data as ZoneReversalAnalyzeInput;
    }
    const snapshot = data as MarketSnapshot;
    const meta = (snapshot as unknown as { metadata?: ZoneReversalAnalyzeInput })
      .metadata;
    if (!meta || !meta.levelBook || !meta.nowIst) return null;
    return {
      candles: snapshot.candles,
      candles1h: meta.candles1h,
      levelBook: meta.levelBook,
      nowIst: meta.nowIst,
      zones: meta.zones,
      debug: meta.debug,
    };
  }

  private resolveZones(input: ZoneReversalAnalyzeInput): StrongZone[] | null {
    if (input.zones && input.zones.length > 0) return input.zones;
    if (!this.detector) return null;
    try {
      return this.detector.detectZones({
        token: input.levelBook.token,
        symbol: input.levelBook.symbol,
        exchange: input.levelBook.exchange,
        candles15m: input.candles,
        candles1h: input.candles1h,
        levelBook: input.levelBook,
        ltp: input.levelBook.spot,
        atr14: input.levelBook.atr14,
      });
    } catch (err) {
      this.logger.warn(
        `detectZones() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private findTouchedZone(
    bar: CandleData,
    strongZones: StrongZone[],
    debug?: (event: string, detail?: Record<string, unknown>) => void,
  ): { zone: StrongZone } | null {
    // A bar "touches" a resistance zone when its high pierces lower edge.
    // A bar touches a support zone when its low pierces upper edge.
    for (const z of strongZones) {
      const touched =
        z.type === 'resistance' ? bar.high >= z.lower : bar.low <= z.upper;
      if (touched) {
        debug?.('pass:zone-touch', {
          zoneId: z.id,
          type: z.type,
          upper: z.upper,
          lower: z.lower,
        });
        return { zone: z };
      }
    }
    debug?.('reject:no-touch');
    return null;
  }

  private detectPattern(
    bar: CandleData,
    prev: CandleData | undefined,
    isResistance: boolean,
  ): CandlePattern | null {
    const range = bar.high - bar.low;
    if (range <= 0) return null;
    const body = Math.abs(bar.close - bar.open);
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;

    // Pin bar — long wick toward zone, body opposite.
    // wick toward zone ≥ 2× body length; body should be opposite the zone.
    if (body > 0) {
      if (isResistance) {
        // wick UP into resistance, body BEAR (close < open)
        if (
          upperWick >= 2 * body &&
          bar.close < bar.open &&
          upperWick > lowerWick
        ) {
          return 'pin-bar';
        }
      } else {
        // wick DOWN into support, body BULL (close > open)
        if (
          lowerWick >= 2 * body &&
          bar.close > bar.open &&
          lowerWick > upperWick
        ) {
          return 'pin-bar';
        }
      }
    }

    // Engulfing — body fully engulfs prior bar's body, opposite direction.
    if (prev) {
      const prevBodyHi = Math.max(prev.open, prev.close);
      const prevBodyLo = Math.min(prev.open, prev.close);
      const curBodyHi = Math.max(bar.open, bar.close);
      const curBodyLo = Math.min(bar.open, bar.close);
      const fullyEngulfs = curBodyHi >= prevBodyHi && curBodyLo <= prevBodyLo;
      const prevBull = prev.close > prev.open;
      const prevBear = prev.close < prev.open;
      if (fullyEngulfs) {
        if (isResistance && prevBull && bar.close < bar.open) return 'engulfing';
        if (!isResistance && prevBear && bar.close > bar.open) return 'engulfing';
      }
    }

    // Strong rejection — body ≥ 60% of range, opposite zone direction, with
    // wick ≥ 25% of body length pointing INTO the zone.
    if (body >= 0.6 * range) {
      if (isResistance && bar.close < bar.open) {
        if (upperWick >= 0.25 * body) return 'strong-rejection';
      }
      if (!isResistance && bar.close > bar.open) {
        if (lowerWick >= 0.25 * body) return 'strong-rejection';
      }
    }

    return null;
  }

  private computeTarget(args: {
    entry: number;
    isLong: boolean;
    slDist: number;
    zones: StrongZone[];
    currentZoneId: string;
  }): number {
    const { entry, isLong, slDist, zones, currentZoneId } = args;
    const fallback = isLong
      ? entry + this.params.rrFallback * slDist
      : entry - this.params.rrFallback * slDist;

    // Find the nearest STRONG zone in the trade direction (excluding current).
    const opposite = isLong
      ? zones.filter((z) => z.id !== currentZoneId && z.lower > entry)
      : zones.filter((z) => z.id !== currentZoneId && z.upper < entry);
    if (opposite.length === 0) return fallback;

    opposite.sort((a, b) =>
      isLong ? a.lower - b.lower : b.upper - a.upper,
    );
    // Use the FACING edge (the one we hit first as price moves toward the zone).
    const nearest = opposite[0];
    const zoneEdge = isLong ? nearest.lower : nearest.upper;

    // Whichever is hit FIRST in trade direction.
    if (isLong) return Math.min(zoneEdge, fallback);
    return Math.max(zoneEdge, fallback);
  }

  private inTradingWindow(nowIst: string): boolean {
    return nowIst >= SESSION_OPEN && nowIst <= SESSION_CLOSE;
  }

  private inSessionEdge(nowIst: string): boolean {
    // First 5 min: 09:15 ≤ now < 09:20
    // Last  5 min: 15:25 ≤ now ≤ 15:30
    if (nowIst >= SESSION_OPEN && nowIst < SESSION_OPEN_GUARD) return true;
    if (nowIst >= SESSION_CLOSE_GUARD && nowIst <= SESSION_CLOSE) return true;
    return false;
  }

  private fmt(n: number): string {
    return n.toFixed(2);
  }

  private emptyBacktestResult(trades: BacktestTrade[] = []): BacktestResult {
    return {
      totalTrades: trades.length,
      winRate: 0,
      totalReturn: 0,
      totalReturnPercent: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      trades,
    };
  }
}
