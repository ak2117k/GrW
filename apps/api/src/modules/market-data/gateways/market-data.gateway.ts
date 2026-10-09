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
import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Server, Socket } from 'socket.io';
import { WS_NAMESPACE } from '@td/shared/constants';
import { OIData } from '@td/shared/types';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import { getUserIdFromSocket } from '../../../common/ws/authenticate-user-socket';
import { UserFeedManager } from '../services/user-feed-manager.service';
import type { FeedState, TokenRef } from '../services/user-feed.types';
import {
  BROWSER_RENEW_MS,
  BROWSER_WATCH_TTL_MS,
  MAX_BROWSER_REFS_PER_SOCKET,
  browserOwner,
  browserPriority,
  parseFeedRefs,
  priceToBrowserTick,
  type SubscribeBody,
} from '../../market-hub/browser-feed';
import { lookupHubPrices, type HubPriceSource, type HubPrices } from '../../market-hub/hub-prices';
import { refKey, type InstrumentRef, type Priority } from '../../market-hub/hub.types';

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
 * 100ms → max 10 updates/sec per instrument regardless of upstream tick rate.
 */
const TICK_FLUSH_INTERVAL_MS = 100;

const CORS_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:4000';

/** The manager's TokenRef for a parsed browser ref: the client's own exchange, never a hard-coded NSE. */
function toTokenRef(ref: InstrumentRef): TokenRef {
  return { token: ref.token, exchange: ref.exchange };
}

/** Coalescing key: EXCHANGE:token. Tokens collide across exchanges (NSE cash vs NFO vs MCX). */
function tickKey(tick: TickData): string {
  return `${tick.exchange ?? ''}:${tick.token}`;
}

/** hub.watch / hub.unwatch never reject by contract; this keeps a broken hub from ever surfacing. */
function quietly(p: Promise<unknown>): void {
  void Promise.resolve(p).catch(() => undefined);
}

/** One hub-served socket: its user, that user's hub, and what it watches (≤ MAX_BROWSER_REFS_PER_SOCKET). */
interface HubSocket {
  userId: string;
  hub: HubPrices;
  watches: Map<string, { ref: InstrumentRef; priority: Priority }>;
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
   * Latest pending tick per instrument, per user, awaiting the next flush.
   * Outer key: userId; inner key: EXCHANGE:token. Writes overwrite — stale
   * prices are discarded in favor of the newest before the next flush.
   */
  private readonly pendingTicks = new Map<string, Map<string, TickData>>();
  private flushInterval: NodeJS.Timeout | null = null;

  /**
   * SP1 M4 (HUB_SERVES_BROWSER). A socket whose user `hubFor(userId, 'browser')`
   * serves is fed by that user's hub: its subscriptions are hub watches (priority
   * from the purpose, TTL renewed), and every hub price reaches the user's room.
   * Everyone else keeps the UserFeedManager path below.
   */
  private hubSourceRef: HubPriceSource | null = null;
  private readonly hubSockets = new Map<string, HubSocket>();
  /** One hub price listener per hub-served user, alive while that user has a hub-served socket. */
  private readonly hubListeners = new Map<string, { off: () => void; sockets: number }>();
  private renewTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly userFeedManager: UserFeedManager,
    // Resolves HUB_PRICE_SOURCE lazily: MarketHubModule imports MarketDataModule, so injecting it would cycle.
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  afterInit(): void {
    this.logger.log('Market Data WebSocket Gateway initialized');

    // Route the manager's userId-tagged tick/state events to the right room.
    this.userFeedManager.setHandlers(
      (userId, tick) => this.emitTickToUser(userId, tick),
      (userId, state) => this.emitFeedStateToUser(userId, state),
    );

    this.flushInterval = setInterval(
      () => this.flushPendingTicks(),
      TICK_FLUSH_INTERVAL_MS,
    );
    this.renewTimer = setInterval(() => this.renewHubWatches(), BROWSER_RENEW_MS);
    this.renewTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    for (const l of this.hubListeners.values()) l.off();
    this.hubListeners.clear();
    this.hubSockets.clear();
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
    const hub = this.hubFor(userId);
    if (hub) this.attachHub(client.id, userId, hub);
    // Tells the browser whether its quote/depth/indices/watchlist/live-edge polls may stop while Live.
    client.emit('feed-source', { source: hub ? 'hub' : 'legacy' });
    this.logger.log(`Client connected: ${client.id} (user ${userId}, ${hub ? 'hub' : 'legacy'} feed)`);
  }

