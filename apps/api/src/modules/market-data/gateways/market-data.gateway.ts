import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WS_NAMESPACE } from '@td/shared/constants';
import { Quote, OIData } from '@td/shared/types';
import { getUserIdFromSocket } from '../../../common/ws/authenticate-user-socket';
import { UserFeedManager } from '../services/user-feed-manager.service';
import type { FeedState, TokenRef } from '../services/user-feed.types';

export interface CandlePayload {
  token: string;
  timeframe: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ConnectionStatusPayload {
  connected: boolean;
  activeSubscriptions: number;
  timestamp: Date;
}

/**
 * Max flush rate for coalesced tick broadcasts. Angel One can emit hundreds
 * of ticks per second; the UI only needs a few updates per second per symbol.
 * 100ms → max 10 updates/sec per token regardless of upstream tick rate.
 */
const TICK_FLUSH_INTERVAL_MS = 100;

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4000';

/** Default exchange for a bare numeric token from the client. */
const DEFAULT_EXCHANGE = 'NSE';

/** Map a client-supplied token string to the broker TokenRef the manager wants. */
function toTokenRef(token: string): TokenRef {
  return { token, exchange: DEFAULT_EXCHANGE };
}

@WebSocketGateway({
  namespace: WS_NAMESPACE,
  cors: {
    origin: CORS_ORIGIN,
    credentials: true,
  },
  transports: ['polling', 'websocket'],
})
export class MarketDataGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(MarketDataGateway.name);

  @WebSocketServer()
  server: Server;

  /** Ids of currently connected (authenticated) sockets — for status reporting. */
  private readonly connectedClients = new Set<string>();

  /**
   * Latest pending quote per token, per user, awaiting the next flush tick.
   * Outer key: userId; inner key: token. Writes overwrite — stale prices are
   * discarded in favor of the newest before the next flush.
   */
  private readonly pendingTicks = new Map<string, Map<string, Quote>>();
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(private readonly userFeedManager: UserFeedManager) {}

  afterInit(): void {
    this.logger.log('Market Data WebSocket Gateway initialized');

    // Route the manager's userId-tagged tick/state events to the right room.
    this.userFeedManager.setHandlers(
      (userId, tick) => this.emitTickToUser(userId, tick as unknown as Quote),
      (userId, state) => this.emitFeedStateToUser(userId, state),
    );

    this.flushInterval = setInterval(
      () => this.flushPendingTicks(),
      TICK_FLUSH_INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flushPendingTicks();
  }

  handleConnection(client: Socket): void {
    const userId = getUserIdFromSocket(client);
    if (!userId) {
      this.logger.warn(`Rejected unauthenticated socket: ${client.id}`);
      client.disconnect();
      return;
    }
    client.data.userId = userId;
    client.join(`user:${userId}`);
    this.connectedClients.add(client.id);
    this.logger.log(`Client connected: ${client.id} (user ${userId})`);
  }

  handleDisconnect(client: Socket): void {
    this.connectedClients.delete(client.id);
    const userId = client.data?.userId as string | undefined;
    this.logger.log(`Client disconnected: ${client.id} (user ${userId ?? '?'})`);
    if (userId) {
      this.userFeedManager.releaseUser(userId);
    }
  }

  /**
   * Client subscribes to specific tokens for live updates. Interest is tracked
   * per-user by the UserFeedManager, which owns the broker feed session.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tokens: string[] },
  ): { event: string; data: { subscribed: string[] } } {
    const tokens = data?.tokens ?? [];
    const userId = client.data?.userId as string | undefined;

    if (userId && tokens.length > 0) {
      void this.userFeedManager.subscribe(userId, tokens.map(toTokenRef));
    }

    this.logger.debug(
      `Client ${client.id} (user ${userId ?? '?'}) subscribed to ${tokens.length} tokens`,
    );

    return {
      event: 'subscribed',
      data: { subscribed: tokens },
    };
  }

  /**
   * Client unsubscribes from specific tokens.
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tokens: string[] },
  ): { event: string; data: { unsubscribed: string[] } } {
    const tokens = data?.tokens ?? [];
    const userId = client.data?.userId as string | undefined;

    if (userId && tokens.length > 0) {
      void this.userFeedManager.unsubscribe(userId, tokens.map(toTokenRef));
    }

    this.logger.debug(
      `Client ${client.id} (user ${userId ?? '?'}) unsubscribed from ${tokens.length} tokens`,
    );

    return {
      event: 'unsubscribed',
      data: { unsubscribed: tokens },
    };
  }

  // ------------------------------------------------------------------
  //  Per-user push methods (fed by UserFeedManager handlers)
  // ------------------------------------------------------------------

  /**
   * Queue a tick for the next flush, scoped to one user. Per-user, per-token
   * coalescing: if multiple ticks for the same token arrive within the flush
   * window, only the latest is broadcast to that user's room.
   */
  emitTickToUser(userId: string, quote: Quote): void {
    let userPending = this.pendingTicks.get(userId);
    if (!userPending) {
      userPending = new Map<string, Quote>();
      this.pendingTicks.set(userId, userPending);
    }
    userPending.set(quote.token, quote);
  }

  private flushPendingTicks(): void {
    if (this.pendingTicks.size === 0) return;
    for (const [userId, userPending] of this.pendingTicks) {
      for (const quote of userPending.values()) {
        this.server.to(`user:${userId}`).emit('tick', quote);
      }
    }
    this.pendingTicks.clear();
  }

  /** Test hook: run the coalesced flush synchronously. */
  flushForTest(): void {
    this.flushPendingTicks();
  }

  /**
   * Emit a closed candle to a single user's room. Candles are not coalesced —
   * each closed candle is a discrete event.
   */
  emitCandleToUser(userId: string, candle: CandlePayload): void {
    this.server.to(`user:${userId}`).emit('candle', candle);
  }

  /** Emit the broker feed lifecycle state to a single user's room. */
  emitFeedStateToUser(userId: string, state: FeedState): void {
    this.server.to(`user:${userId}`).emit('feed-state', state);
  }

  // ------------------------------------------------------------------
  //  DEPRECATED global push methods — kept only so the legacy single-feed
  //  `MarketFeedService` still compiles during the per-user migration.
  //  In the per-user design ticks/candles flow via UserFeedManager handlers
  //  → emitTickToUser / emitCandleToUser. These are intentional no-ops: the
  //  old global broadcast is removed. Task 6 rewires MarketFeedService (or its
  //  callers) to the per-user path and can then delete these stubs.
  // ------------------------------------------------------------------

  /** @deprecated No-op. Global tick broadcast removed; use emitTickToUser. */
  emitTick(_quote: Quote): void {
    // intentionally empty — see block comment above
  }

  /** @deprecated No-op. Global candle broadcast removed; use emitCandleToUser. */
  emitCandle(_candle: CandlePayload): void {
    // intentionally empty — see block comment above
  }

  /**
   * Emit OI update to clients subscribed to that token's room.
   * NOTE: per-user OI routing is out of scope for this task; retained on the
   * legacy `token:` room so `oi-tracker.processor` keeps compiling.
   */
  emitOIUpdate(data: OIData): void {
    this.server.to(`token:${data.token}`).emit('oi-update', data);
  }

  /**
   * Broadcast connection status to ALL connected clients.
   */
  emitConnectionStatus(status: ConnectionStatusPayload): void {
    this.server.emit('connection-status', status);
  }

  /**
   * Get the count of currently connected (authenticated) clients.
   */
  getConnectedClientCount(): number {
    return this.connectedClients.size;
  }
}
