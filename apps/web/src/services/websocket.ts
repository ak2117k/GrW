import { io, Socket } from 'socket.io-client';
import { getStoredAccessToken } from './auth-storage';
import {
  nextRetryDelayMs,
  shouldResetRetries,
  shouldRetryServerDisconnect,
} from './ws-retry';
import { classifyFeed, type FeedHealth } from './feed-health';

/**
 * Shape the socket.io handshake `auth` payload from a JWT access token.
 * The backend `/ws` gateway REQUIRES `handshake.auth.token` and disconnects
 * unauthenticated sockets. Pure so it can be unit-tested without a socket.
 */
export function buildHandshakeAuth(token: string): { token: string } {
  return { token };
}

/**
 * Shape the outbound `subscribe`/`unsubscribe` message body. The server
 * drives a per-user Angel feed from these token lists. Pure by design.
 */
export function toSubscribePayload(tokens: string[]): { tokens: string[] } {
  return { tokens };
}

/**
 * Read the current access token the SAME way the shared api instance does —
 * straight from localStorage (never importing the auth-store, which would
 * create an import cycle: auth-store imports services). Reading fresh on each
 * call means reconnects pick up a token refreshed by the api interceptor.
 */
function getAccessToken(): string {
  return getStoredAccessToken() ?? '';
}

/**
 * Frontend names for events delivered across all WebSocket namespaces.
 * Backend gateways live on three separate namespaces; this client
 * multiplexes them so consumers can subscribe by event name without
 * caring about which socket carries it.
 *
 *  /ws            — MarketDataGateway, SignalGateway
 *  /ws/trades     — TradeGateway (trade lifecycle, positions, risk)
 *  /ws/auto-trade — AutoTradeGateway (auto-execution lifecycle)
 */
export type WSEventName =
  // /ws
  | 'tick'
  | 'signal'
  | 'alert'
  | 'candle'
  | 'feed-state'
  // /ws/trades
  | 'trade-update'
  | 'position-update'
  | 'risk-status'
  | 'kill-switch-activated'
  // /ws/auto-trade
  | 'auto-trade:pending-approval'
  | 'auto-trade:signal-approved'
  | 'auto-trade:signal-rejected'
  | 'auto-trade:executed'
  | 'auto-trade:scan-complete'
  | 'auto-trade:error'
  // synthetic
  | 'connection-status'
  // The honest feed verdict — tick-socket freshness, not namespace count.
  | 'feed-health';

type EventCallback = (data: unknown) => void;

interface NamespaceConfig {
  /** Socket.io namespace path (e.g. `/ws`, `/ws/trades`). */
  path: string;
  /** Server-emitted event names this namespace publishes. */
  events: readonly string[];
}

/**
 * Authoritative list of namespaces + the events each one carries.
 * Adding a new gateway? Add a new entry here and the rest of the app
 * picks it up automatically (subscribers route by event name).
 */
const NAMESPACES: readonly NamespaceConfig[] = [
  {
    path: '/ws',
    events: ['tick', 'signal', 'alert', 'candle', 'feed-state'],
  },
  {
    path: '/ws/trades',
    events: [
      'trade-update',
      'position-update',
      'risk-status',
      'kill-switch-activated',
    ],
  },
  {
    path: '/ws/auto-trade',
    events: [
      'auto-trade:pending-approval',
      'auto-trade:signal-approved',
      'auto-trade:signal-rejected',
      'auto-trade:executed',
      'auto-trade:scan-complete',
      'auto-trade:error',
    ],
  },
  {
    path: '/ws/telegram',
    events: ['telegram:signal-update'] as const,
  },
];

class WebSocketService {
  private sockets = new Map<string, Socket>();
  private listeners = new Map<string, Set<EventCallback>>();
  /** Number of currently-connected namespace sockets. */
  private connectedCount = 0;

  /** Wall-clock of the last 'tick' frame received on /ws. */
  private lastTickAt = 0;
  /** Per-namespace connected state. Only /ws is allowed to decide feed health. */
  private nsConnected = new Map<string, boolean>();

  /** Negotiated transport for the /ws socket ('polling' | 'websocket'), or null. */
  private transport: string | null = null;
  /**
   * Tokens the app has asked the server to stream on /ws. Held so we can
   * re-emit `subscribe` after a reconnect (the server forgets on disconnect).
   */
  private subscribedTokens = new Set<string>();

