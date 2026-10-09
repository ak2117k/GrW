import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron, Interval } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import type { TokenRef } from '../../market-data/services/user-feed.types';
import { lookupHubPrices, type HubPriceSource } from '../../market-hub/hub-prices';
import { isHubExchange, refKey, type InstrumentRef, type Price } from '../../market-hub/hub.types';
import { TradeTrackerService, type TickTarget } from './trade-tracker.service';

/**
 * Drives the per-trade tracker (design §4.2 / §4.3).
 *
 * Two cooperating schedules, both gated to Indian market hours:
 *
 *  1. RECONCILE (cron, ~every 10 min): for every user with a stored broker
 *     credential, take a one-login ephemeral snapshot of their book and
 *     reconcile it, then offer every OPEN tracker's token to the shared market
 *     feed so the socket carries whichever ones fit.
 *
 *  2. SWEEP (interval, {@link SWEEP_MS}): price every OPEN tracker and fold the
 *     result in via `applyTick` (itself debounced), in two tiers — the socket
 *     cache where it has a fresh tick, BATCHED REST QUOTES for everything else.
 *
 * Follows the existing poller patterns (`ungated-tick-poller`,
 * `watch-backstop-poller`): 6-field IST cron for the heavy job, a guarded
 * interval for the light sweep, and per-user try/catch so one user's broker
 * failure never aborts the batch.
 */
@Injectable()
export class TradeTrackerPoller implements OnModuleDestroy {
  private readonly logger = new Logger(TradeTrackerPoller.name);

  /**
   * Quote sweep cadence.
   *
   * This was 4s while the sweep only read an in-memory socket cache, where a
   * pass cost nothing. It now issues a REST quote call per user, and Angel One's
   * overall budget is ~10 req/sec across everything this process does — the
   * historical path already paces itself at 350ms per call for the same reason.
   * A sweep is one call per user with open trades, so the cost scales with
   * tenants, not with the ~50 open tokens.
   *
   * 12s is the trade: a position is repriced at worst 12s + the 3s applyTick
   * debounce behind the market, which is well inside the horizon anything
   * downstream acts on (the sentinel deliberates in minutes, day high/low and
   * P&L are read by humans), while leaving the per-second budget almost entirely
   * free for order placement and charts. Chasing 4s here would buy 8 seconds of
   * freshness and spend 3x the rate limit to get it — and the failure this
   * replaces was not a price 8 seconds old, it was a price TWENTY-ONE HOURS old.
   */
  private static readonly SWEEP_MS = 12_000;

  /**
   * How recent a socket-cached quote must be to be preferred over a REST fetch.
   *
   * A subscribed token ticks sub-second, so anything the pool actually serves is
   * strictly better than a snapshot and should not cost a broker call. But the
   * cache does NOT expire its entries: an unsubscribed token keeps whatever it
   * was last given, forever, which is precisely how a stale LTP passes itself off
   * as the market. Slightly over two sweep intervals, so a genuinely live token
   * never flickers out of the fast path between passes.
   */
  private static readonly WS_FRESH_MS = 30_000;

  /** Spec §2 / §5.3: an open position's price is at most 5 s old (Position Manager maxAge). */
  private static readonly HUB_MAX_AGE_MS = 5000;

  /** The hub-served user's open instruments (EXCHANGE:token), rebuilt every sweep; read by the tick listener. */
  private hubOwned = new Map<string, TickTarget>();
  private hubUserId: string | null = null;
  private unsubscribeHub: (() => void) | null = null;
  private hubSourceRef: HubPriceSource | null = null;

  /** Guards against overlapping reconcile passes (a slow broker cycle). */
  private reconciling = false;

  /** Guards against overlapping sweeps — a slow broker must not stack calls. */
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly feed: MarketFeedService,
    private readonly userFeeds: UserFeedManager,
    private readonly service: TradeTrackerService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleDestroy(): void {
    this.unsubscribeHub?.();
    this.unsubscribeHub = null;
  }

