/**
 * ATR Supertrend Strategy
 *
 * Custom Supertrend indicator with a smoothed (EMA) price source and adaptive
 * bands computed from an RMA-based ATR.  Signals fire on trend flips: when the
 * Supertrend transitions from bearish to bullish (BUY) or bullish to bearish
 * (SELL).  The Supertrend line itself acts as the natural stoploss level.
 *
 * Best suited for options, equity, and futures on 15m and 1h timeframes.
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

interface AtrSupertrendParameters {
  atrLength: number;
  atrMultiplier: number;
  smoothingPeriod: number;
  stoplossATRMultiplier: number;
  targetATRMultiplier: number;
}

@Injectable()
export class AtrSupertrendStrategy implements TradingStrategy {
  readonly name = 'atr-supertrend';
  readonly description =
    'Adaptive Supertrend strategy using smoothed source and RMA-based ATR bands';
  readonly supportedSegments = ['OPTIONS', 'EQUITY', 'FUTURES'];
  readonly preferredTimeframes = ['15m', '1h'];

  private params: AtrSupertrendParameters = {
    atrLength: 40,
    atrMultiplier: 3.5,
    smoothingPeriod: 10,
    stoplossATRMultiplier: 2.0,
    targetATRMultiplier: 4.0,
  };

  /**
   * Analyze current market snapshot for ATR Supertrend flip signals.
   *
   * Logic:
   * 1. Compute smoothed source = EMA(close, smoothingPeriod).
   * 2. Compute ATR via RMA(TrueRange, atrLength) * atrMultiplier.
   * 3. Walk the Supertrend state machine across all candles.
   * 4. Signal fires when the trend flips on the most recent bar.
   * 5. Stoploss = Supertrend line; target = 2x reward from entry.
   *
   * @returns SignalOutput if a trend flip occurred on the latest bar, null otherwise.
   */
  analyze(data: MarketSnapshot): SignalOutput | null {
    const { candles, ltp, symbol, exchange } = data;

    // Need enough candles for both EMA seed and RMA seed plus some lookback
    const minCandles = Math.max(this.params.atrLength, this.params.smoothingPeriod) + 10;
    if (!candles || candles.length < minCandles) {
      return null;
    }

    if (ltp <= 0) {
      return null;
    }

    // Smoothed source: EMA of close prices
    const closes = candles.map((c) => c.close);
    const smoothedSeries = this.calculateEMA(closes, this.params.smoothingPeriod);
    if (smoothedSeries.length < 2) {
      return null;
    }

    // True Range series (starts from index 1 of candles)
    const trValues = this.calculateTrueRange(candles);

    // RMA of True Range
    const rmaSeries = this.calculateRMA(trValues, this.params.atrLength);
    if (rmaSeries.length < 2) {
      return null;
    }

    // Align smoothed source and RMA series to the same length from the end.
    // smoothedSeries has length = candles.length - smoothingPeriod + 1
    // rmaSeries has length = trValues.length - atrLength + 1 = candles.length - 1 - atrLength + 1
    // We need them aligned so the last element of each corresponds to the last candle.
    const alignedLength = Math.min(smoothedSeries.length, rmaSeries.length);
    const smoothed = smoothedSeries.slice(-alignedLength);
    const rma = rmaSeries.slice(-alignedLength);

    if (alignedLength < 2) {
      return null;
    }

    // Walk the Supertrend state machine
    const atrBand0 = rma[0] * this.params.atrMultiplier;
    let supertrend = smoothed[0] - atrBand0;
    let trend = 1; // 1 = bullish, -1 = bearish

    for (let i = 1; i < alignedLength; i++) {
      const src = smoothed[i];
      const atrBand = rma[i] * this.params.atrMultiplier;
      const prevTrend = trend;

      if (trend === 1) {
        if (src < supertrend) {
          trend = -1;
          supertrend = src + atrBand;
        } else {
          supertrend = Math.max(supertrend, src - atrBand); // ratchet up
        }
      } else {
        if (src > supertrend) {
          trend = 1;
          supertrend = src - atrBand;
        } else {
          supertrend = Math.min(supertrend, src + atrBand); // ratchet down
        }
      }

      // Only care about the last bar for signal generation
      if (i === alignedLength - 1) {
        const currentATR = rma[i];
        const isBuyFlip = trend === 1 && prevTrend === -1;
        const isSellFlip = trend === -1 && prevTrend === 1;

        if (!isBuyFlip && !isSellFlip) {
          return null;
        }

        const confidence = this.calculateConfidence(
          currentATR,
          rma,
          supertrend,
          src,
          candles,
        );

        // Stoploss at the supertrend line; fallback to ATR-based if too close
        const fallbackATR = this.calculateATR(candles, 14);
        const minDistance = fallbackATR * this.params.stoplossATRMultiplier;

        if (isBuyFlip) {
          let stoploss = supertrend;
          if (ltp - stoploss < minDistance) {
            stoploss = ltp - minDistance;
          }
          // Target: 2x the risk from entry
          const risk = ltp - stoploss;
          const target = ltp + risk * 2;

          return {
            symbol,
            exchange,
            side: 'BUY',
            entryPrice: ltp,
            targetPrice: Math.round(target * 100) / 100,
            stoplossPrice: Math.round(stoploss * 100) / 100,
            confidence,
            reason: `Supertrend flipped bullish. Smoothed source crossed above band. ATR(${this.params.atrLength})=${currentATR.toFixed(2)}, Supertrend=${supertrend.toFixed(2)}`,
            timeframe: this.preferredTimeframes[0],
            metadata: {
              supertrend: Math.round(supertrend * 100) / 100,
              trend,
              atr: Math.round(currentATR * 100) / 100,
              smoothedSource: Math.round(src * 100) / 100,
              strategy: this.name,
            },
          };
        }

        if (isSellFlip) {
          let stoploss = supertrend;
          if (stoploss - ltp < minDistance) {
            stoploss = ltp + minDistance;
          }
          const risk = stoploss - ltp;
          const target = ltp - risk * 2;

          return {
            symbol,
            exchange,
            side: 'SELL',
            entryPrice: ltp,
            targetPrice: Math.round(target * 100) / 100,
            stoplossPrice: Math.round(stoploss * 100) / 100,
            confidence,
            reason: `Supertrend flipped bearish. Smoothed source crossed below band. ATR(${this.params.atrLength})=${currentATR.toFixed(2)}, Supertrend=${supertrend.toFixed(2)}`,
            timeframe: this.preferredTimeframes[0],
            metadata: {
              supertrend: Math.round(supertrend * 100) / 100,
              trend,
              atr: Math.round(currentATR * 100) / 100,
              smoothedSource: Math.round(src * 100) / 100,
              strategy: this.name,
            },
          };
        }
      }
    }

    return null;
  }

  /**
   * Walk-forward backtest over historical candles.
   *
   * At each bar past the minimum lookback, builds a synthetic MarketSnapshot
   * and calls analyze(). Open trades are exited when price hits target,
   * stoploss, or after 20 candles (timeout).
   */
  backtest(input: BacktestInput): BacktestResult {
    const { candles, initialCapital, positionSize } = input;
    const trades: BacktestTrade[] = [];
    const minCandles = Math.max(this.params.atrLength, this.params.smoothingPeriod) + 10;
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
    if (params.atrLength !== undefined) this.params.atrLength = Number(params.atrLength);
    if (params.atrMultiplier !== undefined) this.params.atrMultiplier = Number(params.atrMultiplier);
    if (params.smoothingPeriod !== undefined)
      this.params.smoothingPeriod = Number(params.smoothingPeriod);
    if (params.stoplossATRMultiplier !== undefined)
      this.params.stoplossATRMultiplier = Number(params.stoplossATRMultiplier);
    if (params.targetATRMultiplier !== undefined)
      this.params.targetATRMultiplier = Number(params.targetATRMultiplier);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Exponential Moving Average series.
   *
   * Seeded with the SMA of the first `period` values, then:
   *   EMA_t = value * k + EMA_{t-1} * (1 - k)
   *   where k = 2 / (period + 1)
   *
   * @returns Array of EMA values starting from index `period - 1`.
   */
  private calculateEMA(values: number[], period: number): number[] {
    if (values.length < period) {
      return [];
    }

    const k = 2 / (period + 1);
    const emaValues: number[] = [];

    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += values[i];
    }
    let ema = sum / period;
    emaValues.push(ema);

    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
      emaValues.push(ema);
    }

    return emaValues;
  }

  /**
   * Wilder's Moving Average (RMA) series.
   *
   * Seeded with the SMA of the first `period` values, then:
   *   RMA_t = (RMA_{t-1} * (period - 1) + value) / period
   *
   * @returns Array of RMA values starting from index `period - 1`.
   */
  private calculateRMA(values: number[], period: number): number[] {
    if (values.length < period) {
      return [];
    }

    const rmaValues: number[] = [];

    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += values[i];
    }
    let rma = sum / period;
    rmaValues.push(rma);

    for (let i = period; i < values.length; i++) {
      rma = (rma * (period - 1) + values[i]) / period;
      rmaValues.push(rma);
    }

    return rmaValues;
  }

  /**
   * True Range series.
   *
   * TR = max(high - low, |high - prevClose|, |low - prevClose|)
   *
   * @returns Array of TR values (length = candles.length - 1).
   */
  private calculateTrueRange(candles: CandleData[]): number[] {
    const trValues: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;

      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trValues.push(tr);
    }

    return trValues;
  }

  /**
   * Average True Range over the given period (Wilder smoothing).
   * Used as a fallback for stoploss/target sizing.
   */
  private calculateATR(candles: CandleData[], period: number): number {
    if (candles.length < period + 1) {
      return 0;
    }

    const trValues = this.calculateTrueRange(candles);

    let atr = 0;
    for (let i = 0; i < period; i++) {
      atr += trValues[i];
    }
    atr /= period;

    for (let i = period; i < trValues.length; i++) {
      atr = (atr * (period - 1) + trValues[i]) / period;
    }

    return atr;
  }

  /**
   * Confidence score (0-100) based on:
   * - Base: 50 (supertrend flip is inherently strong).
   * - ATR expansion vs average: up to 20 points.
   * - Smoothed source distance from supertrend line: up to 15 points.
   * - Volume confirmation: up to 15 points.
   */
  private calculateConfidence(
    currentATR: number,
    rmaSeries: number[],
    supertrend: number,
    smoothedSource: number,
    candles: CandleData[],
  ): number {
    let score = 50; // base — supertrend flip is a strong signal

    // ATR expansion component: trending market has expanding ATR
    if (rmaSeries.length >= 20) {
      const recentATRs = rmaSeries.slice(-20);
      const avgATR = recentATRs.reduce((a, b) => a + b, 0) / recentATRs.length;
      if (avgATR > 0) {
        const expansion = (currentATR / avgATR - 1) * 40;
        score += Math.min(20, Math.max(0, expansion));
      }
    }

    // Distance from supertrend line: further away = stronger conviction
    if (supertrend > 0) {
      const distancePercent = (Math.abs(smoothedSource - supertrend) / supertrend) * 100;
      score += Math.min(15, distancePercent * 5);
    }

    // Volume confirmation
    if (candles.length >= 20) {
      const recentVolumes = candles.slice(-20).map((c) => c.volume);
      const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
      const currentVolume = candles[candles.length - 1].volume;

      if (avgVolume > 0) {
        const volumeRatio = currentVolume / avgVolume;
        score += Math.min(15, (volumeRatio - 1) * 10);
      }
    }

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
