import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import {
  SignalOutput,
  MarketSnapshot,
  CandleData,
} from '../../../common/interfaces/trading-strategy.interface';
import { SignalRepository } from '../repositories/signal.repository';
import { firstValueFrom } from 'rxjs';

/** Weighted ensemble scoring weights (must sum to 1.0). */
const WEIGHTS = {
  STRATEGY_STRENGTH: 0.3,
  MULTI_TIMEFRAME: 0.2,
  VOLUME_CONFIRMATION: 0.15,
  OI_SUPPORT: 0.1,
  HISTORICAL_PERFORMANCE: 0.15,
  MARKET_REGIME: 0.1,
} as const;

const AI_SCORE_ENDPOINT = 'http://localhost:5000/api/score-signal';
const AI_TIMEOUT_MS = 3000;

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

@Injectable()
export class SignalScoringService {
  private readonly logger = new Logger(SignalScoringService.name);

  constructor(
    private readonly signalRepository: SignalRepository,
    private readonly httpService: HttpService,
  ) {}

  /**
   * Score a signal using the weighted ensemble model.
   * Returns a score 0-100 or null if the signal should be discarded (<40).
   */
  async scoreSignal(
    signal: SignalOutput,
    snapshot: MarketSnapshot,
    strategyName: string,
    timeframeAlignments: number = 1,
  ): Promise<{ score: number; confidence: ConfidenceLevel } | null> {
    try {
      const strategyStrength = this.normalizeStrategyStrength(signal.confidence);
      const multiTimeframe = this.scoreMultiTimeframe(timeframeAlignments);
      const volumeScore = this.scoreVolume(snapshot);
      const oiScore = this.scoreOI(snapshot, signal.side);
      const winRate = await this.getStrategyWinRate(strategyName, 30);
      const regimeScore = this.scoreMarketRegime(snapshot.candles);

      const ruleBasedScore =
        strategyStrength * WEIGHTS.STRATEGY_STRENGTH +
        multiTimeframe * WEIGHTS.MULTI_TIMEFRAME +
        volumeScore * WEIGHTS.VOLUME_CONFIRMATION +
        oiScore * WEIGHTS.OI_SUPPORT +
        winRate * WEIGHTS.HISTORICAL_PERFORMANCE +
        regimeScore * WEIGHTS.MARKET_REGIME;

      // Attempt AI scoring with fallback to rule-based
      let finalScore = Math.round(ruleBasedScore);

      const aiScore = await this.getAIScore(signal, snapshot, ruleBasedScore);
      if (aiScore !== null) {
        // Blend AI score with rule-based: 60% rule-based, 40% AI
        finalScore = Math.round(ruleBasedScore * 0.6 + aiScore * 0.4);
      }

      finalScore = Math.max(0, Math.min(100, finalScore));

      if (finalScore < 40) {
        this.logger.debug(
          `Signal for ${signal.symbol} discarded — score ${finalScore} below threshold`,
        );
        return null;
      }

      const confidence = this.scoreToConfidence(finalScore);

      this.logger.debug(
        `Signal scored: ${signal.symbol} ${signal.side} = ${finalScore} (${confidence}) ` +
          `[str=${strategyStrength.toFixed(0)}, mtf=${multiTimeframe.toFixed(0)}, ` +
          `vol=${volumeScore.toFixed(0)}, oi=${oiScore.toFixed(0)}, ` +
          `wr=${winRate.toFixed(0)}, reg=${regimeScore.toFixed(0)}]`,
      );

      return { score: finalScore, confidence };
    } catch (error) {
      this.logger.error(
        `Error scoring signal for ${signal.symbol}: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  /**
   * Calculate Average True Range for regime detection.
   */
  calculateATR(candles: CandleData[], period: number = 14): number {
    if (candles.length < period + 1) return 0;

    const trueRanges: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const previous = candles[i - 1];

      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      );
      trueRanges.push(tr);
    }

    // Use the last `period` true ranges
    const recentTR = trueRanges.slice(-period);
    return recentTR.reduce((sum, tr) => sum + tr, 0) / recentTR.length;
  }

  /**
   * Get the historical win rate for a strategy over the last N days.
   */
  async getStrategyWinRate(strategyName: string, days: number): Promise<number> {
    try {
      const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const perf = await this.signalRepository.getStrategyPerformance(
        strategyName,
        fromDate,
      );
      // Return win rate as 0-100, default to 50 if no history
      return perf.totalTrades > 0 ? perf.winRate : 50;
    } catch {
      return 50; // Default when no data available
    }
  }

  // ------------------------------------------------------------------
  //  Private scoring components
  // ------------------------------------------------------------------

  /**
   * Normalize the raw strategy confidence (0-100) to a 0-100 component score.
   */
  private normalizeStrategyStrength(rawConfidence: number): number {
    return Math.max(0, Math.min(100, rawConfidence));
  }

  /**
   * Score multi-timeframe alignment.
   * 1 TF = 0, 2 TFs = 50, 3+ TFs = 100
   */
  private scoreMultiTimeframe(alignedTimeframes: number): number {
    if (alignedTimeframes >= 3) return 100;
    if (alignedTimeframes === 2) return 50;
    return 0;
  }

  /**
   * Score volume relative to recent average.
   * Volume > 1.5x 20-candle avg = 100, at avg = 50, < 0.5x = 0.
   */
  private scoreVolume(snapshot: MarketSnapshot): number {
    const candles = snapshot.candles;
    if (candles.length < 20) return 50; // Default when insufficient data

    const recentCandles = candles.slice(-20);
    const avgVolume =
      recentCandles.reduce((sum, c) => sum + c.volume, 0) / recentCandles.length;

    if (avgVolume === 0) return 50;

    const ratio = snapshot.volume / avgVolume;

    if (ratio >= 1.5) return 100;
    if (ratio <= 0.5) return 0;

    // Linear interpolation between 0.5 and 1.5
    return Math.round(((ratio - 0.5) / 1.0) * 100);
  }

  /**
   * Score OI change alignment with trade direction.
   * OI increasing + BUY = bullish support. OI decreasing + SELL = bearish support.
   */
  private scoreOI(snapshot: MarketSnapshot, side: string): number {
    if (snapshot.oiChange === undefined || snapshot.oiChange === null) {
      return 50; // Neutral when OI data unavailable
    }

    const oiChange = snapshot.oiChange;

    if (side === 'BUY' && oiChange > 0) {
      // Bullish: long buildup
      return Math.min(100, 50 + Math.abs(oiChange) * 0.1);
    }
    if (side === 'SELL' && oiChange < 0) {
      // Bearish: long unwinding
      return Math.min(100, 50 + Math.abs(oiChange) * 0.1);
    }
    if (side === 'BUY' && oiChange < 0) {
      // Bearish OI but buying — negative signal
      return Math.max(0, 50 - Math.abs(oiChange) * 0.1);
    }
    if (side === 'SELL' && oiChange > 0) {
      // Bullish OI but selling — negative signal
      return Math.max(0, 50 - Math.abs(oiChange) * 0.1);
    }

    return 50;
  }

  /**
   * Score market regime based on ATR.
   * High ATR (trending) gets a higher score — trends are generally better for
   * momentum strategies. This is a simplified regime detector.
   */
  private scoreMarketRegime(candles: CandleData[]): number {
    if (candles.length < 30) return 50;

    const recentATR = this.calculateATR(candles.slice(-15), 14);
    const longerATR = this.calculateATR(candles.slice(-30), 14);

    if (longerATR === 0) return 50;

    const ratio = recentATR / longerATR;

    // Trending regime (ATR expanding): higher score
    if (ratio > 1.2) return 80;
    // Stable trend
    if (ratio >= 0.8 && ratio <= 1.2) return 60;
    // Contracting volatility (ranging)
    return 40;
  }

  /**
   * Map a numeric score to a confidence level.
   */
  private scoreToConfidence(score: number): ConfidenceLevel {
    if (score >= 90) return 'VERY_HIGH';
    if (score >= 75) return 'HIGH';
    if (score >= 60) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Call the external AI scoring engine. Returns null if unavailable.
   */
  private async getAIScore(
    signal: SignalOutput,
    snapshot: MarketSnapshot,
    ruleBasedScore: number,
  ): Promise<number | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<any>(
          AI_SCORE_ENDPOINT,
          {
            signal: {
              symbol: signal.symbol,
              side: signal.side,
              entryPrice: signal.entryPrice,
              targetPrice: signal.targetPrice,
              stoplossPrice: signal.stoplossPrice,
              timeframe: signal.timeframe,
              reason: signal.reason,
            },
            snapshot: {
              ltp: snapshot.ltp,
              volume: snapshot.volume,
              oi: snapshot.oi,
              oiChange: snapshot.oiChange,
              candleCount: snapshot.candles.length,
            },
            ruleBasedScore,
          },
          { timeout: AI_TIMEOUT_MS },
        ),
      );

      const aiScore = response.data?.score;
      if (typeof aiScore === 'number' && aiScore >= 0 && aiScore <= 100) {
        return aiScore;
      }

      return null;
    } catch {
      // AI engine unavailable — fall back to rule-based scoring silently
      return null;
    }
  }
}
