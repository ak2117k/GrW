/**
 * VWAP Deviation Strategy
 *
 * Intraday mean reversion strategy that generates signals when price deviates
 * significantly from the Volume Weighted Average Price (VWAP) and shows signs
 * of reverting. Uses standard deviation bands around VWAP to define entry zones.
 *
 * Excellent for intraday options trading on 5m and 15m timeframes.
 */

import { Injectable } from '@nestjs/common';
import {
  TradingStrategy,
  MarketSnapshot,
  SignalOutput,
  BacktestInput,
  BacktestResult,
  BacktestTrade,
  CandleData,
} from '../../../common/interfaces/trading-strategy.interface';

interface VwapDeviationParameters {
  deviationMultiplier: number;
  minDeviation: number;
  maxDeviation: number;
  stoplossPercent: number;
  targetPercent: number;
  volumeConfirmation: boolean;
}

interface VwapBands {
  vwap: number;
  upper: number;
  lower: number;
  stdDev: number;
}

@Injectable()
export class VwapDeviationStrategy implements TradingStrategy {
  readonly name = 'vwap-deviation';
  readonly description =
    'Intraday mean reversion around VWAP using standard deviation bands';
  readonly supportedSegments = ['OPTIONS', 'EQUITY', 'FUTURES'];
  readonly preferredTimeframes = ['5m', '15m'];

  private params: VwapDeviationParameters = {
    deviationMultiplier: 2.0,
    minDeviation: 0.5,
    maxDeviation: 3.0,
    stoplossPercent: 1.0,
    targetPercent: 1.5,
    volumeConfirmation: true,
  };

  /**
   * Analyze current market snapshot for VWAP deviation signals.
   *
   * Logic:
   * 1. Compute VWAP and standard deviation bands from intraday candles.
   * 2. BUY when price touches/crosses below the lower band and starts
   *    reverting upward (current close > previous close), within the
   *    acceptable deviation range.
   * 3. SELL under the mirror conditions at the upper band.
   * 4. Target is reversion to VWAP; stoploss is placed beyond the band.
   */
  analyze(data: MarketSnapshot): SignalOutput | null {
    const { candles, ltp, symbol, exchange } = data;

    // Need a reasonable number of intraday candles for VWAP calculation
    const minCandles = 10;
    if (!candles || candles.length < minCandles) {
      return null;
    }

    if (ltp <= 0) {
      return null;
    }

    const bands = this.calculateVWAPBands(candles, this.params.deviationMultiplier);
    if (bands.vwap <= 0 || bands.stdDev <= 0) {
      return null;
    }

    const currentCandle = candles[candles.length - 1];
    const previousCandle = candles[candles.length - 2];

    // Calculate deviation as percentage from VWAP
    const deviationPercent = Math.abs((ltp - bands.vwap) / bands.vwap) * 100;

    // Ignore if deviation is outside acceptable range
    if (deviationPercent < this.params.minDeviation || deviationPercent > this.params.maxDeviation) {
      return null;
    }

    // Volume confirmation: current volume should exceed 20-bar average
    if (this.params.volumeConfirmation && candles.length >= 20) {
      const avgVolume =
        candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
      if (avgVolume > 0 && currentCandle.volume < avgVolume) {
        return null;
      }
    }

    // Count how many times VWAP has held today (touches within 0.3% that reverted)
    const vwapHoldCount = this.countVWAPHolds(candles, bands.vwap);

    // BUY: price at or below lower band and starts reverting up
    const atLowerBand = ltp <= bands.lower;
    const revertingUp = currentCandle.close > previousCandle.close;

    // SELL: price at or above upper band and starts reverting down
    const atUpperBand = ltp >= bands.upper;
    const revertingDown = currentCandle.close < previousCandle.close;

    if (atLowerBand && revertingUp) {
      const target = bands.vwap;
      const stoploss = ltp * (1 - this.params.stoplossPercent / 100);
      const confidence = this.calculateConfidence(
        ltp,
        bands,
        currentCandle,
        candles,
        vwapHoldCount,
      );

      return {
        symbol,
        exchange,
        side: 'BUY',
        entryPrice: ltp,
        targetPrice: Math.round(target * 100) / 100,
        stoplossPrice: Math.round(stoploss * 100) / 100,
        confidence,
        reason: `Price at VWAP lower band (${deviationPercent.toFixed(1)}% below VWAP). Reverting up. VWAP held ${vwapHoldCount} times today.`,
        timeframe: this.preferredTimeframes[0],
        metadata: {
          vwap: Math.round(bands.vwap * 100) / 100,
          upperBand: Math.round(bands.upper * 100) / 100,
          lowerBand: Math.round(bands.lower * 100) / 100,
          deviationPercent: Math.round(deviationPercent * 100) / 100,
          vwapHoldCount,
          strategy: this.name,
        },
      };
    }

    if (atUpperBand && revertingDown) {
      const target = bands.vwap;
      const stoploss = ltp * (1 + this.params.stoplossPercent / 100);
      const confidence = this.calculateConfidence(
        ltp,
        bands,
        currentCandle,
        candles,
        vwapHoldCount,
      );

      return {
        symbol,
        exchange,
        side: 'SELL',
        entryPrice: ltp,
        targetPrice: Math.round(target * 100) / 100,
        stoplossPrice: Math.round(stoploss * 100) / 100,
        confidence,
        reason: `Price at VWAP upper band (${deviationPercent.toFixed(1)}% above VWAP). Reverting down. VWAP held ${vwapHoldCount} times today.`,
        timeframe: this.preferredTimeframes[0],
        metadata: {
          vwap: Math.round(bands.vwap * 100) / 100,
          upperBand: Math.round(bands.upper * 100) / 100,
          lowerBand: Math.round(bands.lower * 100) / 100,
          deviationPercent: Math.round(deviationPercent * 100) / 100,
          vwapHoldCount,
          strategy: this.name,
        },
      };
    }

    return null;
  }