  handleDisconnect(client: Socket): void {
    this.connectedClients.delete(client.id);
    this.detachHub(client.id);
    const userId = client.data?.userId as string | undefined;
    this.logger.log(`Client disconnected: ${client.id} (user ${userId ?? '?'})`);
    if (userId) {
      this.userFeedManager.releaseUser(userId);
    }
  }

  /**
   * Client subscribes to instruments for live updates. Each ref carries its
   * exchange (parseFeedRefs). A hub-served socket watches on its user's hub at
   * the purpose's priority; any other socket goes to the UserFeedManager,
   * which owns that user's broker feed session.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SubscribeBody,
  ): { event: string; data: { subscribed: string[] } } {
    const { refs, bareTokens } = parseFeedRefs(data);
    const userId = client.data?.userId as string | undefined;

    if (userId && refs.length > 0) {
      const hubSocket = this.hubSockets.get(client.id);
      if (hubSocket) {
        this.watchOnHub(client.id, hubSocket, refs, browserPriority(data?.purpose));
      } else {
        // Floated: the ack returns immediately. subscribe() can reject (e.g. the
        // per-user feed flag is disabled → factory throws) — swallow it here so a
        // rejected promise never becomes an unhandledRejection / process crash.
        // No secrets in the message.
        this.userFeedManager.subscribe(userId, refs.map(toTokenRef)).catch((err) => {
          this.logger.debug(
            `subscribe failed for user ${userId}: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    }
    if (bareTokens > 0) {
      this.logger.debug(`Client ${client.id} sent ${bareTokens} token(s) without an exchange; taken as NSE (old client)`);
    }

    this.logger.debug(
      `Client ${client.id} (user ${userId ?? '?'}) subscribed to ${refs.length} instrument(s)`,
    );

    return {
      event: 'subscribed',
      data: { subscribed: refs.map((r) => r.token) },
    };
  }

  /**
   * Client unsubscribes from instruments (same exchange-aware refs).
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SubscribeBody,
  ): { event: string; data: { unsubscribed: string[] } } {
    const { refs } = parseFeedRefs(data);
    const userId = client.data?.userId as string | undefined;

    if (userId && refs.length > 0) {
      const hubSocket = this.hubSockets.get(client.id);
      if (hubSocket) {
        const gone = refs.filter((r) => hubSocket.watches.delete(refKey(r)));
        if (gone.length > 0) quietly(hubSocket.hub.unwatch(gone, browserOwner(client.id)));
      } else {
        // Floated + guarded like handleSubscribe: a rejection must not surface as
        // an unhandledRejection.
        this.userFeedManager.unsubscribe(userId, refs.map(toTokenRef)).catch((err) => {
          this.logger.debug(
            `unsubscribe failed for user ${userId}: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    }

    this.logger.debug(
      `Client ${client.id} (user ${userId ?? '?'}) unsubscribed from ${refs.length} instrument(s)`,
    );

    return {
      event: 'unsubscribed',
      data: { unsubscribed: refs.map((r) => r.token) },
    };
  }

  // ------------------------------------------------------------------
  //  Per-user push methods
  // ------------------------------------------------------------------

  /**
   * Queue a UserFeedManager tick for the next flush, scoped to one user. The
   * emitted `'tick'` payload is the raw `TickData` shape (NOT a `Quote`).
   * Dropped for a hub-served user: the hub runs on that same session and
   * already pushes this instrument (exchange-exact, with polled quotes too).
   */
  emitTickToUser(userId: string, tick: TickData): void {
    if (this.hubListeners.has(userId)) return;
    this.queueTick(userId, tick);
  }

  private queueTick(userId: string, tick: TickData): void {
    let userPending = this.pendingTicks.get(userId);
    if (!userPending) {
      userPending = new Map<string, TickData>();
      this.pendingTicks.set(userId, userPending);
    }
    userPending.set(tickKey(tick), tick);
  }

