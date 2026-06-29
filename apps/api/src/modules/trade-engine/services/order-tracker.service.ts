import {
  Injectable,
  Logger,
  Inject,
  Optional,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  BrokerAdapter,
  OrderRequest,
} from '../../../common/interfaces/broker-adapter.interface';
import { BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';
import { TradeRepository } from '../repositories/trade.repository';
import { TradeGateway } from '../gateways/trade.gateway';
import {
  isSurveillanceRejection,
  cautionaryHint,
} from '../utils/cautionary';

/** Poll interval for order status (ms). */
const POLL_INTERVAL_MS = 2000;

/** Max polls before giving up (2s * 150 = 5 minutes). */
const MAX_POLLS = 150;

/** Terminal order statuses that stop polling. */
const TERMINAL_STATUSES = new Set([
  'complete',
  'COMPLETE',
  'FILLED',
  'rejected',
  'REJECTED',
  'cancelled',
  'CANCELLED',
]);

interface TrackedOrder {
  orderId: string;
  tradeId: string;
  pollCount: number;
  intervalHandle: ReturnType<typeof setInterval>;
  autoStoploss?: number;
  originalRequest?: OrderRequest;
}

@Injectable()
export class OrderTrackerService implements OnModuleDestroy {
  private readonly logger = new Logger(OrderTrackerService.name);

  /** Active tracking sessions keyed by orderId. */
  private readonly trackedOrders = new Map<string, TrackedOrder>();

  constructor(
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null,
    private readonly tradeRepository: TradeRepository,
    private readonly tradeGateway: TradeGateway,
  ) {}

  onModuleDestroy(): void {
    // Clear all polling intervals on shutdown
    for (const tracked of this.trackedOrders.values()) {
      clearInterval(tracked.intervalHandle);
    }
    this.trackedOrders.clear();
  }

  /**
   * Start polling the broker for order status updates.
   * Continues until a terminal status is reached or max polls exceeded.
   */
  trackOrder(
    orderId: string,
    tradeId: string,
    autoStoploss?: number,
    originalRequest?: OrderRequest,
  ): void {
    if (this.trackedOrders.has(orderId)) {
      this.logger.warn(`Order ${orderId} is already being tracked`);
      return;
    }

    this.logger.log(
      `Tracking order ${orderId} for trade ${tradeId}`,
    );

    const tracked: TrackedOrder = {
      orderId,
      tradeId,
      pollCount: 0,
      intervalHandle: null as any,
      autoStoploss,
      originalRequest,
    };

    tracked.intervalHandle = setInterval(
      () => this.pollOrderStatus(tracked),
      POLL_INTERVAL_MS,
    );

    this.trackedOrders.set(orderId, tracked);
  }

  /**
   * Cancel an order via the broker adapter.
   */
  async cancelOrder(orderId: string): Promise<void> {
    if (!this.brokerAdapter) {
      this.logger.warn('No broker adapter — cannot cancel order');
      return;
    }

    try {
      await this.brokerAdapter.cancelOrder(orderId);
      this.logger.log(`Order ${orderId} cancelled`);

      // Stop tracking
      const tracked = this.trackedOrders.get(orderId);
      if (tracked) {
        clearInterval(tracked.intervalHandle);
        this.trackedOrders.delete(orderId);

        await this.tradeRepository.updateTrade(tracked.tradeId, {
          status: 'CANCELLED',
        });

        const updatedTrade = await this.tradeRepository.getTradeById(
          tracked.tradeId,
        );
        if (updatedTrade) {
          this.tradeGateway.emitTradeUpdate(updatedTrade);
        }
      }
    } catch (error) {
      this.logger.error(
        `Failed to cancel order ${orderId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Get the current status of a tracked order.
   */
  async getOrderStatus(
    orderId: string,
  ): Promise<{ status: string; tracked: boolean }> {
    const tracked = this.trackedOrders.has(orderId);

    if (!this.brokerAdapter) {
      return { status: 'UNKNOWN', tracked };
    }

    try {
      const orders = await this.brokerAdapter.getOrders();
      const order = orders.find(
        (o: any) => o.orderid === orderId || o.orderId === orderId,
      );
      return {
        status: order?.status ?? order?.orderstatus ?? 'UNKNOWN',
        tracked,
      };
    } catch {
      return { status: 'UNKNOWN', tracked };
    }
  }

  // ------------------------------------------------------------------
  //  Private polling logic
  // ------------------------------------------------------------------

  private async pollOrderStatus(tracked: TrackedOrder): Promise<void> {
    tracked.pollCount++;

    if (tracked.pollCount > MAX_POLLS) {
      this.logger.warn(
        `Order ${tracked.orderId} — max polls exceeded, stopping tracker`,
      );
      clearInterval(tracked.intervalHandle);
      this.trackedOrders.delete(tracked.orderId);
      return;
    }

    if (!this.brokerAdapter) {
      return;
    }

    try {
      const orders = await this.brokerAdapter.getOrders();
      const order = orders.find(
        (o: any) =>
          o.orderid === tracked.orderId || o.orderId === tracked.orderId,
      );

      if (!order) return;

      const status: string =
        order.status ?? order.orderstatus ?? '';
      const normalizedStatus = status.toUpperCase();

      if (normalizedStatus === 'COMPLETE' || normalizedStatus === 'FILLED') {
        await this.handleOrderFilled(tracked, order);
      } else if (normalizedStatus === 'REJECTED') {
        await this.handleOrderRejected(tracked, order);
      } else if (normalizedStatus === 'CANCELLED') {
        await this.handleOrderCancelled(tracked);
      } else if (
        normalizedStatus === 'PARTIALLY_FILLED' ||
        normalizedStatus === 'PARTIAL'
      ) {
        await this.handlePartialFill(tracked, order);
      }

      // Stop tracking on terminal status
      if (TERMINAL_STATUSES.has(normalizedStatus)) {
        clearInterval(tracked.intervalHandle);
        this.trackedOrders.delete(tracked.orderId);
      }
    } catch (error) {
      this.logger.error(
        `Error polling order ${tracked.orderId}: ${error.message}`,
      );
    }
  }

  private async handleOrderFilled(
    tracked: TrackedOrder,
    order: any,
  ): Promise<void> {
    const fillPrice =
      parseFloat(order.averageprice ?? order.averagePrice ?? order.price) || 0;
    const filledQty =
      parseInt(order.filledshares ?? order.filledQuantity ?? order.quantity) ||
      0;

    this.logger.log(
      `Order ${tracked.orderId} FILLED: price=${fillPrice}, qty=${filledQty}`,
    );

    await this.tradeRepository.updateTrade(tracked.tradeId, {
      status: 'OPEN',
      entryPrice: fillPrice,
      entryTime: new Date(),
      quantity: filledQty || undefined,
    });

    // Place auto-stoploss if configured
    if (tracked.autoStoploss && tracked.originalRequest) {
      await this.placeAutoStoploss(tracked);
    }

    const updatedTrade = await this.tradeRepository.getTradeById(
      tracked.tradeId,
    );
    if (updatedTrade) {
      this.tradeGateway.emitTradeUpdate(updatedTrade);
    }
  }

  private async handleOrderRejected(
    tracked: TrackedOrder,
    order: any,
  ): Promise<void> {
    const reason = order.text ?? order.rejectionreason ?? 'Unknown reason';
    // Enrich a surveillance / cautionary / delivery-only (T2T) rejection
    // with actionable guidance so the note the UI shows tells the user to
    // switch Product to DELIVERY, matching the synchronous placeOrder path.
    const cautionary = isSurveillanceRejection(reason);
    const surfacedReason = cautionary ? cautionaryHint(reason) : reason;
    this.logger.warn(
      `Order ${tracked.orderId} REJECTED${cautionary ? ' (cautionary)' : ''}: ${surfacedReason}`,
    );

    await this.tradeRepository.updateTrade(tracked.tradeId, {
      status: 'REJECTED',
      notes: `Rejected: ${surfacedReason}`,
    });

    const updatedTrade = await this.tradeRepository.getTradeById(
      tracked.tradeId,
    );
    if (updatedTrade) {
      this.tradeGateway.emitTradeUpdate(updatedTrade);
    }
  }

  private async handleOrderCancelled(tracked: TrackedOrder): Promise<void> {
    this.logger.log(`Order ${tracked.orderId} CANCELLED`);

    await this.tradeRepository.updateTrade(tracked.tradeId, {
      status: 'CANCELLED',
    });

    const updatedTrade = await this.tradeRepository.getTradeById(
      tracked.tradeId,
    );
    if (updatedTrade) {
      this.tradeGateway.emitTradeUpdate(updatedTrade);
    }
  }

  private async handlePartialFill(
    tracked: TrackedOrder,
    order: any,
  ): Promise<void> {
    const filledQty =
      parseInt(order.filledshares ?? order.filledQuantity) || 0;
    const fillPrice =
      parseFloat(order.averageprice ?? order.averagePrice) || 0;

    this.logger.log(
      `Order ${tracked.orderId} PARTIAL FILL: qty=${filledQty}, price=${fillPrice}`,
    );

    await this.tradeRepository.updateTrade(tracked.tradeId, {
      status: 'PARTIALLY_FILLED',
      entryPrice: fillPrice,
      quantity: filledQty,
      entryTime: new Date(),
    });

    const updatedTrade = await this.tradeRepository.getTradeById(
      tracked.tradeId,
    );
    if (updatedTrade) {
      this.tradeGateway.emitTradeUpdate(updatedTrade);
    }
  }

  private async placeAutoStoploss(tracked: TrackedOrder): Promise<void> {
    if (!this.brokerAdapter || !tracked.originalRequest || !tracked.autoStoploss) {
      return;
    }

    try {
      const slSide =
        tracked.originalRequest.side === 'BUY' ? 'SELL' : 'BUY';

      const slOrder = {
        ...tracked.originalRequest,
        side: slSide as 'BUY' | 'SELL',
        orderType: 'STOPLOSS_MARKET' as const,
        triggerPrice: tracked.autoStoploss,
        price: undefined,
      };

      const response = await this.brokerAdapter.placeOrder(slOrder);
      this.logger.log(
        `Auto-stoploss placed for trade ${tracked.tradeId}: SL order ${response.orderId} @ ${tracked.autoStoploss}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to place auto-stoploss for trade ${tracked.tradeId}: ${error.message}`,
      );
    }
  }
}
