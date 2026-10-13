import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
// @ts-ignore — smartapi-javascript has no type declarations
import { SmartAPI } from 'smartapi-javascript';
import {
  OrderRequest,
  OrderResponse,
} from '../../../common/interfaces/broker-adapter.interface';
// RFC-6238 TOTP extracted to a shared util (TDA-005) so the market-data singleton
// login, the ephemeral AngelOneValidator, and this per-user order session all
// produce codes identically.
import { generateTOTP } from '../../market-data/utils/angel-one-totp';

/**
 * The five decrypted Angel One credential fields. This is exactly the shape
 * TDA-005's credential decryptor (`DecryptedBrokerCredentials`) yields inside its
 * `withDecryptedCredentials`/`useDecryptedCredential` lease callback. TDA-011
 * takes these already-decrypted, in-memory creds and never persists, retains, or
 * logs them.
 */
export interface AngelOneCreds {
  apiKey: string;
  apiSecret: string;
  clientId: string;
  password: string;
  totpSecret: string;
}

/**
 * Minimal shape of the SmartAPI client the per-user order session exercises:
 * an ephemeral login plus order placement + logout. Kept structural (not the
 * SDK type) so tests can inject a fake with no real broker calls. Mirrors the
 * `SmartApiLike` seam TDA-005's `AngelOneValidator` uses for its login-only shape.
 */
export interface UserSmartApiLike {
  generateSession(clientId: string, password: string, totp: string): Promise<any>;
  placeOrder(params: Record<string, string>): Promise<any>;
  logout(clientId: string): Promise<any>;
  // Read-only account surface (TDA-017 overview). Names match the installed
  // smartapi-javascript@1.0.27 client exactly (get_rms / get_profile / get_position
  // / get_all_holding).
  getRMS(): Promise<any>;
  getProfile(): Promise<any>;
  getPosition(): Promise<any>;
  getAllHolding(): Promise<any>;
  getTradeBook(): Promise<any>;
  /** Today's order book (smartapi-javascript `getOrderBook`). Read-only. */
  getOrderBook(): Promise<any>;
  /**
   * smartapi-javascript `cancelOrder({ variety, orderid })` (POST order_cancel). Optional in
   * this structural seam only so read-only fakes need not stub it; the real SDK always has it,
   * and a client without it makes every cancel UNCERTAIN (never a silent success).
   */
  cancelOrder?(params: Record<string, string>): Promise<any>;
}

/** Builds a throwaway SmartAPI client for one user's disposable order session. */
export type UserSmartApiFactory = (apiKey: string) => UserSmartApiLike;

/** DI token for an overridable per-user SmartAPI factory (defaults to the real client). */
export const USER_SMARTAPI_FACTORY = Symbol('USER_SMARTAPI_FACTORY');

/**
 * A short-lived, disposable broker session scoped to ONE user's order(s). Handed
 * to the `withSession` callback; unusable after the callback returns (the factory
 * disposes it in `finally`).
 */
export interface UserBrokerSession {
  /**
   * Place an order on this user's own Angel One account. Mirrors the global
   * `AngelOneAdapterService.placeOrder` mapping/response contract (returns a
   * REJECTED/FAILED `OrderResponse` rather than throwing on a broker reject/fault
   * — transient-vs-terminal classification is the pipeline's concern). An
   * optional `orderTag` is forwarded as SmartAPI `ordertag` for best-effort
   * broker-side idempotency dedupe (spec §5).
   */
  placeOrder(order: OrderRequest, orderTag?: string): Promise<OrderResponse>;

  /**
   * Same order mapping and transport as {@link placeOrder}, but the result says
   * WHO decided it (sentinel auto-exit review fix). The installed SDK never
   * rejects: its axios error interceptor resolves a network error / its own 7 s
   * timeout to `{}`, an HTTP error to `{ status: <http>, message: <statusText> }`
   * and an interceptor fault to `[]`. Only an envelope in which Angel itself
   * answered `status: false` / `success: false` with its own message or errorcode
   * is a definitive REJECTED; every other answer without an orderid, and any
   * throw or timeout, is UNCERTAIN (the order may exist at the broker).
   * Both the auto-execution pipeline and the sentinel auto-exit use this; the legacy
   * {@link placeOrder} mapping (no answer ⇒ REJECTED) has no production caller left.
   */
  placeOrderClassified(order: OrderRequest, orderTag?: string): Promise<ClassifiedPlacement>;

