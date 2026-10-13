import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import { TradeTrackerService, type ReconcileResult } from './trade-tracker.service';
import { anyExchangeInReconcileWindow, exchangeInReconcileWindow } from './trade-tracker-poller.service';
import { OrderUpdateStream, type OrderSocketFactory, type OrderUpdate } from './order-update-stream';

/** Optional DI seam for the order socket (tests pass a fake; production builds a `ws` socket). */
export const ORDER_SOCKET_DEPS = 'LIVE_SYNC_ORDER_SOCKET_DEPS';
export interface LiveSyncDeps {
  socketFactory?: OrderSocketFactory;
}

/** Poll cadence default and floor (LIVE_SYNC_POLL_MS). */
const DEFAULT_POLL_MS = 60_000;
const MIN_POLL_MS = 30_000;
/** Order-update debounce default (LIVE_SYNC_DEBOUNCE_MS), bounds 0.5–30 s. */
const DEFAULT_DEBOUNCE_MS = 2_000;
/** How often the stream supervisor checks the session window and the session's JWT. */
const SUPERVISE_MS = 30_000;

function defaultSocketFactory(): OrderSocketFactory {
  return (url, headers) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WebSocket = require('ws');
    return new WebSocket(url, { headers, handshakeTimeout: 15_000 });
  };
}

/**
 * NEAR-LIVE broker position tracking, on top of the 10-minute reconcile cron.
 *
 * On 2026-10-13 the owner's Angel One stop-loss filled at ~22:44 IST and the
 * tracker stayed OPEN until the next 10-minute sync — the sentinel and the AI
 * auto-exit, which watch OPEN trackers only, reasoned about a position that no
 * longer existed; a new position likewise surfaced up to 10 minutes late.
 * Two cooperating paths, both positions-only and both over the user's LIVE
 * feed session only (never a login):
 *
 *  A) ORDER STREAM (LIVE_SYNC_ORDER_STREAM_ENABLED, owner only): Angel's
 *     order-update WebSocket on the owner's live session tokens. A fill,
 *     partial fill, cancel or reject triggers a reconcile of that user,
 *     debounced (LIVE_SYNC_DEBOUNCE_MS, 2 s) so a burst is one broker read.
 *     Latency ≈ debounce + one getPosition ≈ 2–4 s.
 *
 *  B) ADAPTIVE POLL (LIVE_SYNC_POLL_ENABLED): every LIVE_SYNC_POLL_MS (60 s,
 *     floor 30 s), each user with ≥1 OPEN POSITION tracker on an exchange in
 *     its session window AND a live feed session gets one positions-only
 *     reconcile. The backstop for a stream that is down, and the only
 *     near-live path for other users. Users without a live session stay on
 *     the 10-minute cron (a login per minute is not acceptable load).
 *
 * Both go through `TradeTrackerService.backfill`, so they share its per-user
 * single flight with the cron (no duplicate trackers) and its answered-envelope
 * guard (a failed read never closes a tracker). A reconcile that changed the
 * open set re-offers the open tokens to the shared feed (the tracker service
 * already invalidates its caches; the market hub re-watches via onOpenSetChanged;
 * the sentinel roster reads the table on its next 30 s tick).
 *
 * Load: per active user one getPosition per poll interval (holdings stay on the
 * 10-min cron), plus one per order burst — well inside Angel's ~10 req/s, and
 * no historical-gate traffic at all.
 */
