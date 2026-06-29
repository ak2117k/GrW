import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { MarketFeedService } from '../services/market-feed.service';
import { MarketDataRepository } from '../repositories/market-data.repository';
import { InstrumentService } from '../services/instrument.service';
import { MarketDataGateway } from '../gateways/market-data.gateway';
import { OIData } from '@td/shared/types';

/** Threshold for OI spike detection: >5% change from previous snapshot. */
const OI_SPIKE_THRESHOLD_PERCENT = 5;

@Processor('oi-tracker')
export class OITrackerProcessor {
  private readonly logger = new Logger(OITrackerProcessor.name);

  /** Store previous OI values for change calculation. */
  private readonly previousOI = new Map<string, number>();

  constructor(
    private readonly marketFeedService: MarketFeedService,
    private readonly repository: MarketDataRepository,
    private readonly instrumentService: InstrumentService,
    private readonly gateway: MarketDataGateway,
  ) {}

  /**
   * Bull job handler: capture OI snapshot for all subscribed F&O instruments.
   * This job is enqueued every 1 minute during market hours by a cron service.
   */
  @Process('capture-oi')
  async handleCaptureOI(job: Job): Promise<void> {
    // Only run during market hours
    if (!this.marketFeedService.isMarketOpen()) {
      this.logger.debug('Market is closed — skipping OI capture');
      return;
    }

    const subscribedTokens = this.marketFeedService.getSubscribedTokens();
    if (subscribedTokens.length === 0) {
      return;
    }

    let capturedCount = 0;
    let spikeCount = 0;

    for (const token of subscribedTokens) {
      try {
        const quote = this.marketFeedService.getQuote(token);
        if (!quote) continue;

        // We get OI from the tick data stored in the quote cache.
        // OI is only relevant for F&O instruments.
        const instrument = await this.instrumentService.getByToken(token);
        if (!instrument) continue;

        const segment = instrument.segment?.toUpperCase();
        if (segment !== 'FUTURES' && segment !== 'OPTIONS') {
          continue;
        }

        // Extract OI from the latest tick. The quote interface doesn't have OI,
        // so we check if the brokerAdapter stored it. For now, we read it from
        // any extended quote data. If OI is not available, skip.
        const currentOI = (quote as any).oi;
        if (currentOI === undefined || currentOI === null || currentOI === 0) {
          continue;
        }

        const previousOIValue = this.previousOI.get(token) ?? currentOI;
        const oiChange = currentOI - previousOIValue;
        const oiChangePercent =
          previousOIValue !== 0
            ? (Math.abs(oiChange) / previousOIValue) * 100
            : 0;

        // Save snapshot to database
        await this.repository.saveOISnapshot({
          instrumentId: instrument.id,
          oi: currentOI,
          oiChange,
          volume: quote.volume,
          timestamp: new Date(),
        });

        capturedCount++;
        this.previousOI.set(token, currentOI);

        // Detect OI spikes and emit alerts
        if (oiChangePercent > OI_SPIKE_THRESHOLD_PERCENT) {
          spikeCount++;
          const oiData: OIData = {
            symbol: quote.symbol,
            token,
            oi: currentOI,
            oiChange,
            oiChangePercent: Math.round(oiChangePercent * 100) / 100,
            timestamp: new Date(),
          };

          this.gateway.emitOIUpdate(oiData);
          this.logger.warn(
            `OI spike detected for ${quote.symbol}: ${oiChangePercent.toFixed(1)}% ` +
              `(${previousOIValue} -> ${currentOI})`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Failed to capture OI for token ${token}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (capturedCount > 0) {
      this.logger.debug(
        `OI capture complete: ${capturedCount} snapshots, ${spikeCount} spikes`,
      );
    }
  }
}