  /**
   * Read-only account reads on this user's own Angel One account, used by the
   * TDA-017 sanitized overview. Each returns the RAW broker `data` payload (the
   * service layer is responsible for sanitizing it into safe fields). Like every
   * other call on this session they are guarded against use after disposal and
   * bounded by {@link BROKER_CALL_TIMEOUT_MS}.
   */
  getFunds(): Promise<any>;
  getProfile(): Promise<any>;
  getPositions(): Promise<any>;
  getHoldings(): Promise<any>;
  getTradeBook(): Promise<any>;

  /**
   * The RAW broker ENVELOPE (`{ status, message, errorcode, data }`) of the
   * positions / holdings reads, not just its `data`. The SmartAPI client never
   * rejects: a failed or unauthenticated call resolves to `{ status: false,
   * data: null }` (or `{ status: 500 }` on an HTTP error), while an empty book
   * can be answered `{ status: true, data: null }` — so only the envelope can
   * tell "the broker says you hold nothing" from "the broker did not answer".
   * Same disposed-guard + timeout as every other read.
   */
  getPositionsEnvelope(): Promise<any>;
  getHoldingsEnvelope(): Promise<any>;

  /**
   * The RAW order-book envelope. Angel can accept an order (orderid returned) and
   * reject it a moment later in the RMS/exchange; the reason only appears here
   * (`status: 'rejected'`, `text`). Same disposed-guard + timeout as every read.
   */
  getOrderBookEnvelope(): Promise<any>;

  /**
   * Cancel one of this user's resting orders (sentinel auto-exit "cancel
   * protective then exit"). Same never-rejects SDK caveat as
   * {@link placeOrderClassified}: only an envelope in which Angel itself answered
   * is definitive — `ACCEPTED` (status true + the orderid) or `REJECTED`
   * (status false + its own message/errorcode). Everything else, and any
   * throw/timeout, is `UNCERTAIN`. Even `ACCEPTED` only means Angel took the
   * request: the caller must confirm the order is `cancelled` in the order book.
   */
  cancelOrderClassified(variety: string, orderId: string): Promise<ClassifiedCancel>;
}

/** Outcome of {@link UserBrokerSession.cancelOrderClassified}. */
export type ClassifiedCancel =
  | { status: 'ACCEPTED'; message: string }
  | { status: 'REJECTED'; message: string; errorcode: string }
  | { status: 'UNCERTAIN'; message: string };

/** Classify a raw smartapi-javascript `cancelOrder` resolution. Pure; never throws. */
export function classifyCancelResponse(response: unknown): ClassifiedCancel {
  const isObj = !!response && typeof response === 'object' && !Array.isArray(response);
  const r = (isObj ? response : {}) as Record<string, any>;
  const rawId = r.data?.orderid;
  const orderId = typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId.trim() : '';
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if ((r.status === true || r.success === true) && orderId) {
    return { status: 'ACCEPTED', message: text(r.message) || 'cancel accepted' };
  }
  if (r.status === false || r.success === false) {
    const message = text(r.message);
    const errorcode = text(r.errorcode) || text(r.errorCode);
    if (message || errorcode) return { status: 'REJECTED', message: message || errorcode, errorcode };
  }
  let shape: string;
  try {
    shape = JSON.stringify(response) ?? String(response);
  } catch {
    shape = String(response);
  }
  return { status: 'UNCERTAIN', message: `no definitive broker answer: ${shape.slice(0, 200)}` };
}

/**
 * Outcome of {@link UserBrokerSession.placeOrderClassified}. `REJECTED` is
 * definitive (Angel answered); `UNCERTAIN` means the order may or may not exist.
 */
export type ClassifiedPlacement =
  | { status: 'PLACED'; orderId: string; message: string }
  | { status: 'REJECTED'; orderId: ''; message: string; errorcode: string }
  | { status: 'UNCERTAIN'; orderId: ''; message: string };

const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Classify a raw smartapi-javascript `placeOrder` resolution (see
 * {@link UserBrokerSession.placeOrderClassified}). Pure; never throws.
 */
export function classifyPlaceOrderResponse(response: unknown): ClassifiedPlacement {
  const isObj = !!response && typeof response === 'object' && !Array.isArray(response);
  const r = (isObj ? response : {}) as Record<string, any>;
  const rawId = r.data?.orderid;
  const orderId = typeof rawId === 'number' ? String(rawId) : trimmed(rawId);
  if (orderId) {
    return { status: 'PLACED', orderId, message: trimmed(r.message) || 'Order placed successfully' };
  }
  if (r.status === false || r.success === false) {
    const message = trimmed(r.message);
    const errorcode = trimmed(r.errorcode) || trimmed(r.errorCode);
    if (message || errorcode) {
      return { status: 'REJECTED', orderId: '', message: message || errorcode, errorcode };
    }
  }
  let shape: string;
  try {
    shape = JSON.stringify(response) ?? String(response);
  } catch {
    shape = String(response);
  }
  return { status: 'UNCERTAIN', orderId: '', message: `no definitive broker answer: ${shape.slice(0, 200)}` };
}

