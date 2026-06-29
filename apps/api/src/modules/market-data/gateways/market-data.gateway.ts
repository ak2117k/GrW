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

  /** Track which tokens each client is interested in. */
  private readonly clientSubscriptions = new Map<string, Set<string>>();

  /**
   * Latest pending quote per token, awaiting the next flush tick.
   * Writes overwrite — stale prices are discarded in favor of the newest.
   */
  private readonly pendingTicks = new Map<string, Quote>();
  private flushInterval: NodeJS.Timeout | null = null;

  afterInit(): void {
    this.logger.log('Market Data WebSocket Gateway initialized');
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
    this.logger.log(`Client connected: ${client.id}`);
    this.clientSubscriptions.set(client.id, new Set());
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.clientSubscriptions.delete(client.id);
  }

  /**
   * Client subscribes to specific tokens for live updates.
   * The client joins a Socket.IO room per token so we can emit targeted updates.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tokens: string[] },
  ): { event: string; data: { subscribed: string[] } } {
    const tokens = data?.tokens ?? [];
    const subs = this.clientSubscriptions.get(client.id);

    for (const token of tokens) {
      client.join(`token:${token}`);
      subs?.add(token);
    }

    this.logger.debug(
      `Client ${client.id} subscribed to ${tokens.length} tokens`,
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
    const subs = this.clientSubscriptions.get(client.id);

    for (const token of tokens) {
      client.leave(`token:${token}`);
      subs?.delete(token);
    }

    this.logger.debug(
      `Client ${client.id} unsubscribed from ${tokens.length} tokens`,
    );

    return {
      event: 'unsubscribed',
      data: { unsubscribed: tokens },
    };
  }

  // ------------------------------------------------------------------
  //  Methods called by MarketFeedService to push data to clients
  // ------------------------------------------------------------------

  /**
   * Queue a tick for the next flush. Per-token coalescing: if multiple ticks
   * for the same token arrive within the flush window, only the latest is
   * broadcast. Clients still filter by token — broadcast target is unchanged.
   */
  emitTick(quote: Quote): void {
    this.pendingTicks.set(quote.token, quote);
  }

  private flushPendingTicks(): void {
    if (this.pendingTicks.size === 0) return;
    for (const quote of this.pendingTicks.values()) {
      this.server.emit('tick', quote);
    }
    this.pendingTicks.clear();
  }

  /**
   * Emit a closed candle to all clients subscribed to that token.
   */
  emitCandle(candle: CandlePayload): void {
    this.server.emit('candle', candle);
  }

  /**
   * Emit OI update to all clients subscribed to that token.
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
   * Get the count of currently connected clients.
   */
  getConnectedClientCount(): number {
    return this.clientSubscriptions.size;
  }
}
