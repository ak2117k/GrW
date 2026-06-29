/**
 * EMA Crossover Strategy
 *
 * Classic trend-following strategy that generates signals when a fast EMA
 * crosses over a slow EMA, filtered by a longer signal EMA for overall trend
 * direction and confirmed by above-average volume.
 *
 * Best suited for equity and futures on 5m, 15m, and 1h timeframes.
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

interface EmaCrossoverParameters {
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
  volumeMultiplier: number;
  stoplossATRMultiplier: number;
  targetATRMultiplier: number;
}

@Injectable()
export class EmaCrossoverStrategy implements TradingStrategy {
  readonly name = 'ema-crossover';
  readonly description =
    'Trend following strategy using EMA crossovers with volume confirmation';
  readonly supportedSegments = ['EQUITY', 'FUTURES', 'OPTIONS'];
  readonly preferredTimeframes = ['5m', '15m', '1h'];

  private params: EmaCrossoverParameters = {
    fastPeriod: 9,
    slowPeriod: 21,
    signalPeriod: 50,
    volumeMultiplier: 1.5,
    stoplossATRMultiplier: 2.0,
    targetATRMultiplier: 4.0,
  };

  /**
   * Analyze current market snapshot for EMA crossover signals.
   *
   * Logic:
   * 1. Compute fast EMA, slow EMA, and signal EMA on close prices.
   * 2. BUY when fast crosses above slow, price is above signal EMA, and
   *    volume exceeds the 20-bar average times the volume multiplier.
   * 3. SELL under the mirror conditions.
   * 4. Stoploss and target derived from ATR(14).
   */
  analyze(data: MarketSnapshot): SignalOutput | null {
    const { candles, ltp, symbol, exchange } = data;

    // Need enough candles for the longest EMA plus one bar for crossover detection
    const minCandles = this.params.signalPeriod + 2;
    if (!candles || candles.length < minCandles) {
      return null;
    }

    if (ltp <= 0) {
      return null;
    }

    const closes = candles.map((c) => c.close);

    const fastEMA = this.calculateEMA(closes, this.params.fastPeriod);
    const slowEMA = this.calculateEMA(closes, this.params.slowPeriod);
    const signalEMA = this.calculateEMA(closes, this.params.signalPeriod);

    // We need at least 2 values from each to check crossover
    if (fastEMA.length < 2 || slowEMA.length < 2 || signalEMA.length < 1) {
      return null;
    }

    // Align arrays to the same end index
    const currentFast = fastEMA[fastEMA.length - 1];
    const previousFast = fastEMA[fastEMA.length - 2];
    const currentSlow = slowEMA[slowEMA.length - 1];
    const previousSlow = slowEMA[slowEMA.length - 2];
    const currentSignal = signalEMA[signalEMA.length - 1];

    // Volume confirmation
    const volumeAvg = this.calculateSMA(
      candles.slice(-20).map((c) => c.volume),
      20,
    );
    const currentVolume = candles[candles.length - 1].volume;
    const volumeConfirmed =
      volumeAvg > 0 && currentVolume >= volumeAvg * this.params.volumeMultiplier;

    const atr = this.calculateATR(candles, 14);
    if (atr <= 0) {
      return null;
    }

    // Bullish crossover: fast crosses above slow
    const bullishCross = previousFast < previousSlow && currentFast > currentSlow;
    // Bearish crossover: fast crosses below slow
    const bearishCross = previousFast > previousSlow && currentFast < currentSlow;

    if (bullishCross && ltp > currentSignal && volumeConfirmed) {
      const stoploss = ltp - atr * this.params.stoplossATRMultiplier;
      const target = ltp + atr * this.params.targetATRMultiplier;
      const confidence = this.calculateConfidence(
        currentFast,
        currentSlow,
        currentSignal,
        currentVolume,
        volumeAvg,
        'BUY',
      );

      return {
        symbol,
        exchange,
        side: 'BUY',
        entryPrice: ltp,
        targetPrice: Math.round(target * 100) / 100,
        stoplossPrice: Math.round(stoploss * 100) / 100,
        confidence,
        reason: `Fast EMA(${this.params.fastPeriod}) crossed above Slow EMA(${this.params.slowPeriod}) with price above Signal EMA(${this.params.signalPeriod}). Volume ${(currentVolume / volumeAvg).toFixed(1)}x average.`,
        timeframe: this.preferredTimeframes[0],
        metadata: {
          fastEMA: Math.round(currentFast * 100) / 100,
          slowEMA: Math.round(currentSlow * 100) / 100,
          signalEMA: Math.round(currentSignal * 100) / 100,
          volumeRatio: Math.round((currentVolume / volumeAvg) * 100) / 100,
          atr: Math.round(atr * 100) / 100,
          strategy: this.name,
        },
      };
    }

    if (bearishCross && ltp < currentSignal && volumeConfirmed) {
      const stoploss = ltp + atr * this.params.stoplossATRMultiplier;
      const target = ltp - atr * this.params.targetATRMultiplier;
      const confidence = this.calculateConfidence(
        currentFast,
        currentSlow,
        currentSignal,
        currentVolume,
        volumeAvg,
        'SELL',
      );

      return {
        symbol,
        exchange,
        side: 'SELL',
        entryPrice: ltp,
        targetPrice: Math.round(target * 100) / 100,
        stoplossPrice: Math.round(stoploss * 100) / 100,
        confidence,
        reason: `Fast EMA(${this.params.fastPeriod}) crossed below Slow EMA(${this.params.slowPeriod}) with price below Signal EMA(${this.params.signalPeriod}). Volume ${(currentVolume / volumeAvg).toFixed(1)}x average.`,
        timeframe: this.preferredTimeframes[0],
        metadata: {
          fastEMA: Math.round(currentFast * 100) / 100,
          slowEMA: Math.round(currentSlow * 100) / 100,
          signalEMA: Math.round(currentSignal * 100) / 100,
          volumeRatio: Math.round((currentVolume / volumeAvg) * 100) / 100,
          atr: Math.round(atr * 100) / 100,
          strategy: this.name,
        },
      };
    }

    return null;
  }

  /**
   * Walk-forward backtest over historical candle data.
   *
   * At each bar past the minimum lookback, a synthetic MarketSnapshot is
   * built and analyze() is called. Trades are exited at target, stoploss,
   * or after 20 bars.
   */
  backtest(input: BacktestInput): BacktestResult {
    const { candles, initialCapital, positionSize } = input;
    const trades: BacktestTrade[] = [];
    const minCandles = this.params.signalPeriod + 2;
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
    if (params.fastPeriod !== undefined) this.params.fastPeriod = Number(params.fastPeriod);
    if (params.slowPeriod !== undefined) this.params.slowPeriod = Number(params.slowPeriod);
    if (params.signalPeriod !== undefined) this.params.signalPeriod = Number(params.signalPeriod);
    if (params.volumeMultiplier !== undefined)
      this.params.volumeMultiplier = Number(params.volumeMultiplier);
    if (params.stoplossATRMultiplier !== undefined)
      this.params.stoplossATRMultiplier = Number(params.stoplossATRMultiplier);
    if (params.targetATRMultiplier !== undefined)
      this.params.targetATRMultiplier = Number(params.targetATRMultiplier);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Calculate Exponential Moving Average series from an array of values.
   *
   * The first EMA value is seeded with the SMA of the first `period` values.
   * Subsequent values use the standard EMA formula:
   *   EMA_t = value * k + EMA_{t-1} * (1 - k)
   *   where k = 2 / (period + 1)
   *
   * @returns Array of EMA values, starting from index `period - 1`.
   */
  private calculateEMA(values: number[], period: number): number[] {
    if (values.length < period) {
      return [];
    }

    const k = 2 / (period + 1);
    const emaValues: number[] = [];

    // Seed with SMA
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
   * Simple Moving Average of an array of numbers.
   * Returns a single value (the average). If there are fewer values than
   * the period, uses all available values.
   */
  private calculateSMA(values: number[], period: number): number {
    if (values.length === 0) return 0;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  /** Average True Range over the given period (Wilder smoothing). */
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
   * - Gap between fast and slow EMA (wider separation = stronger momentum).
   * - Volume surge magnitude.
   * - Alignment with signal EMA (how far price is into the trend).
   */
  private calculateConfidence(
    fastEMA: number,
    slowEMA: number,
    signalEMA: number,
    volume: number,
    avgVolume: number,
    side: 'BUY' | 'SELL',
  ): number {
    let score = 40; // base

    // EMA gap component (normalised to slow EMA to get a percentage)
    const gapPercent = Math.abs(fastEMA - slowEMA) / slowEMA * 100;
    score += Math.min(25, gapPercent * 10);

    // Volume surge component
    if (avgVolume > 0) {
      const volumeRatio = volume / avgVolume;
      score += Math.min(20, (volumeRatio - 1) * 8);
    }

    // Signal EMA alignment: how far price is on the right side
    if (side === 'BUY') {
      const alignPercent = ((fastEMA - signalEMA) / signalEMA) * 100;
      score += Math.min(15, Math.max(0, alignPercent * 5));
    } else {
      const alignPercent = ((signalEMA - fastEMA) / signalEMA) * 100;
      score += Math.min(15, Math.max(0, alignPercent * 5));
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
