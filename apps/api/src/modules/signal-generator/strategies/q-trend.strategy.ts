/**
 * Q-Trend Strategy
 *
 * Adaptive trend-following strategy based on the Q-Trend PineScript indicator.
 * It builds a dynamic midline from the highest/lowest range over a long lookback
 * period and uses ATR-based epsilon bands to filter noise. Signals fire only on
 * confirmed state changes (crossover/crossunder of the midline +/- epsilon),
 * with extra conviction from strong buy/sell zones near price extremes.
 *
 * Best suited for options, equity, and futures on 15m, 1h, and daily timeframes.
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

interface QTrendParameters {
  period: number;
  atrPeriod: number;
  mult: number;
  useEmaSmooth: boolean;
  emaPeriod: number;
  stoplossATRMultiplier: number;
  targetATRMultiplier: number;
}

@Injectable()
export class QTrendStrategy implements TradingStrategy {
  readonly name = 'q-trend';
  readonly description =
    'Adaptive trend strategy using dynamic midline with ATR-based epsilon bands and strong buy/sell zone detection';
  readonly supportedSegments = ['OPTIONS', 'EQUITY', 'FUTURES'];
  readonly preferredTimeframes = ['15m', '1h', '1d'];

  private params: QTrendParameters = {
    period: 200,
    atrPeriod: 40,
    mult: 1.0,
    useEmaSmooth: false,
    emaPeriod: 10,
    stoplossATRMultiplier: 2.0,
    targetATRMultiplier: 4.0,
  };

  /**
   * Analyze current market snapshot for Q-Trend signals.
   *
   * Logic:
   * 1. Optionally smooth close prices with an EMA.
   * 2. Compute highest/lowest over the lookback period to define the range.
   * 3. Build a dynamic midline that shifts by ATR-based epsilon on crossovers.
   * 4. Track state (B/S) and fire signals only on state transitions.
   * 5. Add confidence from strong buy/sell zones, price distance, volume, ATR expansion.
   *
   * @returns SignalOutput if a state change is detected, null otherwise.
   */
  analyze(data: MarketSnapshot): SignalOutput | null {
    const { candles, ltp, symbol, exchange } = data;

    // Need enough candles for the period + ATR + smoothing buffer
    const minCandles = this.params.period + this.params.atrPeriod + 10;
    if (!candles || candles.length < minCandles) {
      return null;
    }

    if (ltp <= 0) {
      return null;
    }

    // Step 1: Compute effective source (optionally EMA-smoothed closes)
    const closes = candles.map((c) => c.close);
    let effectiveSrc: number[];
    if (this.params.useEmaSmooth) {
      effectiveSrc = this.calculateEMA(closes, this.params.emaPeriod);
      if (effectiveSrc.length < this.params.period + 2) {
        return null;
      }
    } else {
      effectiveSrc = closes;
    }

    // Step 2: Compute ATR series for epsilon calculation
    const atrSeries = this.calculateATRSeries(candles, this.params.atrPeriod);
    if (atrSeries.length < 2) {
      return null;
    }

    // Step 3: Walk through sufficient history to establish midline state
    // We need to align effectiveSrc and atrSeries to common indices.
    // effectiveSrc starts from index (emaPeriod - 1) if smoothed, or 0 if not.
    // atrSeries starts from index atrPeriod (since TR starts at index 1, SMA needs atrPeriod values).
    // We walk from the point where both are available plus enough for highest/lowest.

    const srcOffset = this.params.useEmaSmooth ? this.params.emaPeriod - 1 : 0;
    const atrOffset = this.params.atrPeriod; // atrSeries[0] corresponds to candle index atrPeriod

    // The earliest bar index (in candle terms) where we have both src and ATR
    const startCandleIdx = Math.max(srcOffset + this.params.period - 1, atrOffset + 1);

    if (startCandleIdx >= candles.length) {
      return null;
    }

    // Walk forward to build midline state
    let m = 0;
    let prevM = 0;
    let state: 'B' | 'S' | 'N' = 'N';
    let prevState: 'B' | 'S' | 'N' = 'N';
    let prevSrcValue = 0;
    let initialized = false;

    for (let ci = startCandleIdx; ci < candles.length; ci++) {
      // Map candle index to effectiveSrc index
      const srcIdx = ci - srcOffset;
      if (srcIdx < 0 || srcIdx >= effectiveSrc.length) continue;

      const currentSrc = effectiveSrc[srcIdx];

      // Highest/lowest over period in effectiveSrc ending at srcIdx
      const windowStart = Math.max(0, srcIdx - this.params.period + 1);
      const srcWindow = effectiveSrc.slice(windowStart, srcIdx + 1);
      const h = Math.max(...srcWindow);
      const l = Math.min(...srcWindow);
      const d = h - l;

      // ATR: use previous bar's ATR value
      const atrIdx = ci - 1 - atrOffset;
      if (atrIdx < 0 || atrIdx >= atrSeries.length) continue;
      const atrVal = atrSeries[atrIdx];
      const epsilon = this.params.mult * atrVal;

      if (!initialized) {
        m = (h + l) / 2;
        prevM = m;
        prevSrcValue = currentSrc;
        initialized = true;
        continue;
      }

      // Crossover / crossunder detection
      const changeUp =
        this.detectCrossover(currentSrc, prevSrcValue, m + epsilon) ||
        currentSrc > m + epsilon;
      const changeDown =
        this.detectCrossunder(currentSrc, prevSrcValue, m - epsilon) ||
        currentSrc < m - epsilon;

      // Midline update (Type A mode)
      const newMidCandidate = (h + l) / 2;
      prevM = m;

      if ((changeUp || changeDown) && newMidCandidate !== prevM) {
        m = newMidCandidate;
      } else if (changeUp) {
        m = prevM + epsilon;
      } else if (changeDown) {
        m = prevM - epsilon;
      } else {
        m = prevM;
      }

      // Track state
      prevState = state;
      if (changeUp) {
        state = 'B';
      } else if (changeDown) {
        state = 'S';
      }
      // else state stays the same

      prevSrcValue = currentSrc;
    }

    // Now check the final bar for signal generation
    const lastSrcIdx = candles.length - 1 - srcOffset;
    if (lastSrcIdx < 0 || lastSrcIdx >= effectiveSrc.length) return null;
    const currentSrc = effectiveSrc[lastSrcIdx];

    // Re-derive values for the last bar
    const lastAtrIdx = candles.length - 2 - atrOffset;
    if (lastAtrIdx < 0 || lastAtrIdx >= atrSeries.length) return null;
    const currentATR = atrSeries[lastAtrIdx];
    const epsilon = this.params.mult * currentATR;

    // Get second-to-last source for crossover detection on final bar
    const prevSrcIdx = lastSrcIdx - 1;
    if (prevSrcIdx < 0) return null;
    const prevSrc = effectiveSrc[prevSrcIdx];

    const finalChangeUp = this.detectCrossover(currentSrc, prevSrc, m + epsilon);
    const finalChangeDown = this.detectCrossunder(currentSrc, prevSrc, m - epsilon);

    // Strong buy/sell zone detection (look back 5 bars)
    const recentCandles = candles.slice(-5);
    const windowStart = Math.max(0, lastSrcIdx - this.params.period + 1);
    const srcWindow = effectiveSrc.slice(windowStart, lastSrcIdx + 1);
    const h = Math.max(...srcWindow);
    const l = Math.min(...srcWindow);
    const d = h - l;

    const strongBuy = recentCandles.some(
      (c) => c.open < l + d / 8 && c.open >= l,
    );
    const strongSell = recentCandles.some(
      (c) => c.open > h - d / 8 && c.open <= h,
    );

    // BUY signal: crossover above m + epsilon AND previous state was not B
    if (finalChangeUp && prevState !== 'B') {
      const confidence = this.calculateConfidence(
        currentSrc,
        m,
        epsilon,
        strongBuy,
        candles,
        currentATR,
      );

      // Stoploss at midline; if too close, use ATR-based
      let stoploss = m;
      if (Math.abs(ltp - stoploss) < currentATR * 0.5) {
        stoploss = ltp - currentATR * this.params.stoplossATRMultiplier;
      }
      const target = ltp + currentATR * this.params.targetATRMultiplier;

      return {
        symbol,
        exchange,
        side: 'BUY',
        entryPrice: ltp,
        targetPrice: Math.round(target * 100) / 100,
        stoplossPrice: Math.round(stoploss * 100) / 100,
        confidence,
        reason: `Q-Trend state changed to BUY — price crossed above midline(${m.toFixed(2)}) + epsilon(${epsilon.toFixed(2)})${strongBuy ? ' in strong buy zone' : ''}`,
        timeframe: this.preferredTimeframes[0],
        metadata: {
          midline: Math.round(m * 100) / 100,
          epsilon: Math.round(epsilon * 100) / 100,
          atr: Math.round(currentATR * 100) / 100,
          highest: Math.round(h * 100) / 100,
          lowest: Math.round(l * 100) / 100,
          strongBuy,
          strongSell,
          state,
          strategy: this.name,
        },
      };
    }

    // SELL signal: crossunder below m - epsilon AND previous state was not S
    if (finalChangeDown && prevState !== 'S') {
      const confidence = this.calculateConfidence(
        currentSrc,
        m,
        epsilon,
        strongSell,
        candles,
        currentATR,
      );

      let stoploss = m;
      if (Math.abs(stoploss - ltp) < currentATR * 0.5) {
        stoploss = ltp + currentATR * this.params.stoplossATRMultiplier;
      }
      const target = ltp - currentATR * this.params.targetATRMultiplier;

      return {
        symbol,
        exchange,
        side: 'SELL',
        entryPrice: ltp,
        targetPrice: Math.round(target * 100) / 100,
        stoplossPrice: Math.round(stoploss * 100) / 100,
        confidence,
        reason: `Q-Trend state changed to SELL — price crossed below midline(${m.toFixed(2)}) - epsilon(${epsilon.toFixed(2)})${strongSell ? ' in strong sell zone' : ''}`,
        timeframe: this.preferredTimeframes[0],
        metadata: {
          midline: Math.round(m * 100) / 100,
          epsilon: Math.round(epsilon * 100) / 100,
          atr: Math.round(currentATR * 100) / 100,
          highest: Math.round(h * 100) / 100,
          lowest: Math.round(l * 100) / 100,
          strongBuy,
          strongSell,
          state,
          strategy: this.name,
        },
      };
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
    const minCandles = this.params.period + this.params.atrPeriod + 10;
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
    if (params.period !== undefined) this.params.period = Number(params.period);
    if (params.atrPeriod !== undefined) this.params.atrPeriod = Number(params.atrPeriod);
    if (params.mult !== undefined) this.params.mult = Number(params.mult);
    if (params.useEmaSmooth !== undefined) this.params.useEmaSmooth = Boolean(params.useEmaSmooth);
    if (params.emaPeriod !== undefined) this.params.emaPeriod = Number(params.emaPeriod);
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
   * Seeded with SMA of the first `period` values.
   *
   * @returns Array of EMA values, starting from index `period - 1`.
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
   * Highest value in a window of the given array.
   */
  private calculateHighest(values: number[], endIdx: number, period: number): number {
    const start = Math.max(0, endIdx - period + 1);
    let max = -Infinity;
    for (let i = start; i <= endIdx; i++) {
      if (values[i] > max) max = values[i];
    }
    return max;
  }

  /**
   * Lowest value in a window of the given array.
   */
  private calculateLowest(values: number[], endIdx: number, period: number): number {
    const start = Math.max(0, endIdx - period + 1);
    let min = Infinity;
    for (let i = start; i <= endIdx; i++) {
      if (values[i] < min) min = values[i];
    }
    return min;
  }

  /**
   * Average True Range over the given period (Wilder smoothing).
   * Returns the final ATR value.
   */
  private calculateATR(candles: CandleData[], period: number): number {
    const series = this.calculateATRSeries(candles, period);
    return series.length > 0 ? series[series.length - 1] : 0;
  }

  /**
   * Full ATR series using Wilder smoothing.
   * Returns one ATR value per candle starting from index `period`.
   */
  private calculateATRSeries(candles: CandleData[], period: number): number[] {
    if (candles.length < period + 1) {
      return [];
    }

    const trValues: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trValues.push(tr);
    }

    const atrValues: number[] = [];

    // Seed with SMA of first `period` TR values
    let atr = 0;
    for (let i = 0; i < period; i++) {
      atr += trValues[i];
    }
    atr /= period;
    atrValues.push(atr);

    // Wilder smoothing for the rest
    for (let i = period; i < trValues.length; i++) {
      atr = (atr * (period - 1) + trValues[i]) / period;
      atrValues.push(atr);
    }

    return atrValues;
  }

  /**
   * Detect crossover: current crosses above level from below.
   * True when previous < level AND current >= level.
   */
  private detectCrossover(current: number, previous: number, level: number): boolean {
    return previous < level && current >= level;
  }

  /**
   * Detect crossunder: current crosses below level from above.
   * True when previous > level AND current <= level.
   */
  private detectCrossunder(current: number, previous: number, level: number): boolean {
    return previous > level && current <= level;
  }

  /**
   * Confidence score (0-100) based on:
   * - Base: 45
   * - Strong buy/sell zone: +20
   * - Price distance from midline (conviction): up to +15
   * - Volume confirmation: up to +10
   * - ATR expansion: up to +10
   */
  private calculateConfidence(
    currentSrc: number,
    midline: number,
    epsilon: number,
    strongZone: boolean,
    candles: CandleData[],
    currentATR: number,
  ): number {
    let score = 45;

    // Strong zone bonus
    if (strongZone) {
      score += 20;
    }

    // Price distance from midline — further away = more conviction
    const distance = Math.abs(currentSrc - midline);
    if (epsilon > 0) {
      const distanceRatio = distance / epsilon;
      score += Math.min(15, distanceRatio * 5);
    }

    // Volume confirmation
    if (candles.length >= 20) {
      const recentVolumes = candles.slice(-20).map((c) => c.volume);
      const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
      const currentVolume = candles[candles.length - 1].volume;

      if (avgVolume > 0) {
        const volumeRatio = currentVolume / avgVolume;
        score += Math.min(10, (volumeRatio - 1) * 5);
      }
    }

    // ATR expansion — compare current ATR to 50-bar ATR average
    if (candles.length >= 50 && currentATR > 0) {
      const atrSeries = this.calculateATRSeries(candles.slice(-60), this.params.atrPeriod);
      if (atrSeries.length > 1) {
        const avgATR = atrSeries.reduce((a, b) => a + b, 0) / atrSeries.length;
        if (avgATR > 0) {
          const atrExpansion = currentATR / avgATR;
          score += Math.min(10, (atrExpansion - 1) * 8);
        }
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