/** Map our generic order types to Angel One SmartAPI order-type strings. */
const ORDER_TYPE_MAP: Record<string, string> = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  STOPLOSS: 'STOPLOSS_LIMIT',
  STOPLOSS_MARKET: 'STOPLOSS_MARKET',
};

/** Map our generic position types to Angel One product types. */
const PRODUCT_TYPE_MAP: Record<string, string> = {
  INTRADAY: 'INTRADAY',
  DELIVERY: 'DELIVERY',
  CARRYFORWARD: 'CARRYFORWARD',
};

/** "AB1234" -> "A•••34" (short ids collapse gracefully). */
function maskClientId(clientId: string): string {
  if (!clientId) return '••';
  if (clientId.length <= 2) return `${clientId[0] ?? ''}••`;
  return `${clientId[0]}•••${clientId.slice(-2)}`;
}

/**
 * Wall-clock cap on a single broker network call. Without it a hung
 * generateSession/placeOrder/logout would await unbounded and — even with
 * per-user worker concurrency — pin a worker slot indefinitely, stalling other
 * users' orders. On timeout the call rejects so the pipeline treats it as a
 * transient fault (retry → DLQ) rather than freezing the fleet.
 */
const BROKER_CALL_TIMEOUT_MS = 15_000;

/** Reject if `p` does not settle within `ms`; always clears the timer. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Concrete disposable session backed by a per-user SmartAPI client. Not exported
 * — callers only ever see the `UserBrokerSession` interface, and only within the
 * `withSession` callback.
 */
class AngelOneUserBrokerSession implements UserBrokerSession {
  private disposed = false;

  constructor(
    private readonly client: UserSmartApiLike,
    private readonly clientId: string,
    private readonly logger: Logger,
  ) {}