  private flushPendingTicks(): void {
    if (this.pendingTicks.size === 0) return;
    for (const [userId, userPending] of this.pendingTicks) {
      for (const tick of userPending.values()) {
        this.server.to(`user:${userId}`).emit('tick', tick);
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

  /**
   * Emit OI update to clients subscribed to that token's room.
   * NOTE: currently inert — there is NO frontend `'oi-update'` consumer, and
   * this still emits to the legacy `token:` room (no client joins it) rather
   * than the per-user room. Retained so `oi-tracker.processor` keeps compiling;
   * needs per-user OI routing (like emitTickToUser) when a consumer returns.
   */
  emitOIUpdate(data: OIData): void {
    this.server.to(`token:${data.token}`).emit('oi-update', data);
  }

  /**
   * Broadcast connection status to ALL connected clients.
   */
  emitConnectionStatus(status: ConnectionStatusPayload): void {
    // `@WebSocketServer()` is only populated when an HTTP server is attached.
    // A headless boot — `NestFactory.createApplicationContext`, used by workers
    // and one-shot scripts — has none, so this is null and the unguarded emit
    // took the whole process down from inside the feed's auto-start. Nobody is
    // listening in that mode, so dropping the broadcast is the correct no-op.
    this.server?.emit('connection-status', status);
  }

  /**
   * Get the count of currently connected (authenticated) clients.
   */
  getConnectedClientCount(): number {
    return this.connectedClients.size;
  }

  // ------------------------------------------------------------------
  //  SP1 M4 hub path
  // ------------------------------------------------------------------

  /** THE seam (hub-prices.ts): this user's hub for the browser, or null for the legacy path. */
  private hubFor(userId: string): HubPrices | null {
    try {
      if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
      return this.hubSourceRef?.hubFor(userId, 'browser') ?? null;
    } catch {
      return null;
    }
  }

  private attachHub(socketId: string, userId: string, hub: HubPrices): void {
    this.hubSockets.set(socketId, { userId, hub, watches: new Map() });
    const listener = this.hubListeners.get(userId);
    if (listener) {
      listener.sockets++;
      return;
    }
    const off = hub.onPrice((p) => this.queueTick(userId, priceToBrowserTick(p)));
    this.hubListeners.set(userId, { off, sockets: 1 });
  }

  private detachHub(socketId: string): void {
    const s = this.hubSockets.get(socketId);
    if (!s) return;
    this.hubSockets.delete(socketId);
    if (s.watches.size > 0) {
      quietly(s.hub.unwatch([...s.watches.values()].map((w) => w.ref), browserOwner(socketId)));
    }
    const listener = this.hubListeners.get(s.userId);
    if (listener && --listener.sockets <= 0) {
      listener.off();
      this.hubListeners.delete(s.userId);
    }
  }

  /** New refs, and refs whose priority this subscribe raises; bounded per socket. */
  private watchOnHub(socketId: string, s: HubSocket, refs: InstrumentRef[], priority: Priority): void {
    const fresh: InstrumentRef[] = [];
    for (const ref of refs) {
      const key = refKey(ref);
      const had = s.watches.get(key);
      if (had && had.priority <= priority) continue; // already watched at least this urgently
      if (!had && s.watches.size >= MAX_BROWSER_REFS_PER_SOCKET) continue;
      s.watches.set(key, { ref, priority });
      fresh.push(ref);
    }
    if (fresh.length > 0) quietly(s.hub.watch(fresh, priority, browserOwner(socketId), BROWSER_WATCH_TTL_MS));
  }

  /** Every BROWSER_RENEW_MS: renew each socket's watches before their TTL lapses. */
  private renewHubWatches(): void {
    for (const [socketId, s] of this.hubSockets) {
      const byPriority = new Map<Priority, InstrumentRef[]>();
      for (const w of s.watches.values()) {
        const list = byPriority.get(w.priority);
        if (list) list.push(w.ref);
        else byPriority.set(w.priority, [w.ref]);
      }
      for (const [priority, refs] of byPriority) {
        quietly(s.hub.watch(refs, priority, browserOwner(socketId), BROWSER_WATCH_TTL_MS));
      }
    }
  }
}
