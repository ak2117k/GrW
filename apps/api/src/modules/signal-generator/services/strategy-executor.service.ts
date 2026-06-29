import { Injectable, Logger } from '@nestjs/common';
import {
  CandleData,
  BacktestResult,
  BacktestTrade,
} from '../../../common/interfaces/trading-strategy.interface';
import {
  ParsedStrategy,
  ParsedIndicator,
  ParsedRule,
  ParsedCondition,
  ConditionOperand,
} from './strategy-parser.service';

// ── Indicator calculation results ────────────────────────────────────

/**
 * For multi-output indicators (MACD, BB), the Map stores arrays under
 * both the primary variable name and each sub-output name.
 *
 *   "macd"   -> MACD line values
 *   "signal" -> Signal line values
 *   "hist"   -> Histogram values
 */

@Injectable()
export class StrategyExecutorService {
  private readonly logger = new Logger(StrategyExecutorService.name);

  // ────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────

  /**
   * Calculate all indicator values for the given candle array.
   */
  calculateIndicators(
    candles: CandleData[],
    indicators: ParsedIndicator[],
  ): Map<string, number[]> {
    const results = new Map<string, number[]>();

    for (const ind of indicators) {
      const source = this.getSourceArray(candles, ind.source);

      switch (ind.type) {
        case 'SMA': {
          results.set(ind.variable, this.calcSMA(source, ind.period));
          break;
        }
        case 'EMA': {
          results.set(ind.variable, this.calcEMA(source, ind.period));
          break;
        }
        case 'RSI': {
          results.set(ind.variable, this.calcRSI(source, ind.period));
          break;
        }
        case 'MACD': {
          const fast = ind.period;
          const slow = ind.extraParams[0] ?? 26;
          const signal = ind.extraParams[1] ?? 9;
          const { macdLine, signalLine, histogram } = this.calcMACD(source, fast, slow, signal);

          if (ind.outputs && ind.outputs.length === 3) {
            results.set(ind.outputs[0], macdLine);
            results.set(ind.outputs[1], signalLine);
            results.set(ind.outputs[2], histogram);
          } else {
            results.set(ind.variable, macdLine);
            results.set(`${ind.variable}_signal`, signalLine);
            results.set(`${ind.variable}_hist`, histogram);
          }
          break;
        }
        case 'BB': {
          const period = ind.period;
          const stdMult = ind.extraParams[0] ?? 2;
          const { upper, middle, lower } = this.calcBollingerBands(source, period, stdMult);

          if (ind.outputs && ind.outputs.length === 3) {
            results.set(ind.outputs[0], upper);
            results.set(ind.outputs[1], middle);
            results.set(ind.outputs[2], lower);
          } else {
            results.set(ind.variable, middle);
            results.set(`${ind.variable}_upper`, upper);
            results.set(`${ind.variable}_lower`, lower);
          }
          break;
        }
        case 'ATR': {
          results.set(ind.variable, this.calcATR(candles, ind.period));
          break;
        }
        case 'VWAP': {
          results.set(ind.variable, this.calcVWAP(candles));
          break;
        }
        case 'SUPERTREND': {
          const atrPeriod = ind.period;
          const multiplier = ind.extraParams[0] ?? 3;
          results.set(ind.variable, this.calcSupertrend(candles, atrPeriod, multiplier));
          break;
        }
        case 'ADX': {
          results.set(ind.variable, this.calcADX(candles, ind.period));
          break;
        }
        case 'VOLUME': {
          results.set(ind.variable, candles.map((c) => c.volume));
          break;
        }
        case 'OI': {
          // OI is not in standard CandleData — fill zeros if not available
          results.set(ind.variable, candles.map(() => 0));
          break;
        }
        default:
          this.logger.warn(`Unsupported indicator: ${ind.type}`);
          results.set(ind.variable, new Array(candles.length).fill(NaN));
      }
    }

    return results;
  }

  /**
   * Evaluate a condition rule (AND/OR of atomic conditions) at a specific candle index.
   */
  evaluateCondition(
    rule: ParsedRule,
    indicatorValues: Map<string, number[]>,
    index: number,
  ): boolean {
    if (rule.conditions.length === 0) return false;

    if (rule.operator === 'AND') {
      return rule.conditions.every((c) => this.evalAtomic(c, indicatorValues, index));
    }
    return rule.conditions.some((c) => this.evalAtomic(c, indicatorValues, index));
  }