  async placeOrder(order: OrderRequest, orderTag?: string): Promise<OrderResponse> {
    this.assertCanPlace();

    try {
      const response = await this.send(order, orderTag);

      if (!response?.data?.orderid) {
        return {
          orderId: '',
          status: 'REJECTED',
          message: response?.message ?? 'Order placement failed',
        };
      }

      return {
        orderId: response.data.orderid,
        status: 'PLACED',
        message: response.message ?? 'Order placed successfully',
      };
    } catch (error) {
      // Mirror the global adapter: swallow into a FAILED response (never a
      // broker error carrying creds — the params above hold no secret).
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to place per-user order: ${msg}`);
      return { orderId: '', status: 'FAILED', message: msg };
    }
  }

  async placeOrderClassified(order: OrderRequest, orderTag?: string): Promise<ClassifiedPlacement> {
    this.assertCanPlace();
    let response: unknown;
    try {
      response = await this.send(order, orderTag);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to place per-user order (outcome unknown): ${msg}`);
      return { status: 'UNCERTAIN', orderId: '', message: msg };
    }
    return classifyPlaceOrderResponse(response);
  }

  async cancelOrderClassified(variety: string, orderId: string): Promise<ClassifiedCancel> {
    this.assertCanPlace();
    this.logger.log(`Cancelling per-user order ${orderId} (${variety}) (client ${maskClientId(this.clientId)})`);
    let response: unknown;
    try {
      response = await withTimeout(
        this.client.cancelOrder
          ? this.client.cancelOrder({ variety, orderid: orderId })
          : Promise.reject(new Error('this broker client has no cancelOrder')),
        BROKER_CALL_TIMEOUT_MS,
        'Angel One cancelOrder',
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to cancel per-user order ${orderId} (outcome unknown): ${msg}`);
      return { status: 'UNCERTAIN', message: msg };
    }
    return classifyCancelResponse(response);
  }

  private assertCanPlace(): void {
    if (this.disposed) {
      throw new Error('UserBrokerSession has been disposed and can no longer place orders');
    }
  }

  /** Map + send one order under the wall-clock cap; returns the SDK's resolution untouched. */
  private async send(order: OrderRequest, orderTag?: string): Promise<any> {
    const params: Record<string, string> = {
      variety: 'NORMAL',
      tradingsymbol: order.symbol,
      symboltoken: order.token,
      transactiontype: order.side,
      exchange: order.exchange,
      ordertype: ORDER_TYPE_MAP[order.orderType] ?? order.orderType,
      producttype: PRODUCT_TYPE_MAP[order.positionType] ?? order.positionType,
      duration: 'DAY',
      quantity: String(order.quantity),
      price: order.price != null && order.price > 0 ? String(order.price) : '0',
      triggerprice:
        order.triggerPrice != null && order.triggerPrice > 0
          ? String(order.triggerPrice)
          : '0',
    };

    // Best-effort broker-side dedupe tag (spec §5): visible in the order book
    // so post-hoc reconciliation can match on the idempotency key.
    if (orderTag) {
      params.ordertag = orderTag;
    }

    this.logger.log(
      `Placing per-user ${order.orderType} ${order.side} order for ${order.symbol} ` +
        `qty=${order.quantity} (client ${maskClientId(this.clientId)})`,
    );

    return withTimeout(
      this.client.placeOrder(params),
      BROKER_CALL_TIMEOUT_MS,
      'Angel One placeOrder',
    );
  }

  /**
   * Fetch this user's RMS funds/margin. Returns the RAW broker `data` (or null);
   * the service sanitizes. Same disposed-guard + timeout as `placeOrder`.
   */
  async getFunds(): Promise<any> {
    return this.read(() => this.client.getRMS(), 'Angel One getRMS');
  }

  /** Fetch this user's profile. Returns the RAW broker `data` (or null). */
  async getProfile(): Promise<any> {
    return this.read(() => this.client.getProfile(), 'Angel One getProfile');
  }

  /** Fetch this user's open positions. Returns the RAW broker `data` (or null). */
  async getPositions(): Promise<any> {
    return this.read(() => this.client.getPosition(), 'Angel One getPosition');
  }

  /**
   * Fetch this user's equity holdings + portfolio totals (Angel One
   * `get_all_holding`: `{ holdings: [...], totalholding: {...} }`). Returns the
   * RAW broker `data` (or null); same disposed-guard + timeout as getPositions.
   */
  async getHoldings(): Promise<any> {
    return this.read(() => this.client.getAllHolding(), 'Angel One getAllHolding');
  }

  /**
   * Fetch this user's day trade book (Angel One `getTradeBook`: `data` is an
   * array of executed-trade rows, or null/[] when there are no trades). Returns
   * the RAW broker `data` (or null); same disposed-guard + timeout as getHoldings.
   */
  async getTradeBook(): Promise<any> {
    return this.read(() => this.client.getTradeBook(), 'Angel One getTradeBook');
  }

  /**
   * Shared read helper: reject if the session was disposed, run the broker call
   * under the wall-clock cap, and return only its `data` envelope up to the
   * caller. Read faults propagate (unlike `placeOrder`, which maps to a response)
   * — the overview service turns them into an HTTP error, never a partial leak.
   */
  private async read(call: () => Promise<any>, label: string): Promise<any> {
    const response = await this.readEnvelope(call, label);
    return response?.data ?? null;
  }

  /** Positions read, whole envelope (see the interface). */
  async getPositionsEnvelope(): Promise<any> {
    return this.readEnvelope(() => this.client.getPosition(), 'Angel One getPosition');
  }

  /** Holdings read, whole envelope (see the interface). */
  async getHoldingsEnvelope(): Promise<any> {
    return this.readEnvelope(() => this.client.getAllHolding(), 'Angel One getAllHolding');
  }

  /** Order book read, whole envelope (see the interface). */
  async getOrderBookEnvelope(): Promise<any> {
    return this.readEnvelope(() => this.client.getOrderBook(), 'Angel One getOrderBook');
  }

  /** Disposed-guard + wall-clock cap; returns the broker's response untouched. */
  private async readEnvelope(call: () => Promise<any>, label: string): Promise<any> {
    if (this.disposed) {
      throw new Error('UserBrokerSession has been disposed and can no longer be read');
    }
    return withTimeout(call(), BROKER_CALL_TIMEOUT_MS, label);
  }

  /** Mark the session unusable. Called by the factory in `finally`. */
  dispose(): void {
    this.disposed = true;
  }
}

/**
 * Builds a FRESH, short-lived, disposable Angel One session on a SINGLE user's
 * own account and runs a caller-supplied unit of work against it (TDA-011 §6).
 *
 * Modelled on TDA-005's ephemeral `AngelOneValidator`: it creates a throwaway
 * SmartAPI client from the user's `apiKey`, computes a fresh TOTP from the
 * submitted `totpSecret`, calls `generateSession`, and — critically — NEVER
 * touches the market-data singleton (`AngelOneAuthService`). A user's order can
 * never clobber, or be clobbered by, the global engine feed session.
 *
 * Lifecycle (mirrors the TDA-005 lease pattern): the session is created, handed
 * to `fn`, and disposed in a `finally` — the session is marked unusable and the
 * broker session is best-effort logged out — even if `fn` throws. The factory
 * never retains the session, the SmartAPI client, or the creds; nothing here
 * logs the plaintext password / TOTP secret / api secret.
 *
 * Decryption is NOT this class's job: it receives already-decrypted in-memory
 * `AngelOneCreds` (the shape TDA-005's decryptor yields). Phase-2 integration
 * wraps this as:
 *   vault.useDecryptedCredential(userId, ctx, creds =>
 *     factory.withSession(creds, session => fn(session)))
 * so plaintext lifetime stays bounded by the vault's own zeroizing lease.
 */
@Injectable()
export class PerUserBrokerSessionFactory {
  private readonly logger = new Logger(PerUserBrokerSessionFactory.name);
  private readonly smartApiFactory: UserSmartApiFactory;

  constructor(
    @Optional() @Inject(USER_SMARTAPI_FACTORY) smartApiFactory?: UserSmartApiFactory,
  ) {
    this.smartApiFactory =
      smartApiFactory ?? ((apiKey: string) => new SmartAPI({ api_key: apiKey }));
  }

  /**
   * Create a fresh disposable per-user session from `creds`, run `fn` against it,
   * and dispose the session in `finally`. Returns whatever `fn` returns.
   *
   * Throws a GENERIC error (no cred/broker-error leak) if the ephemeral login is
   * rejected — the raw broker message is logged server-side with the client id
   * masked, never the password/TOTP.
   */
  async withSession<T>(
    creds: AngelOneCreds,
    fn: (session: UserBrokerSession) => Promise<T>,
  ): Promise<T> {
    const client = this.smartApiFactory(creds.apiKey);

    // Ephemeral login: fresh TOTP + generateSession, exactly like the validator.
    // The SmartAPI client retains the JWT internally, so the same instance is
    // authenticated for the subsequent placeOrder call.
    try {
      const totp = generateTOTP(creds.totpSecret);
      const session = await withTimeout(
        client.generateSession(creds.clientId, creds.password, totp),
        BROKER_CALL_TIMEOUT_MS,
        'Angel One generateSession',
      );
      if (!session?.data?.jwtToken) {
        this.logger.warn(
          `Per-user Angel One login for client ${maskClientId(creds.clientId)} returned no session`,
        );
        throw new Error('Angel One rejected the credentials for order placement');
      }
    } catch (error) {
      // Re-throw our own generic error untouched; wrap any raw broker error in a
      // generic one so no broker message (which may echo cred hints) escapes.
      if (error instanceof Error && error.message === 'Angel One rejected the credentials for order placement') {
        throw error;
      }
      // Log only the error TYPE, never `error.message`: the raw broker/SDK
      // message on a failed generateSession is the one place that could echo the
      // submitted password/TOTP back into the log stream.
      this.logger.warn(
        `Per-user Angel One login failed for client ${maskClientId(creds.clientId)}: ` +
          `${error instanceof Error ? error.name : 'unknown error'}`,
      );
      throw new Error('Angel One rejected the credentials for order placement');
    }

    const brokerSession = new AngelOneUserBrokerSession(client, creds.clientId, this.logger);
    try {
      return await fn(brokerSession);
    } finally {
      // Dispose (mark unusable) + best-effort logout to release the broker
      // session. Never let a logout fault mask the callback's own result/error.
      brokerSession.dispose();
      await this.safeLogout(client, creds.clientId);
    }
  }

  /**
   * Run `fn` against an ALREADY-AUTHENTICATED client that someone else owns — the
   * owner's warm per-user feed session (sentinel auto-exit, plan ruling R1). A
   * second Angel login on the same client code kills that session's live stream,
   * so this never logs in and never logs out; it only lends the one order mapper
   * above. The wrapper is disposed in `finally` so it cannot outlive the callback;
   * disposing the wrapper does NOT touch the lent client (its owner keeps it).
   */
  async borrow<T>(
    client: UserSmartApiLike,
    clientId: string,
    fn: (session: UserBrokerSession) => Promise<T>,
  ): Promise<T> {
    const session = new AngelOneUserBrokerSession(client, clientId, this.logger);
    try {
      return await fn(session);
    } finally {
      session.dispose();
    }
  }

  /** Best-effort broker logout; a failure is logged (masked) and swallowed. */
  private async safeLogout(client: UserSmartApiLike, clientId: string): Promise<void> {
    try {
      await withTimeout(client.logout(clientId), BROKER_CALL_TIMEOUT_MS, 'Angel One logout');
    } catch (error) {
      this.logger.warn(
        `Per-user Angel One logout failed for client ${maskClientId(clientId)}: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
