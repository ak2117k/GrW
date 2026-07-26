import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import type { Candle } from './user-historical.util';

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

/** The per-user session surface the manager depends on (structural, for fakes). */
export interface UserFeedSessionLike {
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
  /** One-shot FULL-mode quote over the user's own Angel session (null if unquotable). */
  getQuote(token: string, exchange: string): Promise<TickData | null>;
}

/** Builds a session for one user. Overridable in tests via the DI token below. */
export type UserFeedSessionFactory = (userId: string) => UserFeedSessionLike;
export const USER_FEED_SESSION_FACTORY = Symbol('USER_FEED_SESSION_FACTORY');
