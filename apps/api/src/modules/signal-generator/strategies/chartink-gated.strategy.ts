/**
 * Chartink-Gated Strategy
 *
 * Backtestable replay of the LIVE Chartink-gated entry pipeline plus the
 * watch-monitor exit rules. In production the entry path is:
 *   Chartink webhook alert → ChartinkScoringService 10-check score → if the
 *   score clears the threshold AND the momentum gates pass, a paper trade is
 *   opened and the watch monitor manages the exit.
 *
 * This strategy reproduces that decision logic over historical candles so the
 * backtest page can evaluate it. It does NOT participate in the classic
 * signal scanner — `analyze()` is intentionally inert (see below).
 *
 * ENTRY (per bar):
 *   - Re-score the instrument "as of" the bar's timestamp via
 *     ChartinkScoringService.score().
 *   - Skip the bar when the score is data-starved (unreliable broker data).
 *   - Enter a BUY iff:
 *       score >= scoreThreshold
 *       AND the 'MACD on 5m' check passed
 *       AND the 'SuperTrend match' check passed
 *
 * EXIT (walk forward from the entry bar — first of, stop checked before
 * target within a bar for a conservative fill):
 *   - stoploss     : low  <= entry * (1 - stopPct/100)
 *   - target       : high >= entry * (1 + targetPct/100)
 *   - score-decay  : after graceMinutes, re-score; if score < scoreDecaySL,
 *                    exit at the bar close
 *   - timeout      : held for maxHoldBars bars, exit at the bar close
 */

import { Injectable } from '@nestjs/common';
import {
  TradingStrategy,
  MarketSnapshot,
  SignalOutput,
  BacktestInput,
  BacktestResult,
  BacktestTrade,
  BacktestBarLog,
} from '../../../common/interfaces/trading-strategy.interface';
import { ChartinkScoringService } from '../../chartink/services/chartink-scoring.service';

interface ChartinkGatedParameters {
  /** Minimum 10-check score (0-100) required to open a trade. */
  scoreThreshold: number;
  /** Profit target as a percentage above the entry price. */
  targetPct: number;
  /** Stoploss as a percentage below the entry price. */
  stopPct: number;
  /** Minutes after entry before score-decay re-scoring kicks in. */
  graceMinutes: number;
  /** Score below which a post-grace re-score triggers a score-decay exit. */
  scoreDecaySL: number;
  /** Maximum bars to hold before a timeout exit. */
  maxHoldBars: number;
}

const EMPTY_RESULT: BacktestResult = {
  totalTrades: 0,
  winRate: 0,
  totalReturn: 0,
  totalReturnPercent: 0,
  maxDrawdown: 0,
  sharpeRatio: 0,
  trades: [],
};

const MACD_5M_CHECK = 'MACD on 5m';
const SUPERTREND_CHECK = 'SuperTrend match';

@Injectable()
export class ChartinkGatedStrategy implements TradingStrategy {
  readonly name = 'chartink-gated';
  readonly description =
    'Replays the live Chartink-gated entry (10-check score + MACD-5m + SuperTrend gates) ' +
    'and watch-monitor exits (target / stoploss / score-decay / timeout)';
  readonly supportedSegments = ['EQUITY'];
  readonly preferredTimeframes = ['1d', '1h'];

  private params: ChartinkGatedParameters = {
    scoreThreshold: 60,
    targetPct: 2,
    stopPct: 1,
    graceMinutes: 10,
    scoreDecaySL: 50,
    maxHoldBars: 20,
  };

  constructor(private readonly scoring: ChartinkScoringService) {}

  /**
   * Intentionally inert. The live entry path for this strategy is the
   * Chartink webhook → watch-monitor pipeline, NOT the classic signal
   * scanner that calls analyze(). The interface still requires the method,
   * so it always returns null — this strategy contributes nothing to
   * synchronous scanner sweeps.
   */
  analyze(_data: MarketSnapshot): SignalOutput | null {
    return null;
  }

