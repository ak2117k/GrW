import type { TickData } from '../../common/interfaces/broker-adapter.interface';
import type { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import type { FeedState, TokenRef } from '../market-data/services/user-feed.types';
import type { InstrumentRef } from './hub.types';

/** Everything the hub needs from a broker session — and nothing else. */
export interface HubBroker {
  connect(): Promise<void>;
  subscribe(refs: InstrumentRef[]): Promise<void>;
  unsubscribe(refs: InstrumentRef[]): Promise<void>;
  /** One FULL-quote call, keyed by token. Rejects with AngelThrottleError when throttled. */
  quotes(refs: InstrumentRef[]): Promise<Map<string, TickData>>;
  onTick(fn: (tick: TickData) => void): void;
  onState(fn: (state: FeedState) => void): void;
}

const toTokenRef = (r: InstrumentRef): TokenRef => ({ token: r.token, exchange: r.exchange });

/**
 * The hub on the OWNER's existing per-user session. It pins tokens on the
 * UserFeedManager rather than creating a session: a second Angel One login
 * on the same client code would kill the browser's live stream.
 */
export class ManagerHubBroker implements HubBroker {
  constructor(
    private readonly manager: Pick<
      UserFeedManager,
      'pin' | 'unpin' | 'fetchQuotes' | 'addTickListener' | 'addStateListener'
    >,
    private readonly ownerUserId: string,
  ) {}

  connect(): Promise<void> {
    return this.manager.pin(this.ownerUserId, []);
  }

  subscribe(refs: InstrumentRef[]): Promise<void> {
    return this.manager.pin(this.ownerUserId, refs.map(toTokenRef));
  }

  unsubscribe(refs: InstrumentRef[]): Promise<void> {
    return this.manager.unpin(this.ownerUserId, refs.map(toTokenRef));
  }

  quotes(refs: InstrumentRef[]): Promise<Map<string, TickData>> {
    return this.manager.fetchQuotes(this.ownerUserId, refs.map(toTokenRef), {
      throwOnThrottle: true,
    });
  }

  onTick(fn: (tick: TickData) => void): void {
    this.manager.addTickListener((userId, tick) => {
      if (userId === this.ownerUserId) fn(tick);
    });
  }

  onState(fn: (state: FeedState) => void): void {
    this.manager.addStateListener((userId, state) => {
      if (userId === this.ownerUserId) fn(state);
    });
  }
}
