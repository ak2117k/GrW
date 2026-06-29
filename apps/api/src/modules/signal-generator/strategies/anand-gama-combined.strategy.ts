/**
 * Anand Gama Combined Strategy
 *
 * META strategy that combines Gamma Blast + ATR Supertrend + Q-Trend.
 * Generates signals only when 2 or more of the constituent strategies
 * agree on direction (BUY or SELL). The combined signal uses the highest
 * confidence individual signal as its base and applies an agreement boost.
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
import { GammaBlastStrategy } from './gamma-blast.strategy';
import { AtrSupertrendStrategy } from './atr-supertrend.strategy';
import { QTrendStrategy } from './q-trend.strategy';

/** Map a signal's metadata.strategy field to a human-readable label. */
function getStrategyLabel(signal: SignalOutput): string {
  const strategyName = signal.metadata?.strategy as string | undefined;
  switch (strategyName) {
    case 'gamma-blast':
      return 'Gamma Blast';
    case 'atr-supertrend':
      return 'ATR Supertrend';
    case 'q-trend':
      return 'Q-Trend';
    default:
      return strategyName ?? 'Unknown';
  }
}

@Injectable()
export class AnandGamaCombinedStrategy implements TradingStrategy {
  readonly name = 'anand-gama-combined';
  readonly description =
    'Combined Gamma Blast + ATR Supertrend + Q-Trend — signals when 2+ indicators agree';
  readonly supportedSegments = ['OPTIONS', 'EQUITY', 'FUTURES'];
  readonly preferredTimeframes = ['15m', '1h'];

  constructor(
    private readonly gammaBlast: GammaBlastStrategy,
    private readonly atrSupertrend: AtrSupertrendStrategy,
    private readonly qTrend: QTrendStrategy,
  ) {}

  /**
   * Analyze current market snapshot using all three sub-strategies.
   *
   * A combined signal is emitted only when 2 or more sub-strategies
   * agree on the same direction. The signal with the highest confidence
   * is used as the base, and an agreement boost is added:
   *   - 3/3 agree: +20 confidence
   *   - 2/3 agree: +10 confidence
   *
   * @returns SignalOutput if 2+ strategies agree, null otherwise.
   */
  analyze(data: MarketSnapshot): SignalOutput | null {
    // Run all 3 strategies
    const gbSignal = this.gammaBlast.analyze(data);
    const stSignal = this.atrSupertrend.analyze(data);
    const qtSignal = this.qTrend.analyze(data);

    // Count agreements
    const signals = [gbSignal, stSignal, qtSignal].filter(
      (s): s is SignalOutput => s !== null,
    );
    const buyCount = signals.filter((s) => s.side === 'BUY').length;
    const sellCount = signals.filter((s) => s.side === 'SELL').length;

    // Need 2+ agreeing
    if (buyCount >= 2) {
      const buySignals = signals.filter((s) => s.side === 'BUY');
      const best = buySignals.reduce((a, b) =>
        a.confidence > b.confidence ? a : b,
      );

      // Boost confidence based on agreement count
      const agreementBoost = buyCount === 3 ? 20 : 10;

      return {
        ...best,
        confidence: Math.min(100, best.confidence + agreementBoost),
        reason: `Combined signal: ${buyCount}/3 indicators agree on BUY (${buySignals.map((s) => getStrategyLabel(s)).join(' + ')})`,
        metadata: {
          ...best.metadata,
          strategy: this.name,
          agreementCount: buyCount,
          agreementBoost,
          constituentStrategies: buySignals.map((s) => s.metadata?.strategy),
        },
      };
    }

    if (sellCount >= 2) {
      const sellSignals = signals.filter((s) => s.side === 'SELL');
      const best = sellSignals.reduce((a, b) =>
        a.confidence > b.confidence ? a : b,
      );

      const agreementBoost = sellCount === 3 ? 20 : 10;

      return {
        ...best,
        confidence: Math.min(100, best.confidence + agreementBoost),
        reason: `Combined signal: ${sellCount}/3 indicators agree on SELL (${sellSignals.map((s) => getStrategyLabel(s)).join(' + ')})`,
        metadata: {
          ...best.metadata,
          strategy: this.name,
          agreementCount: sellCount,
          agreementBoost,
          constituentStrategies: sellSignals.map((s) => s.metadata?.strategy),
        },
      };
    }

    return null; // No agreement
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
    // Use the largest lookback requirement among sub-strategies
    const minCandles = 260; // Q-Trend needs period(200) + atrPeriod(40) + 10
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

  /** Return current parameter values (delegates to sub-strategies). */
  getParameters(): Record<string, any> {
    return {
      gammaBlast: this.gammaBlast.getParameters(),
      atrSupertrend: this.atrSupertrend.getParameters(),
      qTrend: this.qTrend.getParameters(),
    };
  }

  /** Update parameters on sub-strategies. */
  setParameters(params: Record<string, any>): void {
    if (params.gammaBlast) this.gammaBlast.setParameters(params.gammaBlast);
    if (params.atrSupertrend) this.atrSupertrend.setParameters(params.atrSupertrend);
    if (params.qTrend) this.qTrend.setParameters(params.qTrend);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

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