  /**
   * Walk-forward backtest over intraday candle data.
   *
   * Tracks VWAP reversion trades: enters when price hits a band and reverts,
   * exits at VWAP (target), stoploss, or after 20 bars.
   */
  backtest(input: BacktestInput): BacktestResult {
    const { candles, initialCapital, positionSize } = input;
    const trades: BacktestTrade[] = [];
    const minCandles = 10;
    const maxHoldBars = 20;

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
    if (params.deviationMultiplier !== undefined)
      this.params.deviationMultiplier = Number(params.deviationMultiplier);
    if (params.minDeviation !== undefined)
      this.params.minDeviation = Number(params.minDeviation);
    if (params.maxDeviation !== undefined)
      this.params.maxDeviation = Number(params.maxDeviation);
    if (params.stoplossPercent !== undefined)
      this.params.stoplossPercent = Number(params.stoplossPercent);
    if (params.targetPercent !== undefined)
      this.params.targetPercent = Number(params.targetPercent);
    if (params.volumeConfirmation !== undefined)
      this.params.volumeConfirmation = Boolean(params.volumeConfirmation);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Calculate Volume Weighted Average Price.
   *
   * VWAP = cumulative(typical_price * volume) / cumulative(volume)
   * where typical_price = (high + low + close) / 3
   */
  private calculateVWAP(candles: CandleData[]): number {
    let cumulativeTPV = 0;
    let cumulativeVolume = 0;

    for (const candle of candles) {
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativeTPV += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;
    }

    if (cumulativeVolume === 0) {
      return 0;
    }

    return cumulativeTPV / cumulativeVolume;
  }

  /**
   * Calculate VWAP with upper and lower standard deviation bands.
   *
   * The standard deviation is computed on the difference between each bar's
   * typical price and the running VWAP, weighted by volume.
   */
  private calculateVWAPBands(candles: CandleData[], multiplier: number): VwapBands {
    const vwap = this.calculateVWAP(candles);

    if (vwap <= 0) {
      return { vwap: 0, upper: 0, lower: 0, stdDev: 0 };
    }

    // Calculate volume-weighted standard deviation of typical price from VWAP
    let cumulativeVolume = 0;
    let weightedSqDiffSum = 0;

    for (const candle of candles) {
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      const diff = typicalPrice - vwap;
      weightedSqDiffSum += diff * diff * candle.volume;
      cumulativeVolume += candle.volume;
    }

    const stdDev = cumulativeVolume > 0 ? Math.sqrt(weightedSqDiffSum / cumulativeVolume) : 0;

    return {
      vwap,
      upper: vwap + stdDev * multiplier,
      lower: vwap - stdDev * multiplier,
      stdDev,
    };
  }

  /**
   * Standard deviation of a numeric array.
   */
  private calculateStdDev(values: number[]): number {
    if (values.length < 2) return 0;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;

    return Math.sqrt(variance);
  }

  /**
   * Count the number of times price touched VWAP (within 0.3%) and reverted
   * in the provided candle history. A higher hold count increases confidence
   * that VWAP will act as a magnet.
   */
  private countVWAPHolds(candles: CandleData[], vwap: number): number {
    if (vwap <= 0) return 0;

    const threshold = vwap * 0.003; // 0.3%
    let holdCount = 0;

    for (let i = 1; i < candles.length - 1; i++) {
      const typicalPrice = (candles[i].high + candles[i].low + candles[i].close) / 3;
      const nextTypical =
        (candles[i + 1].high + candles[i + 1].low + candles[i + 1].close) / 3;

      // Price was near VWAP and then moved away (reverted)
      if (Math.abs(typicalPrice - vwap) < threshold) {
        if (Math.abs(nextTypical - vwap) >= threshold) {
          holdCount++;
        }
      }
    }

    return holdCount;
  }

  /**
   * Confidence score (0-100) based on:
   * - How cleanly price touched the band (vs. blowing through it).
   * - Volume at the touch point relative to average.
   * - Number of times VWAP has held today (more holds = stronger magnet).
   */
  private calculateConfidence(
    price: number,
    bands: VwapBands,
    currentCandle: CandleData,
    candles: CandleData[],
    vwapHoldCount: number,
  ): number {
    let score = 40; // base

    // Clean touch: price is near the band rather than far through it
    const distFromLower = Math.abs(price - bands.lower);
    const distFromUpper = Math.abs(price - bands.upper);
    const bandWidth = bands.upper - bands.lower;

    if (bandWidth > 0) {
      const nearestBandDist = Math.min(distFromLower, distFromUpper);
      const touchCleanness = 1 - Math.min(1, nearestBandDist / (bandWidth * 0.1));
      score += touchCleanness * 20;
    }

    // Volume component
    if (candles.length >= 20) {
      const avgVolume =
        candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
      if (avgVolume > 0) {
        const volumeRatio = currentCandle.volume / avgVolume;
        score += Math.min(15, (volumeRatio - 1) * 8);
      }
    }

    // VWAP hold count: each hold adds confidence (up to 25 points)
    score += Math.min(25, vwapHoldCount * 5);

    return Math.round(Math.max(0, Math.min(100, score)));
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
