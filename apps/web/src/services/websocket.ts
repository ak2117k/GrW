import { io, Socket } from 'socket.io-client';
import { getStoredAccessToken } from './auth-storage';

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
  | 'connection-status';

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

  // ---- TEMP DIAGNOSTIC (remove once tick-feed stall is confirmed) ----
  /** Wall-clock of the last 'tick' frame received on /ws. */
  private lastTickAt = 0;
  /** Per-namespace connected state, for distinguishing a /ws-only outage. */
  private nsConnected = new Map<string, boolean>();
  private diagTimer: ReturnType<typeof setInterval> | null = null;
  // -------------------------------------------------------------------

  /** Negotiated transport for the /ws socket ('polling' | 'websocket'), or null. */
  private transport: string | null = null;
  /**
   * Tokens the app has asked the server to stream on /ws. Held so we can
   * re-emit `subscribe` after a reconnect (the server forgets on disconnect).
   */
  private subscribedTokens = new Set<string>();

  connect(): void {
    if (this.sockets.size > 0) return;

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

      sock.on('connect', () => {
        serverDropRetries = 0;
        this.connectedCount++;
        this.nsConnected.set(ns.path, true); // DIAG
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
        this.nsConnected.set(ns.path, false); // DIAG
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
        // capped with a backoff so a permanently-bad token can't hot-loop.
        if (reason === 'io server disconnect' && getAccessToken() && serverDropRetries < 10) {
          serverDropRetries++;
          const delay = Math.min(5000, 1000 * serverDropRetries);
          setTimeout(() => {
            if (!sock.connected) sock.connect();
          }, delay);
        }
      });

      for (const event of ns.events) {
        sock.on(event, (data: unknown) => {
          if (event === 'tick') this.lastTickAt = Date.now(); // DIAG
          this.emit(event, data);
        });
      }

      this.sockets.set(ns.path, sock);
    }

    this.startDiagnostics(); // DIAG
  }

  // ---- TEMP DIAGNOSTIC (remove once tick-feed stall is confirmed) ----
  /**
   * Polls every 3s and warns when the "Live" badge is on but the tick feed
   * is actually dead — i.e. /ws is down, or no tick has arrived in >6s.
   * Also exposes `window.__wsDiag()` for an on-demand snapshot.
   */
  private startDiagnostics(): void {
    if (this.diagTimer) return;

    (window as unknown as { __wsDiag?: () => unknown }).__wsDiag = () => ({
      indicatorSaysLive: this.connectedCount > 0,
      perNamespace: Object.fromEntries(this.nsConnected),
      tickSocketUp: this.nsConnected.get('/ws') ?? false,
      transport: this.transport,
      subscribedTokens: [...this.subscribedTokens],
      secondsSinceLastTick: this.lastTickAt
        ? Math.round((Date.now() - this.lastTickAt) / 1000)
        : null,
    });

    this.diagTimer = setInterval(() => {
      const tickSockUp = this.nsConnected.get('/ws') ?? false;
      const ageMs = this.lastTickAt ? Date.now() - this.lastTickAt : Infinity;
      const stalled = !tickSockUp || ageMs > 6000;
      if (this.connectedCount > 0 && stalled) {
        console.warn(
          `[WS-DIAG] ⚠️ Badge shows "Live" but tick feed STALLED — ` +
            `/ws up=${tickSockUp}, last tick ${
              this.lastTickAt ? Math.round(ageMs / 1000) + 's ago' : 'NEVER'
            }. Per-ns: ${JSON.stringify(Object.fromEntries(this.nsConnected))}`,
        );
      }
    }, 3000);
  }
  // -------------------------------------------------------------------

  disconnect(): void {
    for (const sock of this.sockets.values()) {
      sock.disconnect();
    }
    this.sockets.clear();
    this.connectedCount = 0;
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
