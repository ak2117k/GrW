import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import type { Candle } from './user-historical.util';
import type { OptionGreekRow } from '../../market-hub/chain/chain.types';

/** A single instrument to subscribe on the broker feed. */
export interface TokenRef {
  token: string;
  /** Angel exchange code, e.g. 'NSE' | 'BSE' | 'MCX' (mapped to ExchangeType by the session). */
  exchange: string;
}

/** Lifecycle state of one user's broker feed, surfaced to the client badge. */
export type FeedState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'closed'
  | 'error';

export type TickListener = (tick: TickData) => void;
export type StateListener = (state: FeedState) => void;

/** An already-authenticated SmartAPI REST client lent out by a live session (never a login). */
export interface WarmRestClient {
  client: unknown;
  clientId: string;
}

/** The per-user session surface the manager depends on (structural, for fakes). */
export interface UserFeedSessionLike {
  /**
   * The session's authenticated REST client, or null. Lets the sentinel
   * auto-exit place an order on the owner's account without a second Angel
   * login (which would kill this session's stream). Optional: fakes omit it.
   * The borrower must never log the client in or out.
   */
  restClient?(): WarmRestClient | null;
  ensureConnected(): Promise<void>;
  subscribe(tokens: TokenRef[]): Promise<void>;
  unsubscribe(tokens: TokenRef[]): Promise<void>;
  activeTokenCount(): number;
  onTick(listener: TickListener): void;
  onState(listener: StateListener): void;
  dispose(): Promise<void>;
  /** One-shot historical candle fetch over the user's own Angel session. */
  getCandles(
    token: string,
    exchange: string,
    timeframe: string,
    from: Date,
    to: Date,
  ): Promise<Candle[]>;
  /**
   * ONE getCandleData window (no chunking, retry or pacing). Rejects with
   * AngelThrottleError when throttled; [] means genuinely no bars.
   */
  getCandleWindow(token: string, exchange: string, interval: string, from: Date, to: Date): Promise<Candle[]>;
  /** One-shot FULL-mode quote over the user's own Angel session (null if unquotable). */
  getQuote(token: string, exchange: string): Promise<TickData | null>;
  /**
   * Batched FULL-mode quotes in ONE broker call, keyed by token. Tokens the
   * account can't quote are absent from the map rather than throwing. With
   * `throwOnThrottle`, Angel's throttle shape (`data: null`) rejects with
   * AngelThrottleError instead of returning an empty map.
   */
  getQuotes(refs: TokenRef[], opts?: { throwOnThrottle?: boolean }): Promise<Map<string, TickData>>;
  /**
   * ONE optionGreek call: Greeks + IV for every contract of `name` expiring
   * `expiryYmd` (YYYY-MM-DD). Rejects with AngelThrottleError when throttled.
   */
  getOptionGreeks(name: string, expiryYmd: string): Promise<OptionGreekRow[]>;
}

/** Builds a session for one user. Overridable in tests via the DI token below. */
export type UserFeedSessionFactory = (userId: string) => UserFeedSessionLike;
export const USER_FEED_SESSION_FACTORY = Symbol('USER_FEED_SESSION_FACTORY');
