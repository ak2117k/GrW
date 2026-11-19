import { Logger } from '@nestjs/common';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import type { TokenRef } from '../../market-data/services/user-feed.types';
import type { QuotesLike } from '../services/signal-trader.service';

/**
 * The signal trader's price source, LIVE TICK FIRST (2026-11-19).
 *
 * WHY: 2026-11-18 11:24 IST the CRUDEOIL 7500 PE call was judged TAKE (70) and then dropped as
 * `price_moved` because every pre-send price read was a REST `quote` on the owner's Angel session, and
 * that session was answering "exceeding access rate" / 7 s timeouts to our own background polling (60
 * failed quote calls in those 6 minutes, broker error.log). The order never went; the put ran ~400 pts.
 * The WebSocket stream on the same session has no such rate limit, so a contract we are about to trade
 * is subscribed and its tick is the price; the REST quote is only the fallback, retried, and its real
 * error is logged instead of swallowed into "no fresh quote".
 *
 * Subscriptions are ref-counted by the feed manager and released after `holdMs` without a read.
 */
export interface TickFeedLike {
  subscribe(userId: string, tokens: TokenRef[]): Promise<void>;
  unsubscribe(userId: string, tokens: TokenRef[]): Promise<void>;
  addTickListener(fn: (userId: string, tick: TickData) => void): () => void;
  fetchQuote(userId: string, token: string, exchange: string): Promise<{ ltp: number } | null>;
}

export interface TickFirstOptions {
  /** A tick younger than this is the price without waiting. */
  freshMs?: number;
  /** How long to wait for a first tick after subscribing. */
  tickWaitMs?: number;
  /** REST fallback attempts and the gap between them. */
  restTries?: number;
  restGapMs?: number;
  /** Keep a subscription this long after its last read (a waiting trigger polls every few seconds). */
  holdMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const key = (userId: string, exchange: string, token: string) => `${userId}|${exchange.toUpperCase()}:${token}`;
const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export class TickFirstQuotes implements QuotesLike {
  private readonly logger = new Logger('SignalQuotes');
  private readonly last = new Map<string, { ltp: number; at: number }>();
  private readonly waiters = new Map<string, Array<(ltp: number) => void>>();
  private readonly held = new Map<string, { userId: string; ref: TokenRef; timer: NodeJS.Timeout }>();
  private readonly o: Required<Omit<TickFirstOptions, 'now' | 'sleep'>>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly feeds: TickFeedLike, opts: TickFirstOptions = {}) {
    this.o = {
      freshMs: opts.freshMs ?? 5_000,
      tickWaitMs: opts.tickWaitMs ?? 4_000,
      restTries: opts.restTries ?? 3,
      restGapMs: opts.restGapMs ?? 1_500,
      holdMs: opts.holdMs ?? 10 * 60_000,
    };
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    feeds.addTickListener((userId, tick) => {
      if (!valid(tick.ltp) || !tick.exchange) return;
      const k = key(userId, tick.exchange, tick.token);
      if (!this.held.has(k)) return; // only contracts this trader is pricing
      this.last.set(k, { ltp: tick.ltp, at: this.now() });
      const w = this.waiters.get(k);
      if (w) {
        this.waiters.delete(k);
        for (const f of w) f(tick.ltp);
      }
    });
  }

  async ltp(userId: string, token: string, exchange: string): Promise<number | null> {
    const k = key(userId, exchange, token);
    const cached = this.last.get(k);
    if (cached && this.now() - cached.at <= this.o.freshMs) {
      this.hold(k, userId, { token, exchange });
      return cached.ltp;
    }
    const tick = this.waitTick(k);
    await this.hold(k, userId, { token, exchange });
    const viaTick = await Promise.race([tick, this.sleep(this.o.tickWaitMs).then(() => null)]);
    this.dropWaiter(k);
    if (valid(viaTick)) return viaTick;

    // Fallback: the REST quote, retried; the cause is logged, never swallowed.
    let lastErr = 'no answer';
    for (let i = 0; i < this.o.restTries; i++) {
      if (i > 0) await this.sleep(this.o.restGapMs);
      const late = this.last.get(k); // a tick may have landed while we waited
      if (late && this.now() - late.at <= this.o.freshMs) return late.ltp;
      try {
        const q = await this.feeds.fetchQuote(userId, token, exchange);
        if (q && valid(q.ltp)) return q.ltp;
        lastErr = 'quote returned no price';
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    this.logger.warn(`[signal-quotes] no price for ${exchange}:${token}: no live tick in ${this.o.tickWaitMs / 1000} s and ${this.o.restTries} REST quote(s) failed (last: ${lastErr})`);
    return null;
  }

  private waitTick(k: string): Promise<number> {
    return new Promise((resolve) => {
      const list = this.waiters.get(k) ?? [];
      list.push(resolve);
      this.waiters.set(k, list);
    });
  }

  private dropWaiter(k: string): void {
    this.waiters.delete(k);
  }

  /** Subscribe once per contract; (re)start its release timer. */
  private async hold(k: string, userId: string, ref: TokenRef): Promise<void> {
    const h = this.held.get(k);
    if (h) {
      h.timer.refresh();
      return;
    }
    const timer = setTimeout(() => this.release(k), this.o.holdMs);
    timer.unref?.();
    this.held.set(k, { userId, ref, timer });
    try {
      await this.feeds.subscribe(userId, [ref]);
    } catch (err) {
      this.logger.warn(`[signal-quotes] live subscribe failed for ${ref.exchange}:${ref.token} (REST fallback): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private release(k: string): void {
    const h = this.held.get(k);
    if (!h) return;
    this.held.delete(k);
    this.last.delete(k);
    void this.feeds.unsubscribe(h.userId, [h.ref]).catch(() => undefined);
  }
}