  /**
   * Run a full backtest of a parsed strategy against candle data.
   */
  executeBacktest(
    parsed: ParsedStrategy,
    candles: CandleData[],
    initialCapital: number = 1_000_000,
    positionSizePct: number = 1,
  ): BacktestResult {
    if (candles.length === 0) {
      return this.emptyResult();
    }

    const indicatorValues = this.calculateIndicators(candles, parsed.indicators);
    const trades: BacktestTrade[] = [];
    let capital = initialCapital;
    let position: { side: 'BUY' | 'SELL'; entryPrice: number; entryTime: Date; qty: number } | null = null;

    // Start from a safe offset so all indicators are warmed up
    const warmup = Math.max(
      ...parsed.indicators.map((ind) => {
        const total = ind.period + (ind.extraParams[0] ?? 0);
        return Math.min(total + 5, candles.length - 1);
      }),
      1,
    );

    for (let i = warmup; i < candles.length; i++) {
      const candle = candles[i];

      if (!position) {
        // Check long entry
        if (this.evaluateCondition(parsed.entryRules.long, indicatorValues, i)) {
          const qty = Math.floor((capital * positionSizePct) / 100 / candle.close);
          if (qty > 0) {
            position = { side: 'BUY', entryPrice: candle.close, entryTime: candle.timestamp, qty };
          }
        }
        // Check short entry
        else if (this.evaluateCondition(parsed.entryRules.short, indicatorValues, i)) {
          const qty = Math.floor((capital * positionSizePct) / 100 / candle.close);
          if (qty > 0) {
            position = { side: 'SELL', entryPrice: candle.close, entryTime: candle.timestamp, qty };
          }
        }
      } else {
        let shouldExit = false;
        let exitReason = 'exit_signal';

        // Check exit condition
        if (position.side === 'BUY') {
          if (this.evaluateCondition(parsed.exitRules.long, indicatorValues, i)) {
            shouldExit = true;
          }
        } else {
          if (this.evaluateCondition(parsed.exitRules.short, indicatorValues, i)) {
            shouldExit = true;
          }
        }

        // Check stoploss
        if (!shouldExit && parsed.riskConfig.stoploss) {
          const sl = this.resolveOperandValue(parsed.riskConfig.stoploss, indicatorValues, i);
          if (!isNaN(sl)) {
            if (position.side === 'BUY' && candle.low <= position.entryPrice - sl) {
              shouldExit = true;
              exitReason = 'stoploss';
            } else if (position.side === 'SELL' && candle.high >= position.entryPrice + sl) {
              shouldExit = true;
              exitReason = 'stoploss';
            }
          }
        }

        // Check target
        if (!shouldExit && parsed.riskConfig.target) {
          const tgt = this.resolveOperandValue(parsed.riskConfig.target, indicatorValues, i);
          if (!isNaN(tgt)) {
            if (position.side === 'BUY' && candle.high >= position.entryPrice + tgt) {
              shouldExit = true;
              exitReason = 'target';
            } else if (position.side === 'SELL' && candle.low <= position.entryPrice - tgt) {
              shouldExit = true;
              exitReason = 'target';
            }
          }
        }

        if (shouldExit) {
          const exitPrice = candle.close;
          const pnl =
            position.side === 'BUY'
              ? (exitPrice - position.entryPrice) * position.qty
              : (position.entryPrice - exitPrice) * position.qty;

          capital += pnl;
          trades.push({
            entryTime: position.entryTime,
            exitTime: candle.timestamp,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice,
            pnl,
            reason: exitReason,
          });
          position = null;
        }
      }
    }

    // Close any open position at the last candle
    if (position && candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      const exitPrice = lastCandle.close;
      const pnl =
        position.side === 'BUY'
          ? (exitPrice - position.entryPrice) * position.qty
          : (position.entryPrice - exitPrice) * position.qty;
      capital += pnl;
      trades.push({
        entryTime: position.entryTime,
        exitTime: lastCandle.timestamp,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice,
        pnl,
        reason: 'end_of_data',
      });
    }

    return this.computeStats(trades, initialCapital);
  }