  /**
   * Walk-forward backtest. At each bar, re-scores the instrument "as of"
   * that bar via ChartinkScoringService and applies the live entry gates.
   * One open position at a time — after a trade exits, scanning resumes at
   * the exit bar (mirrors rsi-reversal's `i = j` advance).
   */
  async backtest(input: BacktestInput): Promise<BacktestResult> {
    const { candles, initialCapital, positionSize, symbol, token, exchange } = input;

    // Can't score without an instrument identity — no broker fetch is possible.
    if (!symbol || !token || !exchange) {
      return { ...EMPTY_RESULT };
    }
    if (!candles || candles.length < 2) {
      return { ...EMPTY_RESULT };
    }

    const { scoreThreshold, targetPct, stopPct, graceMinutes, scoreDecaySL, maxHoldBars } =
      this.params;
    const graceMs = graceMinutes * 60_000;

    const trades: BacktestTrade[] = [];
    // Pure observability: one record per entry-scanned bar. Never read by the
    // trading logic — recording it cannot change any trade/metric.
    const barLog: BacktestBarLog[] = [];
    let capital = initialCapital;
    let peakCapital = initialCapital;
    let maxDrawdown = 0;

    // Fetch every historical series ONCE up front. Each score() call below is
    // served from this in-memory source instead of re-hitting the broker per
    // bar — a ~9-min backtest collapses to ~1 min. Purely a fetch optimization:
    // trades / P&L / barLog stay byte-identical.
    const candleSource = await this.scoring.prefetch(
      token,
      symbol,
      exchange,
      input.startDate ?? candles[0].timestamp,
      input.endDate ?? candles[candles.length - 1].timestamp,
    );

    let i = 0;
    while (i < candles.length) {
      const entryCandle = candles[i];

      // ── ENTRY: re-score as of this bar ─────────────────────────────────
      const entryScore = await this.scoring.score({
        token,
        symbol,
        exchange,
        side: 'BUY',
        entryPrice: entryCandle.close,
        setupContext: null,
        asOf: entryCandle.timestamp,
        candleSource,
      });

      const macd5m = entryScore.checks.some(
        (c) => c.name === MACD_5M_CHECK && c.passed,
      );
      const supertrend = entryScore.checks.some(
        (c) => c.name === SUPERTREND_CHECK && c.passed,
      );

      // Data-starved scores are unreliable — skip the bar entirely.
      if (entryScore.dataStarved) {
        barLog.push({
          time: entryCandle.timestamp.toISOString(),
          score: entryScore.score,
          dataStarved: true,
          macd5m,
          supertrend,
          decision: 'skipped',
          reason: 'data-starved',
        });
        i++;
        continue;
      }

      if (!this.passesEntryGates(entryScore, scoreThreshold)) {
        const reason =
          entryScore.score < scoreThreshold
            ? `score ${entryScore.score} below threshold ${scoreThreshold}`
            : 'MACD-5m / SuperTrend gate failed';
        barLog.push({
          time: entryCandle.timestamp.toISOString(),
          score: entryScore.score,
          dataStarved: false,
          macd5m,
          supertrend,
          decision: 'skipped',
          reason,
        });
        i++;
        continue;
      }

      // Passes all gates — record the entry decision.
      barLog.push({
        time: entryCandle.timestamp.toISOString(),
        score: entryScore.score,
        dataStarved: false,
        macd5m,
        supertrend,
        decision: 'entered',
        reason: '',
      });

      // ── Trade is open ──────────────────────────────────────────────────
      const entryPrice = entryCandle.close;
      const entryTime = entryCandle.timestamp;
      const stopPrice = entryPrice * (1 - stopPct / 100);
      const targetPrice = entryPrice * (1 + targetPct / 100);

      let exitPrice = entryPrice;
      let exitTime = entryTime;
      let exitReason = 'timeout';
      let exitIndex = i;

      // ── EXIT: walk forward from the entry bar ──────────────────────────
      for (let j = i + 1; j < candles.length; j++) {
        const bar = candles[j];
        let exited = false;

        // Stop is checked BEFORE target — conservative fill when a bar's
        // range straddles both levels.
        if (bar.low <= stopPrice) {
          exitPrice = stopPrice;
          exitTime = bar.timestamp;
          exitReason = 'stoploss';
          exitIndex = j;
          exited = true;
        } else if (bar.high >= targetPrice) {
          exitPrice = targetPrice;
          exitTime = bar.timestamp;
          exitReason = 'target';
          exitIndex = j;
          exited = true;
        }

        // Score-decay — only re-score once the grace window has elapsed.
        if (!exited && bar.timestamp.getTime() - entryTime.getTime() >= graceMs) {
          const reScore = await this.scoring.score({
            token,
            symbol,
            exchange,
            side: 'BUY',
            entryPrice,
            setupContext: null,
            asOf: bar.timestamp,
            candleSource,
          });
          // A data-starved re-score is NOT a real score crater — ignore it.
          if (!reScore.dataStarved && reScore.score < scoreDecaySL) {
            exitPrice = bar.close;
            exitTime = bar.timestamp;
            exitReason = 'score-decay';
            exitIndex = j;
            exited = true;
          }
        }

        // Timeout — held maxHoldBars bars, or this is the last candle.
        if (!exited && (j - i >= maxHoldBars || j === candles.length - 1)) {
          exitPrice = bar.close;
          exitTime = bar.timestamp;
          exitReason = 'timeout';
          exitIndex = j;
          exited = true;
        }

        if (exited) break;
      }

      // No further candle to exit on — close the position on the entry bar.
      if (exitIndex === i) {
        exitPrice = entryCandle.close;
        exitTime = entryCandle.timestamp;
        exitReason = 'timeout';
      }

      const pnl = (exitPrice - entryPrice) * positionSize;
      capital += pnl;

      if (capital > peakCapital) {
        peakCapital = capital;
      }
      const drawdown = peakCapital > 0 ? ((peakCapital - capital) / peakCapital) * 100 : 0;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }

      trades.push({
        entryTime,
        exitTime,
        side: 'BUY',
        entryPrice: Math.round(entryPrice * 100) / 100,
        exitPrice: Math.round(exitPrice * 100) / 100,
        pnl: Math.round(pnl * 100) / 100,
        reason: exitReason,
      });

      // Resume scanning AFTER the exit bar (one open position at a time —
      // the exit bar itself is consumed by this trade and not re-entered).
      i = exitIndex > i ? exitIndex + 1 : i + 1;
    }

