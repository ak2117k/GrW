import { Injectable, Logger } from '@nestjs/common';
import { BacktestDataRepository, type DatasetRow } from '../repositories/backtest-data.repository';
import {
  COVERAGE_SLACK_MS,
  coverageOf,
  intervalMinutes,
  servingIntervals,
  type Bar,
} from '../data/backtest-data.domain';
import { mbmSeriesFor } from '../data/instrument-resolve';

export interface StoredCandles {
  candles: Bar[];
  /** 'store:<interval>' (backtest_bars, rolled up from that interval) or 'mbm' (mbm_bars_1m). */
  source: string;
  /** The held span reaches both ends of the request (weekend/holiday slack). */
  complete: boolean;
  datasetId?: number;
}

/** A dataset serves an exchange when they match, or the request did not say. */
function exchangeMatches(ds: DatasetRow, exchange: string | undefined): boolean {
  return !exchange || ds.exchange.toUpperCase() === exchange.toUpperCase();
}

/**
 * Store-first candle loader for backtests: backtest_bars (research downloads + on-demand fetches),
 * then the MBM live 1m store. Returns null when neither holds anything for the request, so the
 * caller keeps its previous behaviour (the broker fetch).
 */
@Injectable()
export class BacktestDataService {
  private readonly logger = new Logger(BacktestDataService.name);

  constructor(private readonly repo: BacktestDataRepository) {}

  listDatasets(symbol?: string) {
    return this.repo.listDatasets(symbol);
  }

  /** Does any stored interval that can serve `timeframe` hold the whole [from, to]? */
  async coverage(symbol: string, exchange: string | undefined, timeframe: string, from: Date, to: Date) {
    const datasets = (await this.repo.listDatasets(symbol)).filter((d) => exchangeMatches(d, exchange));
    for (const interval of servingIntervals(timeframe)) {
      const ds = datasets.find((d) => d.interval === interval);
      if (ds && coverageOf(ds, from, to).complete) return { complete: true as const, dataset: ds };
    }
    return { complete: false as const, dataset: null };
  }

  async loadFromStore(
    symbol: string,
    exchange: string | undefined,
    timeframe: string,
    from: Date,
    to: Date,
    maxBars = 1_000_000,
  ): Promise<StoredCandles | null> {
    // Read at most maxBars + 1: the caller sees "too many" without a 10-year 1m series in memory.
    const limit = maxBars + 1;
    const target = intervalMinutes(timeframe);
    if (target == null) return null;
    let best: StoredCandles | null = null;
    try {
      const datasets = (await this.repo.listDatasets(symbol)).filter((d) => exchangeMatches(d, exchange));
      for (const interval of servingIntervals(timeframe)) {
        const ds = datasets.find((d) => d.interval === interval);
        if (!ds || !ds.rows) continue;
        const complete = coverageOf(ds, from, to).complete;
        if (!complete && best) continue; // one partial candidate is enough
        const candles = await this.repo.readBars(ds.id, from, to, intervalMinutes(interval)!, target, limit);
        if (candles.length === 0) continue;
        const found: StoredCandles = { candles, source: `store:${interval}`, complete, datasetId: ds.id };
        if (complete) return found;
        best = found;
      }
      const series = mbmSeriesFor(symbol);
      if (series && (!exchange || exchange.toUpperCase() === 'NSE')) {
        const candles = await this.repo.readMbmBars(series, from, to, target, limit);
        if (candles.length > 0) {
          const first = candles[0].timestamp.getTime();
          const last = candles[candles.length - 1].timestamp.getTime();
          const complete = first <= from.getTime() + COVERAGE_SLACK_MS && last >= to.getTime() - COVERAGE_SLACK_MS;
          if (complete) return { candles, source: 'mbm', complete };
          if (!best || candles.length > best.candles.length) best = { candles, source: 'mbm', complete };
        }
      }
    } catch (err) {
      // The store is an optimisation: a missing table (migration not applied) must not break backtests.
      this.logger.warn(`backtest store read failed for ${symbol} ${timeframe}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
    return best;
  }
}
