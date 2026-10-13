import type { SessionStreamAuth } from '../../market-data/services/user-feed.types';

/**
 * Angel One's order-status WebSocket.
 *
 * Evidence (smartapi-javascript@1.0.27, the installed SDK): `lib/ws_orderupdates.js`
 * exports `WSOrderUpdates`, which opens `CONSTANTS.wsclientupdatesURL` =
 * 'wss://tns.angelone.in/smart-order-update' (`config/constant.js`) with the
 * headers `Authorization: Bearer <jwt>`, `x-api-key`, `x-client-code` and
 * `x-feed-token`, sends the text frame "ping" every 10 s, and treats every
 * inbound frame as an update.
 *
 * The SDK class itself is NOT used: its `triggers` registry is module-global
 * (every instance would deliver to every listener), its stale-socket check
 * re-enters `connect()` without removing the previous socket's handlers, and
 * its `onerror` THROWS from inside an event handler — an uncaught exception
 * in this process. This is the same protocol over `ws` with none of that.
 */
export const ORDER_UPDATE_URL = 'wss://tns.angelone.in/smart-order-update';

export type OrderStreamAuth = SessionStreamAuth;

/** The slice of a `ws` WebSocket this client uses (structural, for fakes). */
export interface OrderSocketLike {
  on(event: 'open', fn: () => void): unknown;
  on(event: 'message', fn: (data: unknown) => void): unknown;
  on(event: 'close', fn: (...args: unknown[]) => void): unknown;
  on(event: 'error', fn: (err: unknown) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate?(): void;
}

export type OrderSocketFactory = (url: string, headers: Record<string, string>) => OrderSocketLike;

/** One order event, as much of it as reconcile triggering needs (never the whole payload). */
export interface OrderUpdate {
  /** Angel's `order-status` code, e.g. AB05 (complete). '' when absent. */
  code: string;
  /** `orderData.orderstatus` (or `status`), lower-cased. '' when absent. */
  status: string;
  filledShares: number;
  orderId: string;
  symbol: string;
  token: string;
  exchange: string;
}

/**
 * Angel's documented order-status codes that mean the order is DONE or the
 * position moved: AB02 cancelled, AB03 rejected, AB05 complete, AB07 cancelled
 * after a market order. (AB00 is the connect acknowledgement; AB01 open, AB04
 * modified, AB06/AB08-AB11 are pending states.)
 */
const TERMINAL_CODES = new Set(['AB02', 'AB03', 'AB05', 'AB07']);
const TERMINAL_STATUSES = new Set(['complete', 'completed', 'filled', 'cancelled', 'canceled', 'rejected']);

function toText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw) && raw.every((b) => Buffer.isBuffer(b))) return Buffer.concat(raw as Buffer[]).toString('utf8');
  // A browser-style MessageEvent ({ data }).
  if (raw && typeof raw === 'object' && 'data' in raw) return toText((raw as { data: unknown }).data);
  return null;
}