    const wins = trades.filter((t) => t.pnl > 0).length;
    const totalReturn = capital - initialCapital;
    const sharpeRatio = this.calculateSharpeRatio(trades);

    return {
      totalTrades: trades.length,
      winRate: trades.length > 0 ? Math.round((wins / trades.length) * 10000) / 100 : 0,
      totalReturn: Math.round(totalReturn * 100) / 100,
      totalReturnPercent:
        initialCapital > 0 ? Math.round((totalReturn / initialCapital) * 10000) / 100 : 0,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
      trades,
      barLog,
    };
  }

  /** Return current parameter values. */
  getParameters(): Record<string, any> {
    return { ...this.params };
  }

  /** Merge provided params into the current set. */
  setParameters(params: Record<string, any>): void {
    if (params.scoreThreshold !== undefined)
      this.params.scoreThreshold = Number(params.scoreThreshold);
    if (params.targetPct !== undefined) this.params.targetPct = Number(params.targetPct);
    if (params.stopPct !== undefined) this.params.stopPct = Number(params.stopPct);
    if (params.graceMinutes !== undefined)
      this.params.graceMinutes = Number(params.graceMinutes);
    if (params.scoreDecaySL !== undefined)
      this.params.scoreDecaySL = Number(params.scoreDecaySL);
    if (params.maxHoldBars !== undefined) this.params.maxHoldBars = Number(params.maxHoldBars);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Live entry gate: score clears the threshold AND both momentum checks
   * ('MACD on 5m' and 'SuperTrend match') passed.
   */
  private passesEntryGates(
    result: { score: number; checks: Array<{ name: string; passed: boolean }> },
    scoreThreshold: number,
  ): boolean {
    if (result.score < scoreThreshold) {
      return false;
    }
    const macdPassed = result.checks.some((c) => c.name === MACD_5M_CHECK && c.passed);
    const supertrendPassed = result.checks.some(
      (c) => c.name === SUPERTREND_CHECK && c.passed,
    );
    return macdPassed && supertrendPassed;
  }

  /**
   * Annualized Sharpe ratio from trade PnLs. Assumes ~252 trading days.
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