  // ────────────────────────────────────────────────────────────────────
  // Indicator Calculations (pure math, no external libs)
  // ────────────────────────────────────────────────────────────────────

  /** Simple Moving Average */
  private calcSMA(data: number[], period: number): number[] {
    const result: number[] = new Array(data.length).fill(NaN);
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += data[j];
      result[i] = sum / period;
    }
    return result;
  }

  /** Exponential Moving Average */
  private calcEMA(data: number[], period: number): number[] {
    const result: number[] = new Array(data.length).fill(NaN);
    const k = 2 / (period + 1);

    // Seed with SMA of the first `period` values
    let sum = 0;
    for (let i = 0; i < period && i < data.length; i++) sum += data[i];
    if (period <= data.length) {
      result[period - 1] = sum / period;
    }

    for (let i = period; i < data.length; i++) {
      result[i] = data[i] * k + result[i - 1] * (1 - k);
    }
    return result;
  }

  /** Relative Strength Index */
  private calcRSI(data: number[], period: number): number[] {
    const result: number[] = new Array(data.length).fill(NaN);
    if (data.length < period + 1) return result;

    let avgGain = 0;
    let avgLoss = 0;

    // Initial average gain/loss
    for (let i = 1; i <= period; i++) {
      const change = data[i] - data[i - 1];
      if (change > 0) avgGain += change;
      else avgLoss += Math.abs(change);
    }
    avgGain /= period;
    avgLoss /= period;

    result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    // Smoothed RSI
    for (let i = period + 1; i < data.length; i++) {
      const change = data[i] - data[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    return result;
  }

  /** MACD: returns { macdLine, signalLine, histogram } */
  private calcMACD(
    data: number[],
    fastPeriod: number,
    slowPeriod: number,
    signalPeriod: number,
  ): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
    const fastEMA = this.calcEMA(data, fastPeriod);
    const slowEMA = this.calcEMA(data, slowPeriod);
    const macdLine: number[] = new Array(data.length).fill(NaN);

    for (let i = 0; i < data.length; i++) {
      if (!isNaN(fastEMA[i]) && !isNaN(slowEMA[i])) {
        macdLine[i] = fastEMA[i] - slowEMA[i];
      }
    }

    // Signal line is EMA of MACD line
    const validMacd = macdLine.map((v) => (isNaN(v) ? 0 : v));
    const signalFull = this.calcEMA(validMacd, signalPeriod);

    // Only show signal where MACD is valid
    const signalLine: number[] = new Array(data.length).fill(NaN);
    const histogram: number[] = new Array(data.length).fill(NaN);

    for (let i = 0; i < data.length; i++) {
      if (!isNaN(macdLine[i]) && !isNaN(signalFull[i])) {
        signalLine[i] = signalFull[i];
        histogram[i] = macdLine[i] - signalFull[i];
      }
    }

    return { macdLine, signalLine, histogram };
  }

  /** Bollinger Bands */
  private calcBollingerBands(
    data: number[],
    period: number,
    stdMult: number,
  ): { upper: number[]; middle: number[]; lower: number[] } {
    const middle = this.calcSMA(data, period);
    const upper: number[] = new Array(data.length).fill(NaN);
    const lower: number[] = new Array(data.length).fill(NaN);

    for (let i = period - 1; i < data.length; i++) {
      let sumSq = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sumSq += (data[j] - middle[i]) ** 2;
      }
      const std = Math.sqrt(sumSq / period);
      upper[i] = middle[i] + stdMult * std;
      lower[i] = middle[i] - stdMult * std;
    }

    return { upper, middle, lower };
  }

  /** Average True Range */
  private calcATR(candles: CandleData[], period: number): number[] {
    const result: number[] = new Array(candles.length).fill(NaN);
    if (candles.length < 2) return result;

    const tr: number[] = [candles[0].high - candles[0].low];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }

    // First ATR is SMA of first `period` true ranges
    if (candles.length >= period) {
      let sum = 0;
      for (let i = 0; i < period; i++) sum += tr[i];
      result[period - 1] = sum / period;

      // Smoothed ATR (Wilder's)
      for (let i = period; i < candles.length; i++) {
        result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
      }
    }

    return result;
  }

  /** Volume Weighted Average Price */
  private calcVWAP(candles: CandleData[]): number[] {
    const result: number[] = new Array(candles.length).fill(NaN);
    let cumVol = 0;
    let cumTPV = 0; // cumulative (typical price * volume)

    for (let i = 0; i < candles.length; i++) {
      const typicalPrice = (candles[i].high + candles[i].low + candles[i].close) / 3;
      cumVol += candles[i].volume;
      cumTPV += typicalPrice * candles[i].volume;
      result[i] = cumVol === 0 ? typicalPrice : cumTPV / cumVol;
    }

    return result;
  }

  /** Supertrend indicator */
  private calcSupertrend(candles: CandleData[], atrPeriod: number, multiplier: number): number[] {
    const atr = this.calcATR(candles, atrPeriod);
    const result: number[] = new Array(candles.length).fill(NaN);
    if (candles.length < atrPeriod) return result;

    const upperBand: number[] = new Array(candles.length).fill(0);
    const lowerBand: number[] = new Array(candles.length).fill(0);
    const direction: number[] = new Array(candles.length).fill(1); // 1 = up, -1 = down

    for (let i = atrPeriod - 1; i < candles.length; i++) {
      const hl2 = (candles[i].high + candles[i].low) / 2;
      const atrVal = atr[i];
      if (isNaN(atrVal)) continue;

      let basicUpper = hl2 + multiplier * atrVal;
      let basicLower = hl2 - multiplier * atrVal;

      if (i > atrPeriod - 1) {
        // Upper band: take min of current and previous (if previous close was above previous upper)
        upperBand[i] =
          basicUpper < upperBand[i - 1] || candles[i - 1].close > upperBand[i - 1]
            ? basicUpper
            : upperBand[i - 1];

        // Lower band: take max of current and previous (if previous close was below previous lower)
        lowerBand[i] =
          basicLower > lowerBand[i - 1] || candles[i - 1].close < lowerBand[i - 1]
            ? basicLower
            : lowerBand[i - 1];

        // Direction
        if (direction[i - 1] === 1) {
          direction[i] = candles[i].close < lowerBand[i] ? -1 : 1;
        } else {
          direction[i] = candles[i].close > upperBand[i] ? 1 : -1;
        }
      } else {
        upperBand[i] = basicUpper;
        lowerBand[i] = basicLower;
        direction[i] = 1;
      }

      result[i] = direction[i] === 1 ? lowerBand[i] : upperBand[i];
    }

    return result;
  }

  /** Average Directional Index */
  private calcADX(candles: CandleData[], period: number): number[] {
    const result: number[] = new Array(candles.length).fill(NaN);
    if (candles.length < period + 1) return result;

    const trArr: number[] = new Array(candles.length).fill(0);
    const plusDM: number[] = new Array(candles.length).fill(0);
    const minusDM: number[] = new Array(candles.length).fill(0);

    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevHigh = candles[i - 1].high;
      const prevLow = candles[i - 1].low;
      const prevClose = candles[i - 1].close;

      trArr[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));

      const upMove = high - prevHigh;
      const downMove = prevLow - low;
      plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
      minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    }

    // Smooth using Wilder's method
    let smoothTR = 0;
    let smoothPlusDM = 0;
    let smoothMinusDM = 0;

    for (let i = 1; i <= period; i++) {
      smoothTR += trArr[i];
      smoothPlusDM += plusDM[i];
      smoothMinusDM += minusDM[i];
    }

    const dx: number[] = new Array(candles.length).fill(NaN);

    for (let i = period; i < candles.length; i++) {
      if (i > period) {
        smoothTR = smoothTR - smoothTR / period + trArr[i];
        smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
        smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
      }

      const plusDI = smoothTR === 0 ? 0 : (smoothPlusDM / smoothTR) * 100;
      const minusDI = smoothTR === 0 ? 0 : (smoothMinusDM / smoothTR) * 100;
      const diSum = plusDI + minusDI;
      dx[i] = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
    }

    // ADX is smoothed DX
    let adxSum = 0;
    let count = 0;
    for (let i = period; i < Math.min(period * 2, candles.length); i++) {
      if (!isNaN(dx[i])) {
        adxSum += dx[i];
        count++;
      }
    }
    if (count > 0 && period * 2 - 1 < candles.length) {
      result[period * 2 - 1] = adxSum / count;
    }

    for (let i = period * 2; i < candles.length; i++) {
      if (!isNaN(result[i - 1]) && !isNaN(dx[i])) {
        result[i] = (result[i - 1] * (period - 1) + dx[i]) / period;
      }
    }

    return result;
  }

  // ────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────

  private getSourceArray(candles: CandleData[], source: string): number[] {
    switch (source) {
      case 'open':
        return candles.map((c) => c.open);
      case 'high':
        return candles.map((c) => c.high);
      case 'low':
        return candles.map((c) => c.low);
      case 'volume':
        return candles.map((c) => c.volume);
      case 'close':
      default:
        return candles.map((c) => c.close);
    }
  }

  private evalAtomic(
    cond: ParsedCondition,
    values: Map<string, number[]>,
    index: number,
  ): boolean {
    const left = this.resolveOperandValue(cond.left, values, index);
    const right = this.resolveOperandValue(cond.right, values, index);

    if (isNaN(left) || isNaN(right)) return false;

    switch (cond.comparator) {
      case '<':
        return left < right;
      case '>':
        return left > right;
      case '<=':
        return left <= right;
      case '>=':
        return left >= right;
      case '==':
        return Math.abs(left - right) < 1e-10;
      case 'CROSSES_ABOVE': {
        if (index < 1) return false;
        const prevLeft = this.resolveOperandValue(cond.left, values, index - 1);
        const prevRight = this.resolveOperandValue(cond.right, values, index - 1);
        return prevLeft <= prevRight && left > right;
      }
      case 'CROSSES_BELOW': {
        if (index < 1) return false;
        const prevLeft = this.resolveOperandValue(cond.left, values, index - 1);
        const prevRight = this.resolveOperandValue(cond.right, values, index - 1);
        return prevLeft >= prevRight && left < right;
      }
      default:
        return false;
    }
  }

  private resolveOperandValue(
    operand: ConditionOperand,
    values: Map<string, number[]>,
    index: number,
  ): number {
    switch (operand.type) {
      case 'number':
        return operand.value ?? NaN;

      case 'variable': {
        const arr = values.get(operand.variable ?? '');
        if (!arr || index < 0 || index >= arr.length) return NaN;
        return arr[index];
      }

      case 'expression': {
        if (!operand.expression) return NaN;
        const arr = values.get(operand.expression.variable);
        if (!arr || index < 0 || index >= arr.length) return NaN;
        const base = arr[index];
        if (isNaN(base)) return NaN;
        switch (operand.expression.operator) {
          case '*':
            return base * operand.expression.value;
          case '+':
            return base + operand.expression.value;
          case '-':
            return base - operand.expression.value;
          case '/':
            return operand.expression.value === 0 ? NaN : base / operand.expression.value;
          default:
            return NaN;
        }
      }

      default:
        return NaN;
    }
  }

  private computeStats(trades: BacktestTrade[], initialCapital: number): BacktestResult {
    if (trades.length === 0) return this.emptyResult();

    const wins = trades.filter((t) => t.pnl > 0).length;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

    // Max drawdown
    let peak = initialCapital;
    let equity = initialCapital;
    let maxDD = 0;

    for (const trade of trades) {
      equity += trade.pnl;
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    // Sharpe ratio (annualised, assuming daily trades)
    const returns = trades.map((t) => t.pnl / initialCapital);
    const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance =
      returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev === 0 ? 0 : (avgReturn / stdDev) * Math.sqrt(252);

    return {
      totalTrades: trades.length,
      winRate: (wins / trades.length) * 100,
      totalReturn: totalPnl,
      totalReturnPercent: (totalPnl / initialCapital) * 100,
      maxDrawdown: maxDD * 100,
      sharpeRatio: Math.round(sharpe * 100) / 100,
      trades,
    };
  }

  private emptyResult(): BacktestResult {
    return {
      totalTrades: 0,
      winRate: 0,
      totalReturn: 0,
      totalReturnPercent: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      trades: [],
    };
  }
}
