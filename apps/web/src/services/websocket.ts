import { io, Socket } from 'socket.io-client';

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
    events: ['tick', 'signal', 'alert', 'candle'],
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

  connect(): void {
    if (this.sockets.size > 0) return;

    for (const ns of NAMESPACES) {
      const sock = io(ns.path, {
        path: '/socket.io',
        transports: ['polling', 'websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
      });

      sock.on('connect', () => {
        this.connectedCount++;
        this.nsConnected.set(ns.path, true); // DIAG
        console.log(`[WS] Connected: ${ns.path}`);
        if (ns.path === '/ws') {
          // DIAG
          console.log(
            '%c[WS-DIAG] /ws (TICK FEED) connected — live ticks should flow',
            'color:#16a34a;font-weight:bold',
          );
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

  get connected(): boolean {
    return this.connectedCount > 0;
  }
}

export const wsService = new WebSocketService();