  connect(): void {
    if (this.sockets.size > 0) return;

    // No token yet (app booting on /login) — do NOT open the sockets. The /ws
    // gateway rejects a handshake without a JWT, socket.io treats that "io
    // server disconnect" as terminal, and our manual retry below is token-gated,
    // so a pre-login connect() would leave the tick feed dead for the whole
    // session. Bailing here keeps `sockets` empty so the post-login connect()
    // (App.tsx, on auth status -> 'authed') actually opens them.
    if (!getAccessToken()) return;

    for (const ns of NAMESPACES) {
      const sock = io(ns.path, {
        path: '/socket.io',
        // websocket first — fall back to polling only if the upgrade fails.
        transports: ['websocket', 'polling'],
        // Per-user auth: the backend gateway requires a JWT in the handshake and
        // disconnects sockets without a valid one. FUNCTION form (not a static
        // object) so the token is read FRESH on every attempt — the initial
        // connect AND every retry. A static `auth` would capture whatever token
        // existed when connect() ran (possibly empty pre-login, or an expired
        // access token), and socket.io never refreshes it on its own.
        auth: (cb: (data: { token: string }) => void) =>
          cb(buildHandshakeAuth(getAccessToken())),
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
      });

      // socket.io does NOT auto-reconnect after an "io server disconnect": a
      // server-initiated disconnect (here, the gateway rejecting a stale/empty
      // handshake token) is treated as terminal. So we retry manually — with a
      // fresh token via the auth function above — capped and back-off delayed so
      // a genuinely-invalid token (logged out) can't spin a hot loop. The count
      // resets on a successful connect.
      let serverDropRetries = 0;
      // When this socket last came up. The ADMIN-only gateways accept the
      // handshake and reject inside handleConnection, so 'connect' fires on
      // every FAILED attempt too — clearing the counter here would defeat the
      // cap entirely (that is the /ws/telegram connect/disconnect loop). Only a
      // connection that STAYS up clears it; see ws-retry.ts.
      let connectedAt = 0;

      sock.on('connect', () => {
        connectedAt = Date.now();
        this.connectedCount++;
        this.nsConnected.set(ns.path, true);
        console.log(`[WS] Connected: ${ns.path}`);
        if (ns.path === '/ws') {
          // DIAG
          console.log(
            '%c[WS-DIAG] /ws (TICK FEED) connected — live ticks should flow',
            'color:#16a34a;font-weight:bold',
          );
          // Record the transport we landed on, then watch for the upgrade
          // (polling -> websocket). Only /ws carries the tick feed, so its
          // transport is the one that matters for diagnostics.
          this.transport = sock.io.engine?.transport?.name ?? null;
          console.log(`[WS] /ws transport: ${this.transport}`);
          sock.io.engine?.on('upgrade', () => {
            this.transport = sock.io.engine?.transport?.name ?? this.transport;
            console.log(`[WS] /ws transport upgraded: ${this.transport}`);
          });
          // Replay any active subscriptions — the server forgets our token
          // list when the socket drops, so a reconnect must re-request them.
          if (this.subscribedTokens.size > 0) {
            sock.emit(
              'subscribe',
              toSubscribePayload([...this.subscribedTokens]),
            );
          }
        }
        // Emit on the FIRST namespace going up so connection-aware UI
        // doesn't flicker as each namespace lands. Emit on subsequent
        // ones too — listeners can dedupe via the `namespace` field.
        this.emit('connection-status', {
          connected: true,
          namespace: ns.path,
          totalConnected: this.connectedCount,
        });
      });

      sock.on('disconnect', (reason) => {
        this.connectedCount = Math.max(0, this.connectedCount - 1);
        this.nsConnected.set(ns.path, false);
        console.log(`[WS] Disconnected ${ns.path}:`, reason);
        if (ns.path === '/ws') {
          // DIAG — the tick socket went down; show why the badge still says "Live"
          const stillUp = [...this.nsConnected.entries()]
            .filter(([p, up]) => p !== '/ws' && up)
            .map(([p]) => p);
          console.warn(
            `%c[WS-DIAG] ⚠️ /ws (TICK FEED) DISCONNECTED — reason: ${reason}. ` +
              `Indicator still shows "Live" because these are up: ${stillUp.join(', ') || 'none'}`,
            'color:#dc2626;font-weight:bold',
          );
        }
        this.emit('connection-status', {
          connected: this.connectedCount > 0,
          namespace: ns.path,
          totalConnected: this.connectedCount,
        });

        // Recover from a terminal server-side rejection (socket.io won't).
        // Only while we hold a token (else we're logged out — stay down), and
        // capped with a backoff so a permanently-rejected namespace goes quiet
        // instead of hot-looping. The counter clears only after a connection
        // that actually held — see ws-retry.ts for why 'connect' isn't enough.
        if (connectedAt && shouldResetRetries(Date.now() - connectedAt)) {
          serverDropRetries = 0;
        }
        connectedAt = 0;

        if (
          reason === 'io server disconnect' &&
          shouldRetryServerDisconnect({
            hasToken: Boolean(getAccessToken()),
            retries: serverDropRetries,
          })
        ) {
          serverDropRetries++;
          setTimeout(() => {
            if (!sock.connected) sock.connect();
          }, nextRetryDelayMs(serverDropRetries));
        }
      });

      for (const event of ns.events) {
        sock.on(event, (data: unknown) => {
          if (event === 'tick') this.lastTickAt = Date.now();
          this.emit(event, data);
        });
      }

      this.sockets.set(ns.path, sock);
    }

    this.startHealthWatch();
  }

