import {
  Injectable,
  Logger,
  Inject,
  Optional,
  OnModuleInit,
} from '@nestjs/common';
import {
  BrokerAdapter,
  TickData,
} from '../../../common/interfaces/broker-adapter.interface';
import { BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { TradeRepository } from '../repositories/trade.repository';
import { TradeGateway } from '../gateways/trade.gateway';
import { RiskManagerService } from './risk-manager.service';
import { Position, Exchange, OrderSide } from '@td/shared/types';
import { DailyPerformanceData } from '../dto/trade.dto';

/**
 * In-memory position representation with real-time P&L tracking.
 */
interface LivePosition extends Position {
  token: string;
  tradeId: string;
  entryPrice: number;
  positionType: string;
}

@Injectable()
export class PositionManagerService implements OnModuleInit {
  private readonly logger = new Logger(PositionManagerService.name);

  /** In-memory map of open positions keyed by tradeId. */
  private readonly positions = new Map<string, LivePosition>();

  /** Today's realized P&L from closed trades. */
  private todayRealizedPnl = 0;

  constructor(
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null,
    private readonly marketFeedService: MarketFeedService,
    private readonly tradeRepository: TradeRepository,
    private readonly tradeGateway: TradeGateway,
    private readonly riskManagerService: RiskManagerService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Load existing open trades into in-memory position map
    await this.loadOpenPositions();
  }

  /**
   * Called on every tick for instruments with open positions.
   * Updates live MTM P&L and pushes updates via WebSocket.
   */
  updatePositionPnL(tick: TickData): void {
    let updated = false;

    for (const position of this.positions.values()) {
      if (position.token === tick.token) {
        position.ltp = tick.ltp;
        const multiplier = position.side === OrderSide.BUY ? 1 : -1;
        position.pnl =
          multiplier *
          (tick.ltp - position.entryPrice) *
          position.quantity;
        position.pnlPercent =
          position.entryPrice > 0
            ? (position.pnl / (position.entryPrice * position.quantity)) * 100
            : 0;
        updated = true;
      }
    }

    if (updated) {
      // Update risk manager with current unrealized P&L
      const unrealizedPnl = this.getUnrealizedPnl();
      this.riskManagerService.updateUnrealizedPnl(unrealizedPnl);

      // Update capital deployed
      const capitalDeployed = this.getCapitalDeployed();
      this.riskManagerService.updateCapitalDeployed(capitalDeployed);

      // Emit position updates to connected clients
      this.tradeGateway.emitPositionUpdate(this.getPositions());
    }
  }

  /**
   * Get all open positions with live MTM P&L.
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values()).map((p) => ({
      symbol: p.symbol,
      exchange: p.exchange,
      side: p.side,
      quantity: p.quantity,
      averagePrice: p.averagePrice,
      ltp: p.ltp,
      pnl: p.pnl,
      pnlPercent: p.pnlPercent,
    }));
  }

  /**
   * Get a single position by symbol, or null if not found.
   */
  getPosition(symbol: string): Position | null {
    for (const position of this.positions.values()) {
      if (position.symbol === symbol) {
        return {
          symbol: position.symbol,
          exchange: position.exchange,
          side: position.side,
          quantity: position.quantity,
          averagePrice: position.averagePrice,
          ltp: position.ltp,
          pnl: position.pnl,
          pnlPercent: position.pnlPercent,
        };
      }
    }
    return null;
  }

  /**
   * Get today's total P&L (realized + unrealized).
   */
  getTodayPnL(): number {
    return this.todayRealizedPnl + this.getUnrealizedPnl();
  }

  /**
   * Get today's performance summary.
   */
  async getDailyPerformance(): Promise<DailyPerformanceData> {
    const todayTrades = await this.tradeRepository.getTodayTrades();
    const closedTrades = todayTrades.filter((t) => t.status === 'CLOSED');
    const winningTrades = closedTrades.filter(
      (t) => (t.pnl ?? 0) > 0,
    ).length;
    const losingTrades = closedTrades.filter(
      (t) => (t.pnl ?? 0) < 0,
    ).length;

    const realizedPnl = closedTrades.reduce(
      (sum, t) => sum + (t.pnl ?? 0),
      0,
    );
    const unrealizedPnl = this.getUnrealizedPnl();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return {
      date: today,
      totalPnl: realizedPnl + unrealizedPnl,
      realizedPnl,
      unrealizedPnl,
      totalTrades: todayTrades.length,
      winningTrades,
      losingTrades,
      maxDrawdown: 0, // TODO: track intraday max drawdown
      capitalDeployed: this.getCapitalDeployed(),
    };
  }

  /**
   * Fetch positions from the broker and reconcile with local state.
   */
  async syncWithBroker(): Promise<void> {
    if (!this.brokerAdapter) {
      this.logger.warn('No broker adapter — cannot sync positions');
      return;
    }

    try {
      const brokerPositions = await this.brokerAdapter.getPositions();
      this.logger.log(
        `Syncing ${brokerPositions.length} positions from broker`,
      );

      // Log discrepancies between broker and local state
      for (const bp of brokerPositions) {
        const localMatch = Array.from(this.positions.values()).find(
          (p) =>
            p.symbol === bp.symbol &&
            p.exchange === bp.exchange &&
            p.side === bp.side,
        );

        if (localMatch) {
          if (localMatch.quantity !== bp.quantity) {
            this.logger.warn(
              `Position mismatch for ${bp.symbol}: local qty=${localMatch.quantity}, broker qty=${bp.quantity}`,
            );
            localMatch.quantity = bp.quantity;
            localMatch.averagePrice = bp.averagePrice;
          }
        } else if (bp.quantity > 0) {
          this.logger.warn(
            `Broker has position not tracked locally: ${bp.symbol} ${bp.side} x${bp.quantity}`,
          );
        }
      }

      this.logger.log('Position sync complete');
    } catch (error) {
      this.logger.error(`Position sync failed: ${error.message}`);
    }
  }

  /**
   * Add a new position to the in-memory tracker.
   * Called by TradeExecutionService when a trade is opened.
   */
  addPosition(
    tradeId: string,
    data: {
      symbol: string;
      token: string;
      exchange: string;
      side: string;
      quantity: number;
      averagePrice: number;
      positionType: string;
    },
  ): void {
    const position: LivePosition = {
      tradeId,
      symbol: data.symbol,
      token: data.token,
      exchange: data.exchange as Exchange,
      side: data.side as OrderSide,
      quantity: data.quantity,
      averagePrice: data.averagePrice,
      entryPrice: data.averagePrice,
      ltp: data.averagePrice,
      pnl: 0,
      pnlPercent: 0,
      positionType: data.positionType,
    };

    this.positions.set(tradeId, position);

    // Subscribe to ticks for this instrument
    this.subscribeToTicks(data.token);

    this.logger.log(
      `Position added: ${data.side} ${data.symbol} x${data.quantity} @ ${data.averagePrice}`,
    );
  }

  /**
   * Remove a position from the in-memory tracker.
   * Called by TradeExecutionService when a trade is closed.
   */
  removePosition(tradeId: string, realizedPnl: number): void {
    const position = this.positions.get(tradeId);
    if (position) {
      this.todayRealizedPnl += realizedPnl;
      this.positions.delete(tradeId);
      this.logger.log(
        `Position removed: ${position.symbol}, realized P&L: ${realizedPnl.toFixed(2)}`,
      );
    }
  }

  /**
   * Reduce an open position after a PARTIAL close: shrink the tracked
   * quantity by the closed slice and book that slice's realized P&L. Called
   * by TradeExecutionService on a partial close so the in-memory position
   * never overstates what is actually still open (a stale, un-reduced size
   * would feed the risk engine and get_positions a 2x quantity). Deletes the
   * position if the reduction takes it to zero.
   */
  reducePosition(tradeId: string, closedQty: number, realizedPnl: number): void {
    const position = this.positions.get(tradeId);
    if (!position) return;
    this.todayRealizedPnl += realizedPnl;
    position.quantity = Math.max(0, position.quantity - closedQty);
    if (position.quantity <= 0) {
      this.positions.delete(tradeId);
      this.logger.log(`Position fully reduced and removed: ${position.symbol}`);
    } else {
      this.logger.log(
        `Position reduced: ${position.symbol} -${closedQty} -> ${position.quantity}, ` +
          `realized slice P&L: ${realizedPnl.toFixed(2)}`,
      );
    }
  }

  /**
   * Get all open position trade IDs and their symbols.
   */
  getOpenPositionEntries(): Array<{
    tradeId: string;
    symbol: string;
    exchange: string;
    side: string;
    quantity: number;
  }> {
    return Array.from(this.positions.values()).map((p) => ({
      tradeId: p.tradeId,
      symbol: p.symbol,
      exchange: p.exchange,
      side: p.side,
      quantity: p.quantity,
    }));
  }

  // ------------------------------------------------------------------
  //  Private helpers
  // ------------------------------------------------------------------

  private getUnrealizedPnl(): number {
    let total = 0;
    for (const position of this.positions.values()) {
      total += position.pnl;
    }
    return total;
  }

  private getCapitalDeployed(): number {
    let total = 0;
    for (const position of this.positions.values()) {
      total += position.averagePrice * position.quantity;
    }
    return total;
  }

  private async loadOpenPositions(): Promise<void> {
    try {
      const openTrades = await this.tradeRepository.getOpenTrades();
      for (const trade of openTrades) {
        const instrument = (trade as any).instrument;
        if (!instrument || !trade.entryPrice) continue;

        this.addPosition(trade.id, {
          symbol: instrument.symbol,
          token: instrument.token,
          exchange: instrument.exchange,
          side: trade.side,
          quantity: trade.quantity,
          averagePrice: trade.entryPrice,
          positionType: trade.positionType,
        });
      }

      if (openTrades.length > 0) {
        this.logger.log(
          `Loaded ${openTrades.length} open positions from database`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to load open positions: ${error.message}`,
      );
    }
  }

  private subscribeToTicks(token: string): void {
    try {
      (this.marketFeedService as any).subscribeToFeed?.(
        [token],
        (tick: TickData) => this.updatePositionPnL(tick),
      );
    } catch {
      // MarketFeedService may not expose subscribeToFeed directly;
      // ticks will be routed via the trade execution service instead.
    }
  }
}
