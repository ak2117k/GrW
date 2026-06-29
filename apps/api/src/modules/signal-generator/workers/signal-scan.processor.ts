import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { SignalGeneratorService } from '../services/signal-generator.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { TIMEFRAMES } from '@td/shared/constants';

interface SignalScanJobPayload {
  tokens?: string[];
  timeframe?: string;
  scanAll?: boolean;
}

@Processor('signal-scan')
export class SignalScanProcessor {
  private readonly logger = new Logger(SignalScanProcessor.name);

  constructor(
    private readonly signalGeneratorService: SignalGeneratorService,
    private readonly marketFeedService: MarketFeedService,
    private readonly marketDataRepository: MarketDataRepository,
    private readonly angelOneAdapter: AngelOneAdapterService,
  ) {}

  @Process({ concurrency: 1 })
  async handleSignalScan(job: Job<SignalScanJobPayload>): Promise<void> {
    const { tokens, timeframe, scanAll } = job.data;

    this.logger.debug(
      `Processing signal-scan job ${job.id}: ` +
        (scanAll ? 'scanAll' : `${tokens?.length ?? 0} tokens, tf=${timeframe}`),
    );

    try {
      if (scanAll) {
        await this.signalGeneratorService.scanAllWatchlist();
        return;
      }

      if (!tokens || tokens.length === 0) {
        this.logger.warn(`Job ${job.id} has no tokens and scanAll=false — skipping`);
        return;
      }

      const tf = timeframe ?? TIMEFRAMES.FIVE_MIN;

      for (const token of tokens) {
        try {
          const snapshot = await this.buildSnapshot(token, tf);
          if (snapshot) {
            await this.signalGeneratorService.scanForSignals(snapshot);
          }
        } catch (error) {
          this.logger.error(
            `Error scanning token ${token}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      this.logger.debug(`Signal-scan job ${job.id} completed`);
    } catch (error) {
      this.logger.error(
        `Signal-scan job ${job.id} failed: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  private async buildSnapshot(
    token: string,
    timeframe: string,
  ): Promise<{
    symbol: string;
    exchange: string;
    ltp: number;
    volume: number;
    candles: Array<{
      timestamp: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;
    oi?: number;
    oiChange?: number;
  } | null> {
    const quote = this.marketFeedService.getQuote(token);
    if (!quote) {
      this.logger.debug(`No cached quote for token ${token} — skipping`);
      return null;
    }

    const now = new Date();
    const lookback = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    let candles: Array<{
      timestamp: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: bigint | number;
    }> = [];

    try {
      const instrument = await this.marketDataRepository.getInstrumentByToken(token);
      if (instrument) {
        candles = await this.marketDataRepository.getCandles(
          instrument.id,
          timeframe,
          lookback,
          now,
        );
      }
    } catch {
      // Continue with empty candles
    }

    // If DB has insufficient candles, fetch from Angel One REST API
    if (candles.length < 52) {
      try {
        const apiCandles = await this.angelOneAdapter.getHistoricalData(
          token,
          quote.exchange,
          timeframe,
          lookback,
          now,
        );

        if (apiCandles && apiCandles.length > candles.length) {
          candles = apiCandles;
          this.logger.debug(
            `Fetched ${apiCandles.length} candles from API for ${quote.symbol}`,
          );
        }
      } catch {
        // Continue with whatever candles we have
      }
    }

    return {
      symbol: quote.symbol,
      exchange: quote.exchange,
      ltp: quote.ltp,
      volume: quote.volume,
      candles: candles.map((c) => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: typeof c.volume === 'bigint' ? Number(c.volume) : (c.volume as number),
      })),
    };
  }
}