  /** Current feed health, decided by the tick socket alone. */
  getFeedHealth(): FeedHealth {
    return classifyFeed({
      tickSocketUp: this.nsConnected.get('/ws') ?? false,
      msSinceLastTick: this.lastTickAt ? Date.now() - this.lastTickAt : null,
      otherNamespacesUp: [...this.nsConnected.entries()].filter(
        ([path, up]) => path !== '/ws' && up,
      ).length,
    });
  }

  /** Health at the last poll, so we report TRANSITIONS rather than every poll. */
  private lastHealth: FeedHealth = 'live';
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Watch feed health and report each stall EPISODE once.
   *
   * Episode-based, not poll-based: the diagnostic this replaces warned every 3
   * seconds for as long as a stall lasted, which is why nobody read it. One row
   * on the way into a stall and one on the way out gives the two facts actually
   * in question — how often stalls happen, and whether they self-recover
   * without a reload.
   */
  private startHealthWatch(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      const health = this.getFeedHealth();

      // Published every poll, not only on a transition. The badge has to be
      // right for a tab that LOADS into an already-healthy feed, which never
      // transitions — subscribers hold a primitive, so an unchanged value is
      // a no-op re-render.
      this.emit('feed-health', { health });

      if (health === this.lastHealth) return;

      const previous = this.lastHealth;
      this.lastHealth = health;

      const entering = health !== 'live';
      const recovering = health === 'live' && previous !== 'live';
      if (!entering && !recovering) return;

      // Imported lazily and only when a stall is actually reported. A static
      // import would pull axios and react-hot-toast — which touches `document`
      // at module scope — into this file's load graph, breaking every
      // node-environment consumer for the sake of a diagnostic.
      void import('./api')
        .then(({ default: api }) =>
          api.post('/healthz/client-report', {
            // On recovery, report the state we recovered FROM — 'live' is not a
            // valid health value for a report and the DTO would reject it.
            health: entering ? health : previous,
            tickSocketUp: this.nsConnected.get('/ws') ?? false,
            secondsSinceLastTick: this.lastTickAt
              ? Math.round((Date.now() - this.lastTickAt) / 1000)
              : undefined,
            transport: this.transport ?? undefined,
            subscribedTokens: this.subscribedTokens.size,
            namespaces: Object.fromEntries(this.nsConnected),
            recoveredWithoutReload: recovering,
          }),
        )
        // A failed diagnostic must never surface in a UI that is already degraded.
        .catch(() => undefined);
    }, 3000);
  }

  disconnect(): void {
    for (const sock of this.sockets.values()) {
      sock.disconnect();
    }
    this.sockets.clear();
    this.connectedCount = 0;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.lastHealth = 'live';
  }

  subscribe(event: string, callback: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  private emit(event: string, data: unknown): void {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }

  /**
   * Inject a synthetic event into local subscribers WITHOUT a server round-trip.
   * Used by REST-poll fallbacks (e.g. the chart's live-candle poll) to drive the
   * same 'tick' consumers when the live socket isn't delivering ticks.
   */
  emitLocal(event: string, data: unknown): void {
    this.emit(event, data);
  }

  /**
   * Ask the server to start streaming ticks for `tokens` on /ws. The server
   * drives a per-user Angel feed from these. Tokens are remembered so they can
   * be replayed after a reconnect. Safe to call before connect() — they'll be
   * sent once /ws comes up.
   */
  emitSubscribe(tokens: string[]): void {
    for (const t of tokens) this.subscribedTokens.add(t);
    this.sockets.get('/ws')?.emit('subscribe', toSubscribePayload(tokens));
  }

  /** Stop streaming ticks for `tokens` on /ws and forget them locally. */
  emitUnsubscribe(tokens: string[]): void {
    for (const t of tokens) this.subscribedTokens.delete(t);
    this.sockets.get('/ws')?.emit('unsubscribe', toSubscribePayload(tokens));
  }

  /** Negotiated /ws transport ('websocket' | 'polling'), or null if unknown. */
  getTransport(): string | null {
    return this.transport;
  }

  get connected(): boolean {
    return this.connectedCount > 0;
  }
}

export const wsService = new WebSocketService();