  /**
   * Reconcile every credentialed user's book, then (re)subscribe all OPEN
   * tokens to the feed. Runs at minute 0,10,20,30,40,50 during 09:00–15:59 IST,
   * Mon–Fri (6-field `sec min hour dom mon dow`).
   */
  @Cron('0 */10 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async reconcileAll(): Promise<void> {
    if (this.reconciling) {
      this.logger.debug('[trade-tracker] reconcile already in progress — skipping');
      return;
    }
    this.reconciling = true;
    try {
      const users = await this.prisma.brokerCredential.findMany({
        select: { userId: true },
      });
      if (users.length === 0) return;

      let ok = 0;
      let failed = 0;
      for (const { userId } of users) {
        try {
          await this.service.backfill(userId);
          ok++;
        } catch (err) {
          failed++;
          this.logger.warn(
            `[trade-tracker] reconcile failed for a user: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // Subscribe every OPEN token so the shared socket carries their ticks.
      const tokens = await this.service.distinctOpenTokens();
      if (tokens.length > 0) {
        try {
          await this.feed.subscribe(tokens);
        } catch (err) {
          this.logger.warn(
            `[trade-tracker] feed subscribe failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      this.logger.log(
        `[trade-tracker] reconciled ${ok}/${users.length} user(s) (failed=${failed}), tracking ${tokens.length} token(s)`,
      );
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Price every OPEN tracker. Guarded by market hours so it is idle
   * overnight/weekends; `applyTick` debounces the DB writes internally.
   *
   * THIS USED TO READ ONLY `feed.getQuote`, AND THAT IS THE BUG IT FIXES. A
   * token is in the socket cache only if it was SUBSCRIBED, and
   * `MarketFeedService.subscribe` has 30 slots that `startFeed` has largely
   * spent on the default universe before an open trade is ever offered one. A
   * live NFO position (KEI29SEP265800CE) therefore sat at an LTP stamped
   * twenty-one hours earlier while cash trackers beside it updated that morning
   * — and P&L, the day extremes and the entire sentinel context packet read that
   * frozen number as the market. Prioritising the queue only decided who starved.
   *
   * Tiers, in this order:
   *
   *  0. HUB (HUB_PRICES_POSITIONS) — for the user the hub serves (the owner), a
   *     price ≤ 5 s old, scoped to that user. Between sweeps the hub tick
   *     listener applies every new price as it arrives; this sweep is the
   *     safety net. A hub-served instrument then takes no unscoped legacy tick
   *     for that user this sweep; one the hub could not price falls through.
   *  1. FAST PATH — the socket cache, when its tick is fresher than
   *     {@link WS_FRESH_MS}. Sub-second, already paid for, no broker call.
   *  2. BATCHED REST — everything the pool could not serve, via
   *     `UserFeedManager.fetchQuotes`: ONE call per user for all of that user's
   *     tokens (Angel takes a token list per exchange). No 30-token ceiling, so
   *     the size of the book stops deciding which trades get priced.
   *
   * Tier 2 is per-USER because this platform has no shared feed account — every
   * broker read goes over the owning user's own Angel session. The PRICE it
   * returns, though, is market-wide: an unscoped `applyTick` deliberately updates
   * every user's trackers on that exchange + token, so one tenant's session
   * answering for an instrument two tenants hold is correct, not a leak, and
   * saves the second call.
   *
   * Each user is tried in its own try/catch: one expired Angel session must cost
   * that user's prices, not everyone's.
   */
  @Interval(TradeTrackerPoller.SWEEP_MS)
  async sweepQuotes(): Promise<void> {
    if (!this.feed.isMarketOpen()) return;

    if (this.sweeping) {
      // A slow broker leg must not let the next interval stack another round of
      // calls on top — that is how a rate-limit ban starts.
      this.logger.debug('[trade-tracker] sweep already in progress — skipping');
      return;
    }
    this.sweeping = true;
    try {
      const byUser = await this.service.openTrackerRefsByUser();
      const source = this.hubSource();
      // Tier 0 first, and always: it also rebuilds (or empties) the set the hub
      // tick listener prices between sweeps.
      const served = this.priceFromHub(byUser, source);
      if (byUser.size === 0) return;

      // Instruments still needing a price, keyed EXCHANGE:token (tokens collide
      // across exchanges) and deduped across tenants.
      const unpriced = new Set<string>();
      const shared = tokensOnSeveralExchanges(byUser);
      let fromSocket = 0;
      for (const [userId, refs] of byUser) {
        for (const ref of refs) {
          const key = tickRefKey(ref);
          // A hub-served instrument takes NO unscoped legacy tick for its user: an
          // unscoped price would overwrite the hub's in any flush window holding no
          // scoped tick, and the user's rows would flip-flop between the sources.
          if (served.has(`${userId}|${key}`) || unpriced.has(key)) continue;
          // The socket cache is read by token alone (NSE → BSE → MCX), so a hit
          // counts only when the quote's own exchange is the ref's: an NFO option
          // must never take the price of an NSE equity that shares its token. A
          // token held on two exchanges skips the cache outright.
          const quote = shared.has(ref.token) ? null : this.feed.getQuote(ref.token);
          if (
            quote &&
            quote.ltp > 0 &&
            String(quote.exchange ?? '').toUpperCase() === exchangeOf(ref) &&
            this.isFresh(quote.timestamp)
          ) {
            this.service.applyTick(ref, quote.ltp);
            fromSocket++;
          } else {
            unpriced.add(key);
          }
        }
      }

      let fromRest = 0;
      let failedUsers = 0;
      for (const [userId, refs] of byUser) {
        const wanted = refs.filter((r) => {
          const key = tickRefKey(r);
          return unpriced.has(key) && !served.has(`${userId}|${key}`);
        });
        if (wanted.length === 0) continue;

        try {
          const quotes = await this.userFeeds.fetchQuotes(userId, wanted);
          for (const [token, tick] of quotes) {
            if (!tick || !(tick.ltp > 0)) continue;
            // Angel answers keyed by token alone: attribute it only when this user
            // asked for that token on exactly one exchange.
            const asked = wanted.filter((r) => r.token === token);
            if (asked.length !== 1) continue;
            this.service.applyTick(asked[0], tick.ltp);
            // Priced — no later user is asked for it again this pass.
            unpriced.delete(tickRefKey(asked[0]));
            fromRest++;
          }
        } catch (err) {
          failedUsers++;
          // Leave this user's instruments in `unpriced`: another tenant holding the
          // same instrument later in the loop can still answer for it.
          this.logger.warn(
            `[trade-tracker] batched quote fetch failed for a user: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      source?.record('positions', 'hub', served.size);
      source?.record('positions', 'legacy', fromSocket + fromRest);
      source?.record('positions', 'unpriced', unpriced.size);

      if (unpriced.size > 0) {
        // Not noise: an instrument nobody could quote is a tracker whose LTP is now ageing.
        this.logger.warn(
          `[trade-tracker] ${unpriced.size} open token(s) went unpriced this sweep ` +
            `(hub=${served.size}, socket=${fromSocket}, rest=${fromRest}, failed users=${failedUsers})`,
        );
      } else {
        this.logger.debug(
          `[trade-tracker] swept ${served.size + fromSocket + fromRest} token(s) ` +
            `(hub=${served.size}, socket=${fromSocket}, rest=${fromRest})`,
        );
      }
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Tier 0 (HUB_PRICES_POSITIONS): the hub, for the users it serves (today the
   * owner only, see HubPriceSource.hubFor). A fresh (≤ 5 s) price is applied
   * scoped to that user; anything else falls through to the legacy tiers.
   * Returns `${userId}|EXCHANGE:token` for every instrument served here.
   */
  private priceFromHub(byUser: Map<string, TokenRef[]>, source: HubPriceSource | null): Set<string> {
    const served = new Set<string>();
    const owned = new Map<string, TickTarget>();
    let owner: string | null = null;
    for (const [userId, refs] of byUser) {
      const hub = source?.hubFor(userId, 'positions') ?? null;
      if (!hub) continue;
      if (!this.unsubscribeHub) this.unsubscribeHub = hub.onPrice((p) => this.onHubPrice(p));
      owner = userId;
      const hubRefs = refs.map(toHubRef).filter((r): r is InstrumentRef => r !== null);
      const results = hub.prices(hubRefs, { maxAgeMs: TradeTrackerPoller.HUB_MAX_AGE_MS });
      for (const ref of hubRefs) {
        const key = refKey(ref);
        const target: TickTarget = { exchange: ref.exchange, token: ref.token };
        owned.set(key, target);
        const r = results.get(key);
        if (r?.kind !== 'fresh') continue;
        this.service.applyTick(target, r.price.ltp, { userId });
        served.add(`${userId}|${key}`);
      }
    }
    this.hubOwned = owned;
    this.hubUserId = owner;
    return served;
  }

  /** Every hub price (tick or polled quote) for an instrument the served user holds, as it arrives. */
  private onHubPrice(p: Price): void {
    try {
      const userId = this.hubUserId;
      const target = this.hubOwned.get(refKey(p.ref));
      if (!userId || !target || !(p.ltp > 0)) return;
      this.service.applyTick(target, p.ltp, { userId });
    } catch (err) {
      // Never throw into the hub's emit loop: it feeds every other consumer too.
      this.logger.warn(`[trade-tracker] hub price apply failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Resolved lazily (MarketHubModule imports this module); a miss is retried next sweep. */
  private hubSource(): HubPriceSource | null {
    if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
    return this.hubSourceRef;
  }

  /**
   * Whether a cached socket quote is recent enough to trust over a REST call.
   * A missing or unparseable stamp counts as STALE — the cost of a needless
   * broker call is one request; the cost of trusting an undated LTP is the
   * twenty-one-hour price this whole sweep was rewritten to eliminate.
   */
  private isFresh(timestamp: unknown): boolean {
    const at =
      timestamp instanceof Date
        ? timestamp.getTime()
        : typeof timestamp === 'string' || typeof timestamp === 'number'
          ? new Date(timestamp).getTime()
          : NaN;
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < TradeTrackerPoller.WS_FRESH_MS;
  }
}

/** EXCHANGE:token — the tracker's instrument key (tokens collide across exchanges). */
function tickRefKey(ref: TokenRef): string {
  return `${exchangeOf(ref)}:${ref.token}`;
}

/** The ref's exchange, upper-cased (rows may store `nfo`). */
function exchangeOf(ref: TokenRef): string {
  return String(ref.exchange ?? '').toUpperCase();
}

/** Tokens that open trackers hold on more than one exchange (unsafe for token-keyed caches). */
function tokensOnSeveralExchanges(byUser: Map<string, TokenRef[]>): Set<string> {
  const exchanges = new Map<string, Set<string>>();
  for (const refs of byUser.values()) {
    for (const r of refs) {
      const set = exchanges.get(r.token) ?? new Set<string>();
      set.add(String(r.exchange ?? '').toUpperCase());
      exchanges.set(r.token, set);
    }
  }
  return new Set([...exchanges].filter(([, set]) => set.size > 1).map(([token]) => token));
}

/** The hub's ref for a tracker instrument, or null for an exchange the hub does not speak. */
function toHubRef(ref: TokenRef): InstrumentRef | null {
  const exchange = String(ref.exchange ?? '').toUpperCase();
  return isHubExchange(exchange) && ref.token ? { exchange, token: ref.token, symbol: ref.token } : null;
}
