/**
 * RSI Reversal Strategy
 *
 * Mean reversion strategy that detects oversold/overbought RSI conditions.
 * When RSI crosses back from extreme zones with candle confirmation,
 * it generates a signal expecting price to revert toward the mean.
 *
 * Best suited for options and swing trading on 15m, 1h, and daily timeframes.
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

interface RsiReversalParameters {
  rsiPeriod: number;
  oversoldLevel: number;
  overboughtLevel: number;
  confirmationCandles: number;
  stoplossATRMultiplier: number;
  targetATRMultiplier: number;
}

@Injectable()
export class RsiReversalStrategy implements TradingStrategy {
  readonly name = 'rsi-reversal';
  readonly description =
    'Mean reversion strategy using RSI oversold/overbought zones with confirmation';
  readonly supportedSegments = ['OPTIONS', 'EQUITY', 'FUTURES'];
  readonly preferredTimeframes = ['15m', '1h', '1d'];

  private params: RsiReversalParameters = {
    rsiPeriod: 14,
    oversoldLevel: 30,
    overboughtLevel: 70,
    confirmationCandles: 2,
    stoplossATRMultiplier: 1.5,
    targetATRMultiplier: 3.0,
  };

  /**
   * Analyze current market snapshot for RSI reversal signals.
   *
   * Logic:
   * 1. Compute RSI over the configured period.
   * 2. Detect crossover above oversold or below overbought level.
   * 3. Require N consecutive confirmation candles in the reversal direction.
   * 4. Derive stoploss and target from ATR(14).
   *
   * @returns SignalOutput if conditions are met, null otherwise.
   */
  analyze(data: MarketSnapshot): SignalOutput | null {
    const { candles, ltp, symbol, exchange } = data;
    const minCandles = this.params.rsiPeriod + this.params.confirmationCandles + 10;

    if (!candles || candles.length < minCandles) {
      return null;
    }

    // Guard against invalid price
    if (ltp <= 0) {
      return null;
    }

    const rsiValues = this.calculateRSISeries(candles, this.params.rsiPeriod);
    if (rsiValues.length < 2) {
      return null;
    }

    const currentRSI = rsiValues[rsiValues.length - 1];
    const previousRSI = rsiValues[rsiValues.length - 2];
    const atr = this.calculateATR(candles, 14);

    if (atr <= 0) {
      return null;
    }

    const recentCandles = candles.slice(-this.params.confirmationCandles);

    // BUY: RSI crosses above oversoldLevel from below
    const bullishCross =
      previousRSI < this.params.oversoldLevel && currentRSI >= this.params.oversoldLevel;

    // SELL: RSI crosses below overboughtLevel from above
    const bearishCross =
      previousRSI > this.params.overboughtLevel && currentRSI <= this.params.overboughtLevel;

    if (bullishCross && recentCandles.every((c) => this.isGreenCandle(c))) {
      const confidence = this.calculateConfidence(rsiValues, 'BUY', candles);
      const stoploss = ltp - atr * this.params.stoplossATRMultiplier;
      const target = ltp + atr * this.params.targetATRMultiplier;

      return {
        symbol,
        exchange,
        side: 'BUY',
        entryPrice: ltp,
        targetPrice: Math.round(target * 100) / 100,
        stoplossPrice: Math.round(stoploss * 100) / 100,
        confidence,
        reason: `RSI crossed above ${this.params.oversoldLevel} from ${previousRSI.toFixed(1)} with ${this.params.confirmationCandles} green confirmation candles`,
        timeframe: this.preferredTimeframes[0],
        metadata: {
          rsi: Math.round(currentRSI * 100) / 100,
          previousRsi: Math.round(previousRSI * 100) / 100,
          atr: Math.round(atr * 100) / 100,
          strategy: this.name,
        },
      };
    }

    if (bearishCross && recentCandles.every((c) => this.isRedCandle(c))) {
      const confidence = this.calculateConfidence(rsiValues, 'SELL', candles);
      const stoploss = ltp + atr * this.params.stoplossATRMultiplier;
      const target = ltp - atr * this.params.targetATRMultiplier;

      return {
        symbol,
        exchange,
        side: 'SELL',
        entryPrice: ltp,
        targetPrice: Math.round(target * 100) / 100,
        stoplossPrice: Math.round(stoploss * 100) / 100,
        confidence,
        reason: `RSI crossed below ${this.params.overboughtLevel} from ${previousRSI.toFixed(1)} with ${this.params.confirmationCandles} red confirmation candles`,
        timeframe: this.preferredTimeframes[0],
        metadata: {
          rsi: Math.round(currentRSI * 100) / 100,
          previousRsi: Math.round(previousRSI * 100) / 100,
          atr: Math.round(atr * 100) / 100,
          strategy: this.name,
        },
      };
    }

    return null;
  }

  /**
   * Walk-forward backtest over historical candles.
   *
   * At each bar (starting from the minimum lookback), builds a synthetic
   * MarketSnapshot and calls analyze(). Open trades are exited when price
   * hits target, stoploss, or after 20 candles (timeout).
   */
  backtest(input: BacktestInput): BacktestResult {
    const { candles, initialCapital, positionSize } = input;
    const trades: BacktestTrade[] = [];
    const minCandles = this.params.rsiPeriod + this.params.confirmationCandles + 10;
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

        // Walk forward to find exit
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

        // positionSize = number of lots, each lot = 1 unit for backtest
        // For indices like NIFTY, 1 lot = 50 qty; we use positionSize directly as qty
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
    if (params.rsiPeriod !== undefined) this.params.rsiPeriod = Number(params.rsiPeriod);
    if (params.oversoldLevel !== undefined) this.params.oversoldLevel = Number(params.oversoldLevel);
    if (params.overboughtLevel !== undefined)
      this.params.overboughtLevel = Number(params.overboughtLevel);
    if (params.confirmationCandles !== undefined)
      this.params.confirmationCandles = Number(params.confirmationCandles);
    if (params.stoplossATRMultiplier !== undefined)
      this.params.stoplossATRMultiplier = Number(params.stoplossATRMultiplier);
    if (params.targetATRMultiplier !== undefined)
      this.params.targetATRMultiplier = Number(params.targetATRMultiplier);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Calculate the RSI value for the last candle.
   * Uses the standard Wilder smoothing method (exponential moving average of
   * gains and losses).
   */
  private calculateRSI(candles: CandleData[], period: number): number {
    const series = this.calculateRSISeries(candles, period);
    return series.length > 0 ? series[series.length - 1] : 50;
  }

  /**
   * Calculate a full RSI series so we can detect crossovers.
   * Returns one RSI value per candle starting from index `period`.
   */
  private calculateRSISeries(candles: CandleData[], period: number): number[] {
    if (candles.length < period + 1) {
      return [];
    }

    const closes = candles.map((c) => c.close);
    const deltas: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      deltas.push(closes[i] - closes[i - 1]);
    }

    // Seed with SMA of first `period` deltas
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < period; i++) {
      if (deltas[i] > 0) avgGain += deltas[i];
      else avgLoss += Math.abs(deltas[i]);
    }
    avgGain /= period;
    avgLoss /= period;

    const rsiValues: number[] = [];
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));

    // Wilder smoothing for remaining values
    for (let i = period; i < deltas.length; i++) {
      const gain = deltas[i] > 0 ? deltas[i] : 0;
      const loss = deltas[i] < 0 ? Math.abs(deltas[i]) : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;

      const currentRS = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsiValues.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + currentRS));
    }

    return rsiValues;
  }

  /**
   * Average True Range over the given period.
   * True Range = max(high-low, |high-prevClose|, |low-prevClose|).
   */
  private calculateATR(candles: CandleData[], period: number): number {
    if (candles.length < period + 1) {
      return 0;
    }

    const trValues: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;

      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trValues.push(tr);
    }

    // Start with SMA of first `period` TR values
    let atr = 0;
    for (let i = 0; i < period; i++) {
      atr += trValues[i];
    }
    atr /= period;

    // Wilder smoothing
    for (let i = period; i < trValues.length; i++) {
      atr = (atr * (period - 1) + trValues[i]) / period;
    }

    return atr;
  }

  /** A green (bullish) candle has close strictly above open. */
  private isGreenCandle(candle: CandleData): boolean {
    return candle.close > candle.open;
  }

  /** A red (bearish) candle has close strictly below open. */
  private isRedCandle(candle: CandleData): boolean {
    return candle.close < candle.open;
  }

  /**
   * Confidence score (0-100) based on:
   * - Depth of RSI excursion into the extreme zone (deeper = more confident).
   * - Volume surge relative to 20-bar average.
   */
  private calculateConfidence(
    rsiValues: number[],
    side: 'BUY' | 'SELL',
    candles: CandleData[],
  ): number {
    let score = 50; // base

    // Find the most extreme RSI in the recent lookback (last 10 values)
    const recentRSI = rsiValues.slice(-10);

    if (side === 'BUY') {
      const minRSI = Math.min(...recentRSI);
      // RSI 10 is more extreme than RSI 28 — scale linearly
      const depthScore = Math.max(
        0,
        ((this.params.oversoldLevel - minRSI) / this.params.oversoldLevel) * 30,
      );
      score += depthScore;
    } else {
      const maxRSI = Math.max(...recentRSI);
      const depthScore = Math.max(
        0,
        ((maxRSI - this.params.overboughtLevel) / (100 - this.params.overboughtLevel)) * 30,
      );
      score += depthScore;
    }

    // Volume surge component
    if (candles.length >= 20) {
      const recentVolumes = candles.slice(-20).map((c) => c.volume);
      const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
      const currentVolume = candles[candles.length - 1].volume;

      if (avgVolume > 0) {
        const volumeRatio = currentVolume / avgVolume;
        score += Math.min(20, (volumeRatio - 1) * 10);
      }
    }

    return Math.round(Math.max(0, Math.min(100, score)));
  }

  /**
   * Annualized Sharpe ratio from trade PnLs.
   * Assumes roughly 252 trading days.
   */
  private calculateSharpeRatio(trades: BacktestTrade[]): number {
    if (trades.length < 2) {
      return 0;
    }

    const returns = trades.map((t) => t.pnl);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) {
      return 0;
    }

    return (mean / stdDev) * Math.sqrt(252);
  }
}
