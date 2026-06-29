import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SignalGeneratorService } from '../../signal-generator/services/signal-generator.service';
import { SignalRepository } from '../../signal-generator/repositories/signal.repository';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { RiskManagerService } from '../../trade-engine/services/risk-manager.service';
import { SettingsService } from '../../settings/services/settings.service';
import { TradeGateway } from '../../trade-engine/gateways/trade.gateway';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { ExecuteTradeDto } from '../../trade-engine/dto/trade.dto';

export interface PendingApproval {
  signal: any;
  tradeRequest: ExecuteTradeDto;
  timestamp: Date;
}

interface ScanStats {
  processed: number;
  executed: number;
  pending: number;
  skipped: number;
  errors: number;
  timestamp: Date;
}

export interface AutoTradeStatus {
  mode: string;
  isRunning: boolean;
  pendingApprovals: number;
  stats: ScanStats | null;
}

@Injectable()
export class AutoTradeService {
  private readonly logger = new Logger(AutoTradeService.name);

  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private lastScanStats: ScanStats | null = null;

  /** Expiry threshold for pending approvals (30 minutes). */
  private static readonly APPROVAL_EXPIRY_MS = 30 * 60 * 1000;

  constructor(
    private readonly signalGeneratorService: SignalGeneratorService,
    private readonly signalRepository: SignalRepository,
    private readonly tradeExecutionService: TradeExecutionService,
    private readonly riskManagerService: RiskManagerService,
    private readonly settingsService: SettingsService,
    private readonly tradeGateway: TradeGateway,
    private readonly marketFeedService: MarketFeedService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cron: periodic signal scan every 2 minutes during market hours (Mon-Fri)
  // ---------------------------------------------------------------------------

  @Cron('*/2 9-15 * * 1-5')
  async periodicSignalScan(): Promise<void> {
    try {
      const settings = await this.settingsService.getSettings();

      if (settings.autoTradeMode === 'OFF') {
        return;
      }

      if (!this.marketFeedService.isMarketOpen()) {
        this.logger.debug('Market is closed — skipping auto-trade scan');
        return;
      }

      this.logger.log('Auto-trade scan started');

      // Clean up stale pending approvals before each scan
      this.cleanupExpiredApprovals();

      // Generate fresh signals from watchlist
      await this.signalGeneratorService.scanAllWatchlist();

      // Convert qualifying signals into trades
      await this.processActiveSignals();

      this.logger.log(
        `Auto-trade scan complete — ${JSON.stringify(this.lastScanStats)}`,
      );
    } catch (error) {
      this.logger.error(
        `Auto-trade scan failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Core: process active signals and route to execution / approval
  // ---------------------------------------------------------------------------

  async processActiveSignals(): Promise<ScanStats> {
    const stats: ScanStats = {
      processed: 0,
      executed: 0,
      pending: 0,
      skipped: 0,
      errors: 0,
      timestamp: new Date(),
    };

    const activeSignals = await this.signalRepository.getActiveSignals();
    const settings = await this.settingsService.getSettings();

    for (const signal of activeSignals) {
      stats.processed++;

      try {
        // Check if a trade already exists for this signal
        const signalWithTrades = await this.signalRepository.getSignalById(
          signal.id,
        );

        if (
          signalWithTrades?.trades &&
          signalWithTrades.trades.length > 0
        ) {
          this.logger.debug(
            `Signal ${signal.id} already has a trade — skipping`,
          );
          stats.skipped++;
          continue;
        }

        // Only process high-confidence signals
        if (signal.confidenceScore < 60) {
          this.logger.debug(
            `Signal ${signal.id} confidence ${signal.confidenceScore} < 60 — skipping`,
          );
          stats.skipped++;
          continue;
        }

        // Build the trade request from the signal
        const tradeRequest: ExecuteTradeDto = {
          symbol: signal.instrument.symbol,
          token: signal.instrument.token,
          exchange: signal.instrument.exchange,
          side: signal.side as any,
          orderType: 'MARKET' as any,
          quantity: await this.calculateQuantity(signal),
          price: signal.entryPrice,
          positionType: 'INTRADAY' as any,
          stoploss: signal.stoplossPrice,
          target: signal.targetPrice,
          signalId: signal.id,
          strategy: signal.strategy,
          source: 'AUTO',
        };

        // Route based on auto-trade mode
        switch (settings.autoTradeMode) {
          case 'FULLY_AUTOMATIC': {
            const trade =
              await this.tradeExecutionService.executeTrade(tradeRequest);
            this.logger.log(
              `Trade executed automatically for signal ${signal.id} — trade ${trade.id}`,
            );
            stats.executed++;
            break;
          }

          case 'APPROVAL_REQUIRED': {
            this.pendingApprovals.set(signal.id, {
              signal,
              tradeRequest,
              timestamp: new Date(),
            });

            this.tradeGateway.server.emit('auto-trade:pending-approval', {
              signal,
              tradeRequest,
              timestamp: new Date(),
            });

            this.logger.log(
              `Signal ${signal.id} queued for approval (${signal.instrument.symbol} ${signal.side})`,
            );
            stats.pending++;
            break;
          }

          case 'PAPER_TRADING': {
            // Paper mode is handled by the trade engine based on settings.paperTrading
            const trade =
              await this.tradeExecutionService.executeTrade(tradeRequest);
            this.logger.log(
              `Paper trade executed for signal ${signal.id} — trade ${trade.id}`,
            );
            stats.executed++;
            break;
          }

          default:
            this.logger.warn(
              `Unknown autoTradeMode "${settings.autoTradeMode}" — skipping signal ${signal.id}`,
            );
            stats.skipped++;
        }
      } catch (error) {
        this.logger.error(
          `Failed to process signal ${signal.id}: ${error instanceof Error ? error.message : error}`,
        );
        stats.errors++;
      }
    }

    this.lastScanStats = stats;
    return stats;
  }

  // ---------------------------------------------------------------------------
  // Quantity calculation
  // ---------------------------------------------------------------------------

  private async calculateQuantity(signal: any): Promise<number> {
    const settings = await this.settingsService.getSettings();
    const maxCapital = settings.maxCapitalPerTrade ?? 50000;

    let quantity = Math.floor(maxCapital / signal.entryPrice);

    // For options (NFO exchange), round down to lot size
    if (signal.instrument?.exchange?.includes('NFO')) {
      const lotSize = this.getOptionLotSize(signal.instrument.symbol);
      quantity = Math.max(lotSize, Math.floor(quantity / lotSize) * lotSize);
    }

    return Math.max(1, quantity);
  }

  /**
   * Return the standard lot size for common index options.
   * Falls back to 1 for unknown instruments.
   */
  private getOptionLotSize(symbol: string): number {
    const upper = symbol.toUpperCase();

    if (upper.includes('BANKNIFTY')) {
      return 25;
    }
    if (upper.includes('NIFTY')) {
      // Matches NIFTY but not BANKNIFTY (already handled above)
      return 50;
    }

    // FinNifty, individual stock options, etc.
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Approval workflow
  // ---------------------------------------------------------------------------

  async approveSignal(signalId: string): Promise<any> {
    const entry = this.pendingApprovals.get(signalId);

    if (!entry) {
      this.logger.warn(
        `Approval requested for signal ${signalId} but not found in pending queue`,
      );
      return null;
    }

    try {
      const trade = await this.tradeExecutionService.executeTrade(
        entry.tradeRequest,
      );
      this.pendingApprovals.delete(signalId);

      this.logger.log(
        `Approved and executed trade for signal ${signalId} — trade ${trade.id}`,
      );
      return trade;
    } catch (error) {
      this.logger.error(
        `Failed to execute approved signal ${signalId}: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  rejectSignal(signalId: string): void {
    const existed = this.pendingApprovals.delete(signalId);

    if (existed) {
      this.logger.log(`Signal ${signalId} rejected and removed from queue`);
    } else {
      this.logger.warn(
        `Rejection requested for signal ${signalId} but not found in pending queue`,
      );
    }
  }

  getPendingApprovals(): PendingApproval[] {
    return Array.from(this.pendingApprovals.values());
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  async getAutoTradeStatus(): Promise<AutoTradeStatus> {
    const settings = await this.settingsService.getSettings();
    const isMarketOpen = this.marketFeedService.isMarketOpen();

    return {
      mode: settings.autoTradeMode,
      isRunning: isMarketOpen && settings.autoTradeMode !== 'OFF',
      pendingApprovals: this.pendingApprovals.size,
      stats: this.lastScanStats,
    };
  }

  // ---------------------------------------------------------------------------
  // Force-execute a signal regardless of mode
  // ---------------------------------------------------------------------------

  async forceExecuteSignal(signalId: string): Promise<any> {
    const signal = await this.signalRepository.getSignalById(signalId);

    if (!signal) {
      this.logger.warn(`Force-execute requested but signal ${signalId} not found`);
      return null;
    }

    const tradeRequest: ExecuteTradeDto = {
      symbol: signal.instrument.symbol,
      token: signal.instrument.token,
      exchange: signal.instrument.exchange,
      side: signal.side as any,
      orderType: 'MARKET' as any,
      quantity: await this.calculateQuantity(signal),
      price: signal.entryPrice,
      positionType: 'INTRADAY' as any,
      stoploss: signal.stoplossPrice,
      target: signal.targetPrice,
      signalId: signal.id,
      strategy: signal.strategy,
      source: 'AUTO',
    };

    try {
      const trade =
        await this.tradeExecutionService.executeTrade(tradeRequest);
      this.logger.log(
        `Force-executed trade for signal ${signalId} — trade ${trade.id}`,
      );

      // Remove from pending approvals if it was there
      this.pendingApprovals.delete(signalId);

      return trade;
    } catch (error) {
      this.logger.error(
        `Force-execute failed for signal ${signalId}: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Housekeeping: expire stale pending approvals
  // ---------------------------------------------------------------------------

  private cleanupExpiredApprovals(): void {
    const now = Date.now();
    let removed = 0;

    for (const [signalId, entry] of this.pendingApprovals) {
      if (now - entry.timestamp.getTime() > AutoTradeService.APPROVAL_EXPIRY_MS) {
        this.pendingApprovals.delete(signalId);
        removed++;
        this.logger.log(
          `Expired pending approval for signal ${signalId} (older than 30 minutes)`,
        );
      }
    }

    if (removed > 0) {
      this.logger.log(`Cleaned up ${removed} expired pending approval(s)`);
    }
  }
}