@Injectable()
export class LiveBrokerSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveBrokerSyncService.name);
  private readonly session = new SessionClock({ holidays: MARKET_HOLIDAYS });

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private superviseTimer: ReturnType<typeof setInterval> | null = null;
  private stream: OrderUpdateStream | null = null;
  private streamUserId: string | null = null;
  private polling = false;
  private readonly debounces = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs = DEFAULT_DEBOUNCE_MS;
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly tracker: TradeTrackerService,
    private readonly userFeeds: UserFeedManager,
    private readonly feed: MarketFeedService,
    @Optional() @Inject(ORDER_SOCKET_DEPS) private readonly deps?: LiveSyncDeps,
  ) {}

  onModuleInit(): void {
    if (!bootJobsEnabled()) {
      this.logger.log(`${BOOT_JOBS_DISABLED} (live broker sync)`);
      return;
    }
    this.debounceMs = clamp(num(this.config.get('liveSync.debounceMs'), DEFAULT_DEBOUNCE_MS), 500, 30_000);

    if (this.config.get('liveSync.pollEnabled') !== false) {
      const pollMs = Math.max(MIN_POLL_MS, num(this.config.get('liveSync.pollMs'), DEFAULT_POLL_MS));
      this.pollTimer = setInterval(() => void this.pollOnce(), pollMs);
      this.pollTimer.unref?.();
      this.logger.log(`[live-sync] adaptive position poll every ${pollMs / 1000}s while a position is open`);
    }

    const userId =
      (this.config.get<string>('liveSync.orderStreamUserId') || this.config.get<string>('hub.ownerUserId') || '').trim();
    if (this.config.get('liveSync.orderStreamEnabled') !== false && userId) {
      this.streamUserId = userId;
      this.stream = new OrderUpdateStream({
        auth: () => this.userFeeds.streamAuth(userId),
        socketFactory: this.deps?.socketFactory ?? defaultSocketFactory(),
        onUpdate: (u) => this.onOrderUpdate(userId, u),
        log: (m) => this.logger.log(m),
      });
      this.superviseStream();
      this.superviseTimer = setInterval(() => this.superviseStream(), SUPERVISE_MS);
      this.superviseTimer.unref?.();
    } else if (this.config.get('liveSync.orderStreamEnabled') !== false) {
      this.logger.warn('[live-sync] order stream not started: no LIVE_SYNC_ORDER_STREAM_USER_ID / HUB_OWNER_USER_ID');
    }
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.superviseTimer) clearInterval(this.superviseTimer);
    this.pollTimer = null;
    this.superviseTimer = null;
    for (const t of this.debounces.values()) clearTimeout(t);
    this.debounces.clear();
    this.stream?.stop();
  }

  /**
   * Keep the stream open only while some exchange is in its reconcile window
   * (nothing fills overnight, and a socket held open all night is reconnect
   * noise), and reopen it on the new JWT when the live session re-logged in.
   */
  private superviseStream(): void {
    const stream = this.stream;
    const userId = this.streamUserId;
    if (!stream || !userId || this.destroyed) return;
    try {
      if (!anyExchangeInReconcileWindow(this.session, new Date())) {
        stream.stop();
        return;
      }
      if (stream.state() === 'stopped') {
        stream.start();
        return;
      }
      const jwt = this.userFeeds.streamAuth(userId)?.jwtToken ?? null;
      if (jwt && stream.jwtInUse() && jwt !== stream.jwtInUse()) stream.restart();
    } catch (err) {
      this.logger.warn(`[live-sync] stream supervisor error: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** A fill / terminal order event: reconcile this user once the burst settles. */
  private onOrderUpdate(userId: string, u: OrderUpdate): void {
    this.logger.debug(`[live-sync] order ${u.orderId || '?'} ${u.status || u.code} ${u.exchange}:${u.token}`);
    const pending = this.debounces.get(userId);
    if (pending) clearTimeout(pending);
    const t = setTimeout(() => {
      this.debounces.delete(userId);
      void this.reconcile(userId, 'order update');
    }, this.debounceMs);
    t.unref?.();
    this.debounces.set(userId, t);
  }

  /** One adaptive-poll pass. Never overlaps itself; one user's failure never stops the others. */
  async pollOnce(): Promise<void> {
    if (this.polling || this.destroyed) return;
    const now = new Date();
    if (!anyExchangeInReconcileWindow(this.session, now)) return;
    this.polling = true;
    try {
      const byUser = await this.tracker.openPositionExchangesByUser();
      for (const [userId, exchanges] of byUser) {
        if (this.destroyed) return;
        if (![...exchanges].some((ex) => exchangeInReconcileWindow(this.session, ex, now))) continue;
        // A live session only: reading without one would cost a login every minute.
        if (!this.userFeeds.warmRestClient(userId)) continue;
        if (this.tracker.isBackfilling(userId)) continue;
        await this.reconcile(userId, 'poll');
      }
    } catch (err) {
      this.logger.warn(`[live-sync] poll failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.polling = false;
    }
  }

  private async reconcile(userId: string, why: string): Promise<ReconcileResult | null> {
    try {
      const r = await this.tracker.backfill(userId, { positionsOnly: true, warmOnly: true });
      if (r.opened + r.closed > 0) {
        this.logger.log(`[live-sync] ${why}: opened ${r.opened}, closed ${r.closed} position tracker(s) for a user`);
        await this.offerOpenTokensToFeed();
      }
      return r;
    } catch (err) {
      this.logger.warn(`[live-sync] ${why} reconcile failed for a user: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** The legacy shared socket's queue, re-offered on a change (as the 10-min cron does). */
  private async offerOpenTokensToFeed(): Promise<void> {
    try {
      const tokens = await this.tracker.distinctOpenTokens();
      if (tokens.length > 0) await this.feed.subscribe(tokens);
    } catch (err) {
      this.logger.warn(`[live-sync] feed subscribe failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