/** Parse one frame. Null for anything that is not an order-update JSON object ("pong", junk). */
export function parseOrderUpdate(raw: unknown): OrderUpdate | null {
  const text = toText(raw)?.trim();
  if (!text || text[0] !== '{') return null;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const data = (msg.orderData ?? msg.orderdata ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (v == null ? '' : String(v));
  const filled = Number(data.filledshares ?? data.filledShares ?? 0);
  return {
    code: str(msg['order-status']).toUpperCase(),
    status: str(data.orderstatus ?? data.status).trim().toLowerCase(),
    filledShares: Number.isFinite(filled) ? filled : 0,
    orderId: str(data.orderid),
    symbol: str(data.tradingsymbol),
    token: str(data.symboltoken),
    exchange: str(data.exchange).toUpperCase(),
  };
}

/** Does this update mean the book may have changed (a fill, a partial fill, or a terminal state)? */
export function isFillOrTerminal(u: OrderUpdate): boolean {
  if (TERMINAL_STATUSES.has(u.status)) return true;
  if (u.filledShares > 0) return true; // a partial fill on a still-open order moves the position
  if (!u.status && TERMINAL_CODES.has(u.code)) return true;
  return false;
}

export type OrderStreamState = 'stopped' | 'waiting-session' | 'connecting' | 'up' | 'down';

export interface OrderStreamDeps {
  /** The LIVE session's tokens, or null. Must never log in. */
  auth: () => OrderStreamAuth | null;
  socketFactory: OrderSocketFactory;
  /** A fill / terminal update. Called synchronously from the socket's message handler; must not throw (contained anyway). */
  onUpdate: (u: OrderUpdate) => void;
  /** One line per reported state change. */
  log: (msg: string) => void;
  url?: string;
}

/** SDK cadence: a "ping" text frame every 10 s. */
const PING_MS = 10_000;
/** A socket that has said nothing (not even a pong) for this long is dead. */
const STALE_MS = 35_000;
const STALE_CHECK_MS = 5_000;
/** Reconnect backoff: 2 s doubling to 2 min. */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 120_000;
/** No live session yet: look again this often (cheap: an in-memory read). */
const SESSION_RETRY_MS = 15_000;

/**
 * One user's Angel order-update socket, riding that user's LIVE feed login.
 *
 * Never logs in (no session → `waiting-session`, re-checked every 15 s), never
 * throws out of an event handler, reconnects with capped exponential backoff
 * and re-reads the session's tokens on every attempt, so a re-login of the
 * feed is picked up on the next connect. Logs only when the REPORTED state
 * (up / down / waiting-session / stopped) changes, never per attempt.
 */
export class OrderUpdateStream {
  private socket: OrderSocketLike | null = null;
  private desired = false;
  private current: OrderStreamState = 'stopped';
  private reported: OrderStreamState | null = null;
  private attempts = 0;
  private jwt: string | null = null;
  private lastFrameAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: OrderStreamDeps) {}

  state(): OrderStreamState {
    return this.current;
  }

  /** The JWT the current (or last) socket was opened with, to detect a session re-login. */
  jwtInUse(): string | null {
    return this.jwt;
  }

  isUp(): boolean {
    return this.current === 'up';
  }

  /** Idempotent. */
  start(): void {
    if (this.desired) return;
    this.desired = true;
    this.attempts = 0;
    this.connect();
  }

  stop(): void {
    if (!this.desired && this.current === 'stopped') return;
    this.desired = false;
    this.clearRetry();
    this.teardown();
    this.setState('stopped');
  }

  /** Drop the socket and reconnect now (the live session re-logged in). */
  restart(): void {
    if (!this.desired) return;
    this.clearRetry();
    this.teardown();
    this.attempts = 0;
    this.connect();
  }

  private connect(): void {
    if (!this.desired) return;
    let auth: OrderStreamAuth | null = null;
    try {
      auth = this.deps.auth();
    } catch {
      auth = null;
    }
    if (!auth) {
      this.setState('waiting-session');
      this.schedule(SESSION_RETRY_MS);
      return;
    }
    this.setState('connecting');
    const headers = {
      Authorization: `Bearer ${auth.jwtToken}`,
      'x-api-key': auth.apiKey,
      'x-client-code': auth.clientCode,
      'x-feed-token': auth.feedToken,
    };
    this.jwt = auth.jwtToken;
    let socket: OrderSocketLike;
    try {
      socket = this.deps.socketFactory(this.deps.url ?? ORDER_UPDATE_URL, headers);
    } catch (err) {
      this.onDown(null, err);
      return;
    }
    this.socket = socket;
    this.lastFrameAt = Date.now();
    socket.on('open', () => this.guard(() => this.onOpen(socket)));
    socket.on('message', (data) => this.guard(() => this.onMessage(socket, data)));
    socket.on('close', () => this.guard(() => this.onDown(socket)));
    socket.on('error', (err) => this.guard(() => this.onDown(socket, err)));
  }

  private onOpen(socket: OrderSocketLike): void {
    if (socket !== this.socket) return;
    this.attempts = 0;
    this.lastFrameAt = Date.now();
    this.setState('up');
    this.clearHeartbeat();
    this.pingTimer = setInterval(() => this.guard(() => this.socket?.send('ping')), PING_MS);
    this.staleTimer = setInterval(
      () =>
        this.guard(() => {
          if (Date.now() - this.lastFrameAt > STALE_MS) this.onDown(socket, new Error('no frame for 35 s'));
        }),
      STALE_CHECK_MS,
    );
    this.pingTimer.unref?.();
    this.staleTimer.unref?.();
  }

  private onMessage(socket: OrderSocketLike, data: unknown): void {
    if (socket !== this.socket) return;
    this.lastFrameAt = Date.now();
    const update = parseOrderUpdate(data);
    if (!update || !isFillOrTerminal(update)) return;
    this.deps.onUpdate(update);
  }

  /** A close, an error, a stale socket or a failed construction. Idempotent per socket. */
  private onDown(socket: OrderSocketLike | null, err?: unknown): void {
    if (socket !== null && socket !== this.socket) return; // an old socket's late event
    this.teardown();
    if (!this.desired) return;
    const reason = err instanceof Error ? err.message : err ? String(err) : 'closed';
    this.setState('down', reason);
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempts);
    this.attempts++;
    this.schedule(delay);
  }

  private schedule(ms: number): void {
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.guard(() => this.connect());
    }, ms);
    this.retryTimer.unref?.();
  }

  private teardown(): void {
    this.clearHeartbeat();
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    try {
      s.close();
    } catch {
      try {
        s.terminate?.();
      } catch {
        // best effort
      }
    }
  }

  private clearHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.pingTimer = null;
    this.staleTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setState(next: OrderStreamState, detail?: string): void {
    this.current = next;
    if (next === 'connecting' || next === this.reported) return;
    this.reported = next;
    const text: Record<Exclude<OrderStreamState, 'connecting'>, string> = {
      up: 'up: receiving order updates',
      down: `down (${detail ?? 'closed'}); reconnecting with backoff`,
      'waiting-session': 'waiting for a live broker session (it never logs in itself)',
      stopped: 'stopped',
    };
    try {
      this.deps.log(`[order-stream] ${text[next]}`);
    } catch {
      // logging must not break the stream
    }
  }

  /** Every callback from a socket or timer runs through here: nothing escapes into the event loop. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      try {
        this.deps.log(`[order-stream] handler error contained: ${err instanceof Error ? err.message : err}`);
      } catch {
        // ignore
      }
    }
  }
}
