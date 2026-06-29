/**
 * Anand Sniper + V25 Combined Strategy
 *
 * Port of two Pine Script indicators combined into a single rule. Evaluates
 * three conditions per 15m bar close and only fires when ALL three align:
 *
 *  1. V25 Hub alignment — 14 boolean indicators computed across 4 timeframes
 *     (1m / 5m / 15m / 60m) giving a 56-cell MTF consensus grid. Bullish
 *     alignment requires green_count / 56 >= 0.75 (bearish mirrored).
 *  2. Sniper bias — 7 bullish conditions on the 15m timeframe producing a
 *     bullPct / bearPct. Signal requires bullPct >= 80 (or bearPct >= 80).
 *  3. V25 win_prob — 5 indicators on the 1m timeframe producing a 0-100 win
 *     probability. BUY needs win_prob >= 80, SELL needs win_prob <= 20.
 *
 * Transition firing: only emits when the aligned direction changes from
 * the previously remembered state for the same symbol+exchange pair.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  TradingStrategy,
  MarketSnapshot,
  SignalOutput,
  BacktestInput,
  BacktestResult,
  BacktestTrade,
  CandleData,
} from '../../../common/interfaces/trading-strategy.interface';

interface AnandSniperV25Parameters {
  hubAlignmentThreshold: number; // 0.75 = 75%
  sniperPctThreshold: number; // 80
  winProbThreshold: number; // 80
  stoplossATRMultiplier: number; // 2.0
  targetATRMultiplier: number; // 4.0
  supertrendPeriod: number; // 10
  supertrendMultiplier: number; // 3
  macdFast: number; // 12
  macdSlow: number; // 26
  macdSignal: number; // 9
  rsiPeriod: number; // 14
  adxPeriod: number; // 14
  hullPeriod: number; // 20
  bbPeriod: number; // 20
  emaFast: number; // 9
  emaSlow: number; // 21
}

type Direction = 'BUY' | 'SELL' | null;

@Injectable()
export class AnandSniperV25CombinedStrategy implements TradingStrategy {
  readonly name = 'anand-sniper-v25-combined';
  readonly description =
    'Combined Sniper + V25 multi-timeframe consensus rule with transition firing';
  readonly supportedSegments = ['OPTIONS', 'EQUITY', 'FUTURES'];
  readonly preferredTimeframes = ['15m'];

  private readonly logger = new Logger(AnandSniperV25CombinedStrategy.name);

  /**
   * Remembers the last aligned direction per symbol+exchange. Used to emit
   * only on transitions (not every bar while the rule stays aligned).
   */
  private lastDirection: Map<string, Direction> = new Map();

  private params: AnandSniperV25Parameters = {
    hubAlignmentThreshold: 0.75,
    sniperPctThreshold: 80,
    winProbThreshold: 80,
    stoplossATRMultiplier: 2.0,
    targetATRMultiplier: 4.0,
    supertrendPeriod: 10,
    supertrendMultiplier: 3,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    rsiPeriod: 14,
    adxPeriod: 14,
    hullPeriod: 20,
    bbPeriod: 20,
    emaFast: 9,
    emaSlow: 21,
  };

  /**
   * Mark a (symbol, exchange) as having had a confirmed trade in `direction`.
   * Called by the universe scanner after the trade lands successfully —
   * blocks re-firing the same setup on subsequent ticks until the rule
   * disengages and re-aligns.
   */
  commitTransition(symbol: string, exchange: string, direction: 'BUY' | 'SELL'): void {
    this.lastDirection.set(`${symbol}:${exchange}`, direction);
  }

  /**
   * Clear the transition memory for a single symbol or all symbols.
   * Useful to manually un-stick the strategy after a downstream failure
   * stranded the state in a "won't fire" position.
   */
  resetTransition(symbol?: string, exchange?: string): void {
    if (symbol && exchange) {
      this.lastDirection.delete(`${symbol}:${exchange}`);
    } else {
      this.lastDirection.clear();
    }
  }

  /**
   * Diagnostic — runs the same evaluation as analyze() but returns the raw
   * metric breakdown regardless of whether the rule fires. Use this from a
   * UI or test endpoint to see WHY the rule didn't fire (which threshold
   * fell short). Does NOT mutate transition state, so it's safe to call
   * repeatedly without affecting the live signal generator.
   */
  evaluateConditions(data: MarketSnapshot): {
    ok: boolean;
    reason: string;
    hubGreen: number;
    hubRed: number;
    hubTotal: number;
    alignmentBullPct: number;
    alignmentBearPct: number;
    bullPct: number;
    bearPct: number;
    bScore: number;
    rScore: number;
    winProb: number;
    putProb: number;
    hubBullish: boolean;
    hubBearish: boolean;
    sniperBullOk: boolean;
    sniperBearOk: boolean;
    winProbBullOk: boolean;
    winProbBearOk: boolean;
    direction: Direction;
    thresholds: { hub: number; sniper: number; winProb: number };
  } {
    const { candles, mtfCandles, ltp } = data;
    const minCandles = 50;
    const empty = {
      ok: false,
      reason: '',
      hubGreen: 0,
      hubRed: 0,
      hubTotal: 0,
      alignmentBullPct: 0,
      alignmentBearPct: 0,
      bullPct: 0,
      bearPct: 0,
      bScore: 0,
      rScore: 0,
      winProb: 0,
      putProb: 0,
      hubBullish: false,
      hubBearish: false,
      sniperBullOk: false,
      sniperBearOk: false,
      winProbBullOk: false,
      winProbBearOk: false,
      direction: null as Direction,
      thresholds: {
        hub: this.params.hubAlignmentThreshold,
        sniper: this.params.sniperPctThreshold,
        winProb: this.params.winProbThreshold,
      },
    };
    if (!candles || candles.length < minCandles) {
      return { ...empty, reason: `15m candles ${candles?.length ?? 0} < ${minCandles}` };
    }
    if (ltp <= 0) {
      return { ...empty, reason: 'ltp <= 0' };
    }
    if (!mtfCandles || !mtfCandles['1m'] || !mtfCandles['5m'] || !mtfCandles['60m']) {
      return { ...empty, reason: 'mtfCandles missing 1m/5m/60m' };
    }
    const tf15 = mtfCandles['15m'] && mtfCandles['15m'].length >= minCandles ? mtfCandles['15m'] : candles;
    const tf1 = mtfCandles['1m'];
    const tf5 = mtfCandles['5m'];
    const tf60 = mtfCandles['60m'];
    if (tf1.length < minCandles || tf5.length < minCandles || tf60.length < minCandles) {
      return {
        ...empty,
        reason: `MTF insufficient (1m=${tf1.length}, 5m=${tf5.length}, 60m=${tf60.length})`,
      };
    }

    const cells1m = this.computeHubCells(tf1);
    const cells5m = this.computeHubCells(tf5);
    const cells15m = this.computeHubCells(tf15);
    const cells60m = this.computeHubCells(tf60);
    const allCells = [...cells1m, ...cells5m, ...cells15m, ...cells60m];
    const hubGreen = allCells.filter((c) => c === 1).length;
    const hubRed = allCells.length - hubGreen;
    const alignmentBullPct = hubGreen / allCells.length;
    const alignmentBearPct = hubRed / allCells.length;
    const hubBullish = alignmentBullPct >= this.params.hubAlignmentThreshold;
    const hubBearish = alignmentBearPct >= this.params.hubAlignmentThreshold;

    const { bullPct, bearPct, bScore, rScore } = this.computeSniperBias(tf15, tf5);
    const sniperBullOk = bullPct >= this.params.sniperPctThreshold;
    const sniperBearOk = bearPct >= this.params.sniperPctThreshold;

    const winProb = this.computeWinProb(tf1);
    const putProb = 100 - winProb;
    const winProbBullOk = winProb >= this.params.winProbThreshold;
    const winProbBearOk = putProb >= this.params.winProbThreshold;

    let direction: Direction = null;
    if (hubBullish && sniperBullOk && winProbBullOk) direction = 'BUY';
    else if (hubBearish && sniperBearOk && winProbBearOk) direction = 'SELL';

    // Build a human-readable shortfall string for the no-fire case.
    let reason = '';
    if (direction !== null) {
      reason = `aligned ${direction}`;
    } else {
      const bullParts: string[] = [];
      const bearParts: string[] = [];
      if (!hubBullish) bullParts.push(`hub ${(alignmentBullPct * 100).toFixed(0)}%<${this.params.hubAlignmentThreshold * 100}%`);
      if (!sniperBullOk) bullParts.push(`bullPct ${bullPct.toFixed(0)}<${this.params.sniperPctThreshold}`);
      if (!winProbBullOk) bullParts.push(`winProb ${winProb.toFixed(0)}<${this.params.winProbThreshold}`);
      if (!hubBearish) bearParts.push(`hub ${(alignmentBearPct * 100).toFixed(0)}%<${this.params.hubAlignmentThreshold * 100}%`);
      if (!sniperBearOk) bearParts.push(`bearPct ${bearPct.toFixed(0)}<${this.params.sniperPctThreshold}`);
      if (!winProbBearOk) bearParts.push(`putProb ${putProb.toFixed(0)}<${this.params.winProbThreshold}`);
      reason = `BUY short: [${bullParts.join(', ')}] | SELL short: [${bearParts.join(', ')}]`;
    }

    return {
      ok: direction !== null,
      reason,
      hubGreen,
      hubRed,
      hubTotal: allCells.length,
      alignmentBullPct: Math.round(alignmentBullPct * 10000) / 100,
      alignmentBearPct: Math.round(alignmentBearPct * 10000) / 100,
      bullPct: Math.round(bullPct * 100) / 100,
      bearPct: Math.round(bearPct * 100) / 100,
      bScore,
      rScore,
      winProb: Math.round(winProb * 100) / 100,
      putProb: Math.round(putProb * 100) / 100,
      hubBullish,
      hubBearish,
      sniperBullOk,
      sniperBearOk,
      winProbBullOk,
      winProbBearOk,
      direction,
      thresholds: empty.thresholds,
    };
  }

  /**
   * Evaluate the combined rule on a single market snapshot. Expects the
   * primary `candles` array to be the 15m series and `mtfCandles` to contain
   * `1m`, `5m`, `15m` and `60m` series. Returns a signal only on a direction
   * transition.
   */
  analyze(data: MarketSnapshot): SignalOutput | null {
    const { candles, ltp, symbol, exchange, mtfCandles } = data;
    const minCandles = 50;
    const key = `${symbol}:${exchange}`;

    if (!candles || candles.length < minCandles) {
      return null;
    }

    if (ltp <= 0) {
      return null;
    }

    if (!mtfCandles || !mtfCandles['1m'] || !mtfCandles['5m'] || !mtfCandles['60m']) {
      this.logger.debug(
        `[${this.name}] ${key}: mtfCandles missing required keys (1m/5m/60m), skipping`,
      );
      return null;
    }

    // The primary candles serve as the 15m series; fall back to mtfCandles['15m'] if supplied.
    const tf15 = mtfCandles['15m'] && mtfCandles['15m'].length >= minCandles
      ? mtfCandles['15m']
      : candles;
    const tf1 = mtfCandles['1m'];
    const tf5 = mtfCandles['5m'];
    const tf60 = mtfCandles['60m'];

    if (
      tf1.length < minCandles ||
      tf5.length < minCandles ||
      tf60.length < minCandles
    ) {
      this.logger.debug(
        `[${this.name}] ${key}: insufficient MTF candles (1m=${tf1.length}, 5m=${tf5.length}, 60m=${tf60.length})`,
      );
      return null;
    }

    // -----------------------------------------------------------------------
    // Condition 1 — V25 hub alignment (14 indicators × 4 timeframes = 56)
    // -----------------------------------------------------------------------
    const cells1m = this.computeHubCells(tf1);
    const cells5m = this.computeHubCells(tf5);
    const cells15m = this.computeHubCells(tf15);
    const cells60m = this.computeHubCells(tf60);

    const allCells = [...cells1m, ...cells5m, ...cells15m, ...cells60m];
    const hubGreen = allCells.filter((c) => c === 1).length;
    const hubRed = allCells.length - hubGreen;
    const alignmentPctBull = hubGreen / allCells.length;
    const alignmentPctBear = hubRed / allCells.length;

    const hubBullish = alignmentPctBull >= this.params.hubAlignmentThreshold;
    const hubBearish = alignmentPctBear >= this.params.hubAlignmentThreshold;

    // -----------------------------------------------------------------------
    // Condition 2 — Sniper bullPct / bearPct on 15m (with 5m RSI tie-in)
    // -----------------------------------------------------------------------
    const { bullPct, bearPct, bScore, rScore } = this.computeSniperBias(tf15, tf5);

    // -----------------------------------------------------------------------
    // Condition 3 — V25 win_prob on 1m
    // -----------------------------------------------------------------------
    const winProb = this.computeWinProb(tf1);
    const putProb = 100 - winProb;

    // -----------------------------------------------------------------------
    // Compose final direction
    // -----------------------------------------------------------------------
    const buyAligned =
      hubBullish &&
      bullPct >= this.params.sniperPctThreshold &&
      winProb >= this.params.winProbThreshold;

    const sellAligned =
      hubBearish &&
      bearPct >= this.params.sniperPctThreshold &&
      putProb >= this.params.winProbThreshold;

    let newDirection: Direction = null;
    if (buyAligned) newDirection = 'BUY';
    else if (sellAligned) newDirection = 'SELL';

    const previous = this.lastDirection.get(key) ?? null;

    // No alignment this bar — remember it so the next aligned bar fires.
    if (newDirection === null) {
      this.lastDirection.set(key, null);
      return null;
    }

    // Transition-only firing: if direction is unchanged, skip.
    if (previous === newDirection) {
      return null;
    }

    // NOTE: we deliberately do NOT mutate lastDirection here. The caller
    // must call commitTransition(symbol, exchange, side) only AFTER the
    // trade is actually confirmed downstream. This prevents a "stuck in
    // SELL" state if strike selection or trade execution fails post-fire.

    const atr = this.calculateATR(tf15, 14);
    if (atr <= 0) {
      return null;
    }

    const isBuy = newDirection === 'BUY';
    const stoploss = isBuy
      ? ltp - atr * this.params.stoplossATRMultiplier
      : ltp + atr * this.params.stoplossATRMultiplier;
    const target = isBuy
      ? ltp + atr * this.params.targetATRMultiplier
      : ltp - atr * this.params.targetATRMultiplier;

    const sidePct = isBuy ? bullPct : bearPct;
    const sideWinProb = isBuy ? winProb : putProb;
    const sideAlignment = isBuy ? alignmentPctBull : alignmentPctBear;

    const confidence = Math.min(
      100,
      Math.round((sidePct + sideWinProb + sideAlignment * 100) / 3),
    );

    return {
      symbol,
      exchange,
      side: newDirection,
      entryPrice: ltp,
      targetPrice: Math.round(target * 100) / 100,
      stoplossPrice: Math.round(stoploss * 100) / 100,
      confidence,
      reason: `V25 hub ${Math.round(sideAlignment * 100)}% aligned, Sniper bias ${Math.round(sidePct)}%, win_prob ${Math.round(sideWinProb)}%`,
      timeframe: '15m',
      metadata: {
        hubGreen,
        hubRed,
        bullPct: Math.round(bullPct * 100) / 100,
        bearPct: Math.round(bearPct * 100) / 100,
        bScore,
        rScore,
        winProb: Math.round(winProb * 100) / 100,
        alignmentPct: Math.round(sideAlignment * 10000) / 100,
        atr: Math.round(atr * 100) / 100,
        strategy: this.name,
      },
    };
  }

  /**
   * Walk-forward backtest. Since BacktestInput only carries a single candle
   * series, we feed the same series for every MTF slot — acknowledged
   * incorrect for MTF accuracy but the simplest correct implementation given
   * the current interface. Resets the transition-memory map before each run
   * so backtests are reproducible.
   */
  backtest(input: BacktestInput): BacktestResult {
    const { candles, initialCapital, positionSize } = input;
    const trades: BacktestTrade[] = [];
    const minCandles = 50;
    const maxHoldBars = 20;

    // Reset transition memory so the backtest is deterministic.
    this.lastDirection.clear();

    let capital = initialCapital;
    let peakCapital = initialCapital;
    let maxDrawdown = 0;
    let i = minCandles;

    while (i < candles.length) {
      const windowCandles = candles.slice(0, i + 1);
      const currentCandle = candles[i];

      const snapshot: MarketSnapshot = {
        symbol: 'BACKTEST',
        exchange: 'NSE',
        ltp: currentCandle.close,
        candles: windowCandles,
        volume: currentCandle.volume,
        mtfCandles: {
          '1m': windowCandles,
          '5m': windowCandles,
          '15m': windowCandles,
          '60m': windowCandles,
        },
      };

      const signal = this.analyze(snapshot);

      if (signal) {
        const entryPrice = currentCandle.close;
        const entryTime = currentCandle.timestamp;
        let exitPrice = entryPrice;
        let exitTime = entryTime;
        let exitReason = 'timeout';

        for (let j = i + 1; j < candles.length && j <= i + maxHoldBars; j++) {
          const bar = candles[j];

          if (signal.side === 'BUY') {
            if (bar.low <= signal.stoplossPrice) {
              exitPrice = signal.stoplossPrice;
              exitTime = bar.timestamp;
              exitReason = 'stoploss';
              i = j;
              break;
            }
            if (bar.high >= signal.targetPrice) {
              exitPrice = signal.targetPrice;
              exitTime = bar.timestamp;
              exitReason = 'target';
              i = j;
              break;
            }
          } else {
            if (bar.high >= signal.stoplossPrice) {
              exitPrice = signal.stoplossPrice;
              exitTime = bar.timestamp;
              exitReason = 'stoploss';
              i = j;
              break;
            }
            if (bar.low <= signal.targetPrice) {
              exitPrice = signal.targetPrice;
              exitTime = bar.timestamp;
              exitReason = 'target';
              i = j;
              break;
            }
          }

          if (j === i + maxHoldBars || j === candles.length - 1) {
            exitPrice = bar.close;
            exitTime = bar.timestamp;
            exitReason = 'timeout';
            i = j;
            break;
          }
        }

        const qty = positionSize;
        const pnl =
          signal.side === 'BUY'
            ? (exitPrice - entryPrice) * qty
            : (entryPrice - exitPrice) * qty;

        capital += pnl;

        if (capital > peakCapital) {
          peakCapital = capital;
        }
        const drawdown = ((peakCapital - capital) / peakCapital) * 100;
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown;
        }

        trades.push({
          entryTime,
          exitTime,
          side: signal.side,
          entryPrice,
          exitPrice,
          pnl: Math.round(pnl * 100) / 100,
          reason: exitReason,
        });
      }

      i++;
    }

    const wins = trades.filter((t) => t.pnl > 0).length;
    const totalReturn = capital - initialCapital;
    const sharpeRatio = this.calculateSharpeRatio(trades);

    return {
      totalTrades: trades.length,
      winRate: trades.length > 0 ? Math.round((wins / trades.length) * 10000) / 100 : 0,
      totalReturn: Math.round(totalReturn * 100) / 100,
      totalReturnPercent:
        Math.round((totalReturn / initialCapital) * 10000) / 100,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
      trades,
    };
  }

  /** Return current parameter values. */
  getParameters(): Record<string, any> {
    return { ...this.params };
  }

  /** Merge provided params into the current set. */
  setParameters(params: Record<string, any>): void {
    if (params.hubAlignmentThreshold !== undefined)
      this.params.hubAlignmentThreshold = Number(params.hubAlignmentThreshold);
    if (params.sniperPctThreshold !== undefined)
      this.params.sniperPctThreshold = Number(params.sniperPctThreshold);
    if (params.winProbThreshold !== undefined)
      this.params.winProbThreshold = Number(params.winProbThreshold);
    if (params.stoplossATRMultiplier !== undefined)
      this.params.stoplossATRMultiplier = Number(params.stoplossATRMultiplier);
    if (params.targetATRMultiplier !== undefined)
      this.params.targetATRMultiplier = Number(params.targetATRMultiplier);
    if (params.supertrendPeriod !== undefined)
      this.params.supertrendPeriod = Number(params.supertrendPeriod);
    if (params.supertrendMultiplier !== undefined)
      this.params.supertrendMultiplier = Number(params.supertrendMultiplier);
    if (params.macdFast !== undefined) this.params.macdFast = Number(params.macdFast);
    if (params.macdSlow !== undefined) this.params.macdSlow = Number(params.macdSlow);
    if (params.macdSignal !== undefined) this.params.macdSignal = Number(params.macdSignal);
    if (params.rsiPeriod !== undefined) this.params.rsiPeriod = Number(params.rsiPeriod);
    if (params.adxPeriod !== undefined) this.params.adxPeriod = Number(params.adxPeriod);
    if (params.hullPeriod !== undefined) this.params.hullPeriod = Number(params.hullPeriod);
    if (params.bbPeriod !== undefined) this.params.bbPeriod = Number(params.bbPeriod);
    if (params.emaFast !== undefined) this.params.emaFast = Number(params.emaFast);
    if (params.emaSlow !== undefined) this.params.emaSlow = Number(params.emaSlow);
  }

  // =========================================================================
  // Hub cell / sniper / win_prob evaluators
  // =========================================================================

  /**
   * Compute the 14 boolean hub indicators for one timeframe. Each entry is
   * 1 (bullish/green) or 0 (bearish/red). The 14th slot is the EMA crossover
   * which requires the previous bar, so falls back to 0 if not available.
   */
  private computeHubCells(candles: CandleData[]): number[] {
    const closes = candles.map((c) => c.close);
    const last = candles[candles.length - 1];

    const supertrend = this.calculateSupertrend(
      candles,
      this.params.supertrendPeriod,
      this.params.supertrendMultiplier,
    );
    const macd = this.calculateMACD(
      closes,
      this.params.macdFast,
      this.params.macdSlow,
      this.params.macdSignal,
    );
    const rsi = this.calculateRSI(closes, this.params.rsiPeriod);
    const adx = this.calculateADX(candles, this.params.adxPeriod);
    const hull = this.calculateHullMA(closes, this.params.hullPeriod);
    const bbMid = this.calculateSMA(closes, this.params.bbPeriod);
    const emaFastSeries = this.calculateEMA(closes, this.params.emaFast);
    const emaSlowSeries = this.calculateEMA(closes, this.params.emaSlow);

    const emaFastCurr = emaFastSeries.length > 0 ? emaFastSeries[emaFastSeries.length - 1] : 0;
    const emaSlowCurr = emaSlowSeries.length > 0 ? emaSlowSeries[emaSlowSeries.length - 1] : 0;
    const emaFastPrev = emaFastSeries.length > 1 ? emaFastSeries[emaFastSeries.length - 2] : emaFastCurr;
    const emaSlowPrev = emaSlowSeries.length > 1 ? emaSlowSeries[emaSlowSeries.length - 2] : emaSlowCurr;

    // 8. Delta = (close - open) / max(high - low, eps) * volume
    const range = Math.max(last.high - last.low, 0.00001);
    const delta = ((last.close - last.open) / range) * last.volume;

    const superBullish = last.close > supertrend ? 1 : 0;
    const macdBullish = macd.macd > macd.signal ? 1 : 0;
    const rsiBullish = rsi > 50 ? 1 : 0;
    const adxStrong = adx > 25 ? 1 : 0;
    const aboveHull = last.close > hull ? 1 : 0;
    const aboveBBMid = last.close > bbMid ? 1 : 0;
    const emaStackBull = emaFastCurr > emaSlowCurr ? 1 : 0;
    const deltaBull = delta > 0 ? 1 : 0;
    const renkoBull = last.close > last.open ? 1 : 0;
    const fibBull = last.close > emaSlowCurr ? 1 : 0;

    // 11. ADX > 30 breakout probability — bullish only when supertrend is bullish.
    const breakoutBull = adx > 30 && superBullish === 1 ? 1 : 0;

    // 12. close > supertrend lower band (pivot bias) — same as #1 in our impl.
    const pivotBull = superBullish;

    // 13. MACD bullish (q-trend) — same as #2.
    const qTrendBull = macdBullish;

    // 14. EMA9 crossover EMA21 on current bar.
    const emaCrossover = emaFastPrev <= emaSlowPrev && emaFastCurr > emaSlowCurr ? 1 : 0;

    return [
      superBullish,
      macdBullish,
      rsiBullish,
      adxStrong,
      aboveHull,
      aboveBBMid,
      emaStackBull,
      deltaBull,
      renkoBull,
      fibBull,
      breakoutBull,
      pivotBull,
      qTrendBull,
      emaCrossover,
    ];
  }

  /**
   * Compute the 15m Sniper 7-condition bullish/bearish score. Condition 7
   * pulls RSI from the 5m timeframe for cross-tf confirmation.
   */
  private computeSniperBias(
    tf15: CandleData[],
    tf5: CandleData[],
  ): { bullPct: number; bearPct: number; bScore: number; rScore: number } {
    const closes = tf15.map((c) => c.close);
    const last = tf15[tf15.length - 1];

    const vwap = this.calculateVWAP(tf15);
    const rsi15 = this.calculateRSI(closes, this.params.rsiPeriod);
    const macd = this.calculateMACD(
      closes,
      this.params.macdFast,
      this.params.macdSlow,
      this.params.macdSignal,
    );
    const emaFastSeries = this.calculateEMA(closes, this.params.emaFast);
    const emaSlowSeries = this.calculateEMA(closes, this.params.emaSlow);
    const emaFastCurr = emaFastSeries.length > 0 ? emaFastSeries[emaFastSeries.length - 1] : 0;
    const emaSlowCurr = emaSlowSeries.length > 0 ? emaSlowSeries[emaSlowSeries.length - 1] : 0;
    const adx = this.calculateADX(tf15, this.params.adxPeriod);
    const volAvg = this.calculateSMA(
      tf15.slice(-20).map((c) => c.volume),
      20,
    );
    const rsi5 = this.calculateRSI(
      tf5.map((c) => c.close),
      this.params.rsiPeriod,
    );

    const bulls: boolean[] = [
      last.close > vwap,
      rsi15 > 50,
      macd.macd > macd.signal,
      emaFastCurr > emaSlowCurr,
      adx > 25 && last.close > emaFastCurr,
      volAvg > 0 && last.volume > volAvg && last.close > last.open,
      rsi5 > 50,
    ];

    const bears: boolean[] = [
      last.close < vwap,
      rsi15 < 50,
      macd.macd < macd.signal,
      emaFastCurr < emaSlowCurr,
      adx > 25 && last.close < emaFastCurr,
      volAvg > 0 && last.volume > volAvg && last.close < last.open,
      rsi5 < 50,
    ];

    const bScore = bulls.filter(Boolean).length;
    const rScore = bears.filter(Boolean).length;

    const total = bScore + rScore;
    const bullPct = total > 0 ? (bScore / total) * 100 : 0;
    const bearPct = total > 0 ? (rScore / total) * 100 : 0;

    return { bullPct, bearPct, bScore, rScore };
  }

  /**
   * Compute the 1m win_prob score from 5 weighted checks (each contributes
   * 20 points when true, giving a 0-100 range).
   */
  private computeWinProb(tf1: CandleData[]): number {
    const closes = tf1.map((c) => c.close);
    const last = tf1[tf1.length - 1];

    const supertrend = this.calculateSupertrend(
      tf1,
      this.params.supertrendPeriod,
      this.params.supertrendMultiplier,
    );
    const macd = this.calculateMACD(
      closes,
      this.params.macdFast,
      this.params.macdSlow,
      this.params.macdSignal,
    );
    const rsi = this.calculateRSI(closes, this.params.rsiPeriod);
    const emaFastSeries = this.calculateEMA(closes, this.params.emaFast);
    const emaSlowSeries = this.calculateEMA(closes, this.params.emaSlow);
    const emaFastCurr = emaFastSeries.length > 0 ? emaFastSeries[emaFastSeries.length - 1] : 0;
    const emaSlowCurr = emaSlowSeries.length > 0 ? emaSlowSeries[emaSlowSeries.length - 1] : 0;
    const hull = this.calculateHullMA(closes, this.params.hullPeriod);

    let score = 0;
    if (last.close > supertrend) score += 20;
    if (macd.macd > macd.signal) score += 20;
    if (rsi > 50) score += 20;
    if (emaFastCurr > emaSlowCurr) score += 20;
    if (last.close > hull) score += 20;

    return score;
  }

  // =========================================================================
  // Technical indicator helpers (inlined — no shared utility found)
  // =========================================================================

  /**
   * RSI over `period` using Wilder smoothing. Returns the most recent value,
   * or 50 when there is not enough data.
   */
  private calculateRSI(values: number[], period: number): number {
    if (values.length < period + 1) return 50;

    const deltas: number[] = [];
    for (let i = 1; i < values.length; i++) {
      deltas.push(values[i] - values[i - 1]);
    }

    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < period; i++) {
      if (deltas[i] > 0) avgGain += deltas[i];
      else avgLoss += Math.abs(deltas[i]);
    }
    avgGain /= period;
    avgLoss /= period;

    for (let i = period; i < deltas.length; i++) {
      const gain = deltas[i] > 0 ? deltas[i] : 0;
      const loss = deltas[i] < 0 ? Math.abs(deltas[i]) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /**
   * MACD with standard (fast=12, slow=26, signal=9) parameters. Returns
   * the latest `macd` line value and its signal-line value.
   */
  private calculateMACD(
    values: number[],
    fast: number,
    slow: number,
    signal: number,
  ): { macd: number; signal: number } {
    const fastEMA = this.calculateEMA(values, fast);
    const slowEMA = this.calculateEMA(values, slow);

    if (fastEMA.length === 0 || slowEMA.length === 0) {
      return { macd: 0, signal: 0 };
    }

    // Align both EMA series to the same end and compute MACD line
    const offset = slow - fast; // fastEMA starts earlier than slowEMA
    const macdLine: number[] = [];
    for (let i = 0; i < slowEMA.length; i++) {
      macdLine.push(fastEMA[i + offset] - slowEMA[i]);
    }

    const signalSeries = this.calculateEMA(macdLine, signal);
    const macdCurr = macdLine[macdLine.length - 1] ?? 0;
    const signalCurr = signalSeries[signalSeries.length - 1] ?? 0;

    return { macd: macdCurr, signal: signalCurr };
  }

  /**
   * Exponential moving average series. First value seeded with SMA of the
   * first `period` samples; subsequent values use the standard EMA formula.
   */
  private calculateEMA(values: number[], period: number): number[] {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const result: number[] = [];

    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    let ema = sum / period;
    result.push(ema);

    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  }

  /** Simple moving average of the last `period` values. */
  private calculateSMA(values: number[], period: number): number {
    if (values.length === 0) return 0;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  /**
   * Weighted moving average of the last `period` values. Weights rise
   * linearly (1..period) with the most recent value weighted highest.
   */
  private calculateWMA(values: number[], period: number): number {
    if (values.length < period) return 0;
    const slice = values.slice(-period);
    let sum = 0;
    let weightSum = 0;
    for (let i = 0; i < slice.length; i++) {
      const w = i + 1;
      sum += slice[i] * w;
      weightSum += w;
    }
    return sum / weightSum;
  }

  /**
   * Hull Moving Average: HMA(n) = WMA( 2*WMA(n/2) - WMA(n), sqrt(n) ).
   * Returns the most recent HMA value.
   */
  private calculateHullMA(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1] ?? 0;

    const halfPeriod = Math.floor(period / 2);
    const sqrtPeriod = Math.max(1, Math.floor(Math.sqrt(period)));

    // Build a raw series of (2*WMA(n/2) - WMA(n)) over a sliding window.
    const raw: number[] = [];
    for (let i = period - 1; i < values.length; i++) {
      const window = values.slice(0, i + 1);
      const wmaHalf = this.calculateWMA(window, halfPeriod);
      const wmaFull = this.calculateWMA(window, period);
      raw.push(2 * wmaHalf - wmaFull);
    }

    if (raw.length < sqrtPeriod) return raw[raw.length - 1] ?? 0;

    return this.calculateWMA(raw, sqrtPeriod);
  }

  /**
   * Bollinger middle band = SMA of closes over `period`. (Wrapper kept
   * for symmetry with the hub checklist.)
   */
  private calculateBollingerMid(values: number[], period: number): number {
    return this.calculateSMA(values, period);
  }

  /**
   * Average True Range (Wilder smoothing). Returns the most recent ATR.
   */
  private calculateATR(candles: CandleData[], period: number): number {
    if (candles.length < period + 1) return 0;

    const trValues: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trValues.push(tr);
    }

    let atr = 0;
    for (let i = 0; i < period; i++) atr += trValues[i];
    atr /= period;

    for (let i = period; i < trValues.length; i++) {
      atr = (atr * (period - 1) + trValues[i]) / period;
    }
    return atr;
  }

  /**
   * SuperTrend line value for the latest bar. Uses ATR with configured
   * period/multiplier and walks the series bar-by-bar flipping direction
   * when price closes through the opposing band.
   */
  private calculateSupertrend(
    candles: CandleData[],
    period: number,
    multiplier: number,
  ): number {
    if (candles.length < period + 1) return candles[candles.length - 1]?.close ?? 0;

    // Pre-compute ATR series with Wilder smoothing up to each bar.
    const trValues: number[] = [0];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      trValues.push(
        Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)),
      );
    }

    const atrSeries: number[] = new Array(candles.length).fill(0);
    let seedSum = 0;
    for (let i = 1; i <= period; i++) seedSum += trValues[i];
    atrSeries[period] = seedSum / period;
    for (let i = period + 1; i < candles.length; i++) {
      atrSeries[i] = (atrSeries[i - 1] * (period - 1) + trValues[i]) / period;
    }

    let finalUpper = 0;
    let finalLower = 0;
    let prevFinalUpper = 0;
    let prevFinalLower = 0;
    let supertrend = 0;
    let prevSupertrend = 0;
    let direction = 1; // 1 = bullish, -1 = bearish

    for (let i = period; i < candles.length; i++) {
      const c = candles[i];
      const hl2 = (c.high + c.low) / 2;
      const atr = atrSeries[i];
      const basicUpper = hl2 + multiplier * atr;
      const basicLower = hl2 - multiplier * atr;

      if (i === period) {
        finalUpper = basicUpper;
        finalLower = basicLower;
        supertrend = finalUpper;
        direction = -1;
      } else {
        finalUpper =
          basicUpper < prevFinalUpper || candles[i - 1].close > prevFinalUpper
            ? basicUpper
            : prevFinalUpper;
        finalLower =
          basicLower > prevFinalLower || candles[i - 1].close < prevFinalLower
            ? basicLower
            : prevFinalLower;

        if (prevSupertrend === prevFinalUpper) {
          supertrend = c.close > finalUpper ? finalLower : finalUpper;
        } else {
          supertrend = c.close < finalLower ? finalUpper : finalLower;
        }
        direction = supertrend === finalLower ? 1 : -1;
      }

      prevFinalUpper = finalUpper;
      prevFinalLower = finalLower;
      prevSupertrend = supertrend;
    }

    return supertrend;
  }

  /**
   * Average Directional Index (Wilder). Returns the most recent ADX value.
   */
  private calculateADX(candles: CandleData[], period: number): number {
    if (candles.length < period * 2 + 1) return 0;

    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const tr: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const up = candles[i].high - candles[i - 1].high;
      const down = candles[i - 1].low - candles[i].low;

      plusDM.push(up > down && up > 0 ? up : 0);
      minusDM.push(down > up && down > 0 ? down : 0);

      const h = candles[i].high;
      const l = candles[i].low;
      const pc = candles[i - 1].close;
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }

    // Wilder-smoothed sums.
    let trSum = 0;
    let plusSum = 0;
    let minusSum = 0;
    for (let i = 0; i < period; i++) {
      trSum += tr[i];
      plusSum += plusDM[i];
      minusSum += minusDM[i];
    }

    const dxValues: number[] = [];
    let plusDI = trSum === 0 ? 0 : (plusSum / trSum) * 100;
    let minusDI = trSum === 0 ? 0 : (minusSum / trSum) * 100;
    const diSum = plusDI + minusDI;
    dxValues.push(diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100);

    for (let i = period; i < tr.length; i++) {
      trSum = trSum - trSum / period + tr[i];
      plusSum = plusSum - plusSum / period + plusDM[i];
      minusSum = minusSum - minusSum / period + minusDM[i];
      plusDI = trSum === 0 ? 0 : (plusSum / trSum) * 100;
      minusDI = trSum === 0 ? 0 : (minusSum / trSum) * 100;
      const diTotal = plusDI + minusDI;
      dxValues.push(diTotal === 0 ? 0 : (Math.abs(plusDI - minusDI) / diTotal) * 100);
    }

    if (dxValues.length < period) return 0;

    let adx = 0;
    for (let i = 0; i < period; i++) adx += dxValues[i];
    adx /= period;

    for (let i = period; i < dxValues.length; i++) {
      adx = (adx * (period - 1) + dxValues[i]) / period;
    }
    return adx;
  }

  /**
   * Session VWAP approximation over the supplied candles. Uses hlc3 as the
   * typical price and aggregates price*volume / volume across the full
   * series we are given (no intraday reset — caller supplies the window).
   */
  private calculateVWAP(candles: CandleData[]): number {
    let pvSum = 0;
    let volSum = 0;
    for (const c of candles) {
      const typical = (c.high + c.low + c.close) / 3;
      pvSum += typical * c.volume;
      volSum += c.volume;
    }
    return volSum === 0 ? candles[candles.length - 1]?.close ?? 0 : pvSum / volSum;
  }

  /** Annualized Sharpe ratio from trade PnLs (assuming 252 trading days). */
  private calculateSharpeRatio(trades: BacktestTrade[]): number {
    if (trades.length < 2) return 0;

    const returns = trades.map((t) => t.pnl);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;
    return (mean / stdDev) * Math.sqrt(252);
  }
}
