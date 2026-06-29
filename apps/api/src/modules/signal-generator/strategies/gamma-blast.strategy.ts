/**
 * Gamma Blast Strategy
 *
 * Momentum-acceleration strategy inspired by the "Gamma Blast Pro" PineScript
 * indicator. It measures the second derivative (gamma) of normalised price
 * changes, amplified by volume surge and volatility expansion, to detect
 * explosive directional moves early.
 *
 * A signal fires when the smoothed gamma-blast score crosses the acceleration
 * threshold, volume is surging above its average, and price is on the correct
 * side of VWAP — ensuring the move has institutional participation.
 *
 * Best suited for options, equity, and futures on 5m and 15m timeframes.
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

interface GammaBlastParameters {
  lookback: number;
  volThreshold: number;
  accelThreshold: number;
  stoplossATRMultiplier: number;
  targetATRMultiplier: number;
}

@Injectable()
export class GammaBlastStrategy implements TradingStrategy {
  readonly name = 'gamma-blast';
  readonly description =
    'Momentum-acceleration strategy using gamma proxy, volume surge, and volatility expansion with VWAP confirmation';
  readonly supportedSegments = ['OPTIONS', 'EQUITY', 'FUTURES'];
  readonly preferredTimeframes = ['5m', '15m'];

  private params: GammaBlastParameters = {
    lookback: 20,
    volThreshold: 2.0,
    accelThreshold: 1.5,
    stoplossATRMultiplier: 2.0,
    targetATRMultiplier: 4.0,
  };

  /**
   * Analyze current market snapshot for gamma-blast signals.
   *
   * Logic:
   * 1. Compute delta proxy (normalised price change) for each candle.
   * 2. Compute gamma proxy (rate of change of delta — acceleration).
   * 3. Measure volatility expansion (fast ATR / slow ATR).
   * 4. Measure volume surge (current volume / SMA of volume).
   * 5. Combine into a gamma-blast score, smoothed with EMA(3).
   * 6. BUY when smoothed score crosses above accelThreshold, volume surges
   *    above volThreshold, and close is above VWAP.
   * 7. SELL under the mirror conditions.
   * 8. Stoploss and target derived from ATR(14).
   *
   * @returns SignalOutput if conditions are met, null otherwise.
   */
  analyze(data: MarketSnapshot): SignalOutput | null {
    const { candles, ltp, symbol, exchange } = data;

    // Need enough candles for lookback + EMA smoothing + crossover detection
    const minCandles = this.params.lookback + 10;
    if (!candles || candles.length < minCandles) {
      return null;
    }

    // Guard against invalid price
    if (ltp <= 0) {
      return null;
    }

    // --- Step 1: Delta proxy series ---
    const deltaProxy = this.calculateDeltaProxySeries(candles);
    if (deltaProxy.length < 4) {
      return null;
    }

    // --- Step 2: Gamma proxy series (first difference of delta) ---
    const gammaProxy: number[] = [];
    for (let i = 1; i < deltaProxy.length; i++) {
      gammaProxy.push(deltaProxy[i] - deltaProxy[i - 1]);
    }
    if (gammaProxy.length < this.params.lookback) {
      return null;
    }

    // --- Step 3: Volatility expansion ---
    const atrFast = this.calculateATR(candles, 5);
    const atrSlow = this.calculateATR(candles, this.params.lookback);
    if (atrSlow <= 0 || atrFast <= 0) {
      return null;
    }
    const volExpansion = atrFast / atrSlow;

    // --- Step 4: Volume surge series ---
    const volumes = candles.map((c) => c.volume);
    const volSurgeSeries: number[] = [];
    for (let i = this.params.lookback; i < volumes.length; i++) {
      const avgVol = this.calculateSMA(
        volumes.slice(i - this.params.lookback, i),
        this.params.lookback,
      );
      volSurgeSeries.push(avgVol > 0 ? volumes[i] / avgVol : 0);
    }
    if (volSurgeSeries.length === 0) {
      return null;
    }

    const currentVolSurge = volSurgeSeries[volSurgeSeries.length - 1];

    // --- Step 5: Gamma blast score ---
    // Align gamma proxy and vol surge series from the end
    const alignedLength = Math.min(gammaProxy.length, volSurgeSeries.length);
    const gammaBlastScores: number[] = [];
    for (let i = 0; i < alignedLength; i++) {
      const gIdx = gammaProxy.length - alignedLength + i;
      const vIdx = volSurgeSeries.length - alignedLength + i;
      gammaBlastScores.push(
        gammaProxy[gIdx] * volSurgeSeries[vIdx] * volExpansion,
      );
    }

    if (gammaBlastScores.length < 4) {
      return null;
    }

    // Normalized score: EMA(gamma_blast_score, 3)
    const normalizedScores = this.calculateEMA(gammaBlastScores, 3);
    if (normalizedScores.length < 2) {
      return null;
    }

    const currentScore = normalizedScores[normalizedScores.length - 1];
    const previousScore = normalizedScores[normalizedScores.length - 2];

    // --- Step 6: VWAP ---
    const vwap = this.calculateVWAP(candles);
    const currentClose = candles[candles.length - 1].close;

    // --- Step 7: Signal conditions ---
    const atr14 = this.calculateATR(candles, 14);
    if (atr14 <= 0) {
      return null;
    }

    const bullishCross = this.detectCrossover(
      currentScore,
      previousScore,
      this.params.accelThreshold,
    );
    const bearishCross = this.detectCrossunder(
      currentScore,
      previousScore,
      -this.params.accelThreshold,
    );

    // BUY signal
    if (
      bullishCross &&
      currentVolSurge > this.params.volThreshold &&
      currentClose > vwap
    ) {
      const confidence = this.calculateConfidence(
        currentScore,
        this.params.accelThreshold,
        currentVolSurge,
        currentClose,
        vwap,
        'BUY',
      );
      const stoploss = ltp - atr14 * this.params.stoplossATRMultiplier;
      const target = ltp + atr14 * this.params.targetATRMultiplier;

      return {
        symbol,
        exchange,
        side: 'BUY',
        entryPrice: ltp,
        targetPrice: Math.round(target * 100) / 100,
        stoplossPrice: Math.round(stoploss * 100) / 100,
        confidence,
        reason: `Gamma blast score crossed above ${this.params.accelThreshold} (score: ${currentScore.toFixed(2)}). Volume surge ${currentVolSurge.toFixed(1)}x avg. Price above VWAP (${vwap.toFixed(2)}).`,
        timeframe: this.preferredTimeframes[0],
        metadata: {
          gammaBlastScore: Math.round(currentScore * 100) / 100,
          previousScore: Math.round(previousScore * 100) / 100,
          volSurge: Math.round(currentVolSurge * 100) / 100,
          volExpansion: Math.round(volExpansion * 100) / 100,
          vwap: Math.round(vwap * 100) / 100,
          atr: Math.round(atr14 * 100) / 100,
          strategy: this.name,
        },
      };
    }

    // SELL signal
    if (
      bearishCross &&
      currentVolSurge > this.params.volThreshold &&
      currentClose < vwap
    ) {
      const confidence = this.calculateConfidence(
        currentScore,
        this.params.accelThreshold,
        currentVolSurge,
        currentClose,
        vwap,
        'SELL',
      );
      const stoploss = ltp + atr14 * this.params.stoplossATRMultiplier;
      const target = ltp - atr14 * this.params.targetATRMultiplier;

      return {
        symbol,
        exchange,
        side: 'SELL',
        entryPrice: ltp,
        targetPrice: Math.round(target * 100) / 100,
        stoplossPrice: Math.round(stoploss * 100) / 100,
        confidence,
        reason: `Gamma blast score crossed below -${this.params.accelThreshold} (score: ${currentScore.toFixed(2)}). Volume surge ${currentVolSurge.toFixed(1)}x avg. Price below VWAP (${vwap.toFixed(2)}).`,
        timeframe: this.preferredTimeframes[0],
        metadata: {
          gammaBlastScore: Math.round(currentScore * 100) / 100,
          previousScore: Math.round(previousScore * 100) / 100,
          volSurge: Math.round(currentVolSurge * 100) / 100,
          volExpansion: Math.round(volExpansion * 100) / 100,
          vwap: Math.round(vwap * 100) / 100,
          atr: Math.round(atr14 * 100) / 100,
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
   * built and analyze() is called. Open trades are exited when price hits
   * target, stoploss, or after 20 candles (timeout).
   */
  backtest(input: BacktestInput): BacktestResult {
    const { candles, initialCapital, positionSize } = input;
    const trades: BacktestTrade[] = [];
    const minCandles = this.params.lookback + 10;
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
    if (params.lookback !== undefined) this.params.lookback = Number(params.lookback);
    if (params.volThreshold !== undefined) this.params.volThreshold = Number(params.volThreshold);
    if (params.accelThreshold !== undefined)
      this.params.accelThreshold = Number(params.accelThreshold);
    if (params.stoplossATRMultiplier !== undefined)
      this.params.stoplossATRMultiplier = Number(params.stoplossATRMultiplier);
    if (params.targetATRMultiplier !== undefined)
      this.params.targetATRMultiplier = Number(params.targetATRMultiplier);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Calculate the delta proxy series for all candles.
   *
   * Delta proxy is a normalised measure of price change:
   *   delta_proxy[i] = (close[i] - close[i-1]) / max(high[i-1] - low[i-1], 0.01)
   *
   * This normalises the raw price change by the previous bar's range,
   * making the value comparable across different price levels.
   *
   * @returns Array of delta proxy values, one per candle starting from index 1.
   */
  private calculateDeltaProxySeries(candles: CandleData[]): number[] {
    const deltas: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const priceChange = candles[i].close - candles[i - 1].close;
      const prevRange = Math.max(candles[i - 1].high - candles[i - 1].low, 0.01);
      deltas.push(priceChange / prevRange);
    }
    return deltas;
  }

  /**
   * Average True Range over the given period using Wilder smoothing.
   *
   * True Range = max(high - low, |high - prevClose|, |low - prevClose|).
   * The first ATR is seeded with the SMA of the first `period` TR values,
   * then smoothed using Wilder's method for subsequent bars.
   *
   * @param candles - Array of candle data (must have at least period + 1 elements).
   * @param period  - Lookback period for the ATR calculation.
   * @returns The final ATR value, or 0 if insufficient data.
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

    // Seed with SMA of first `period` TR values
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

  /**
   * Simple Moving Average of an array of numbers.
   *
   * Returns a single value — the arithmetic mean of the last `period`
   * elements. If fewer values than the period are available, all values
   * are averaged.
   *
   * @param values - Array of numerical values.
   * @param period - Number of values to average.
   * @returns The SMA value, or 0 for an empty array.
   */
  private calculateSMA(values: number[], period: number): number {
    if (values.length === 0) return 0;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  /**
   * Calculate Exponential Moving Average series from an array of values.
   *
   * The first EMA value is seeded with the SMA of the first `period` values.
   * Subsequent values use the standard EMA formula:
   *   EMA_t = value * k + EMA_{t-1} * (1 - k)
   *   where k = 2 / (period + 1)
   *
   * @param values - Array of numerical values.
   * @param period - EMA period.
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
   * Calculate Volume Weighted Average Price (VWAP) for a session.
   *
   * VWAP = cumulative(typical_price * volume) / cumulative(volume)
   * where typical_price = (high + low + close) / 3.
   *
   * Uses all provided candles as the session window.
   *
   * @param candles - Array of candle data for the session.
   * @returns The VWAP value, or the last close if volume is zero.
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
      return candles[candles.length - 1].close;
    }

    return cumulativeTPV / cumulativeVolume;
  }

  /**
   * Detect a bullish crossover: value crosses above a threshold.
   *
   * A crossover occurs when the previous value was at or below the
   * threshold and the current value is strictly above it.
   *
   * @param current   - Current bar's value.
   * @param previous  - Previous bar's value.
   * @param threshold - The level to cross above.
   * @returns True if a crossover occurred.
   */
  private detectCrossover(
    current: number,
    previous: number,
    threshold: number,
  ): boolean {
    return previous <= threshold && current > threshold;
  }

  /**
   * Detect a bearish crossunder: value crosses below a threshold.
   *
   * A crossunder occurs when the previous value was at or above the
   * threshold and the current value is strictly below it.
   *
   * @param current   - Current bar's value.
   * @param previous  - Previous bar's value.
   * @param threshold - The level to cross below.
   * @returns True if a crossunder occurred.
   */
  private detectCrossunder(
    current: number,
    previous: number,
    threshold: number,
  ): boolean {
    return previous >= threshold && current < threshold;
  }

  /**
   * Confidence score (0-100) based on three components:
   *
   * 1. **Gamma intensity** (up to 25 points): How far the gamma-blast score
   *    exceeds the acceleration threshold — stronger acceleration = higher
   *    confidence.
   * 2. **Volume surge strength** (up to 20 points): How much current volume
   *    exceeds the volThreshold — heavier volume = more conviction.
   * 3. **VWAP alignment strength** (up to 15 points): How far price is on
   *    the correct side of VWAP — deeper alignment = stronger institutional
   *    participation signal.
   *
   * Base score: 40.
   *
   * @returns Confidence score clamped to 0-100.
   */
  private calculateConfidence(
    gammaScore: number,
    accelThreshold: number,
    volSurge: number,
    close: number,
    vwap: number,
    side: 'BUY' | 'SELL',
  ): number {
    let score = 40; // base

    // Gamma intensity: how far above/below threshold (up to 25 points)
    const gammaExcess = Math.abs(gammaScore) - accelThreshold;
    score += Math.min(25, Math.max(0, gammaExcess * 10));

    // Volume surge strength (up to 20 points)
    const volExcess = volSurge - this.params.volThreshold;
    score += Math.min(20, Math.max(0, volExcess * 10));

    // VWAP alignment strength (up to 15 points)
    if (vwap > 0) {
      const vwapDistance = Math.abs(close - vwap) / vwap * 100;
      if (side === 'BUY' && close > vwap) {
        score += Math.min(15, vwapDistance * 5);
      } else if (side === 'SELL' && close < vwap) {
        score += Math.min(15, vwapDistance * 5);
      }
    }

    return Math.round(Math.max(0, Math.min(100, score)));
  }

  /**
   * Annualized Sharpe ratio from trade PnLs.
   *
   * Computed as (mean_pnl / std_pnl) * sqrt(252), assuming roughly 252
   * trading days per year. Returns 0 if fewer than 2 trades or zero
   * standard deviation.
   */
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
