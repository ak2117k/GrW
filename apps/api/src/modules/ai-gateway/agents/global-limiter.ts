import { AgentBusyError } from './agent-protocol';
import { emitAgentEvent } from './agent-events';

/**
 * Project-wide Vertex in-flight cap (design §4.5a). Vertex quota is per Google project, not per
 * container, and every agent-mode call passes through the API's `AgentProvider` — so the cap lives
 * here, once per API process.
 *
 * - `total` (`AGENTS_GLOBAL_CONCURRENCY`, default 16) calls in flight at most.
 * - `tradingReserve` (`AGENTS_TRADING_RESERVE`, default 6) of them only trading-class jobs may use:
 *   non-trading calls share `total − tradingReserve`.
 * - A call that cannot start waits (FIFO, trading waiters first) up to its wait budget, then fails
 *   `AgentBusyError` — never silently dropped.
 * - On a Vertex 429 / quota error the non-trading share is halved for 60 s (`quota` event once per
 *   squeeze). Trading keeps its slots.
 * - Low-tier jobs (`LOW_TIER_JOBS`: the message reader's `signal.read`) are admitted only while at
 *   least `LOW_TIER_HEADROOM` non-trading slots stay free for other jobs (also during a squeeze), and
 *   low-tier waiters never hold up other non-trading waiters — a burst of reads cannot starve live
 *   parse / vision calls (reader spec §5.3).
 */
export const DEFAULT_GLOBAL_CONCURRENCY = 16;
export const DEFAULT_TRADING_RESERVE = 6;
export const QUOTA_BACKOFF_MS = 60_000;
/** Jobs that only ever use spare non-trading capacity. */
export const LOW_TIER_JOBS: ReadonlySet<string> = new Set(['signal.read']);
/** Non-trading slots a low-tier job must leave free for other jobs. */
export const LOW_TIER_HEADROOM = 4;

type Tier = 'trading' | 'normal' | 'low';

function tierOf(job: string, trading: boolean): Tier {
  if (trading) return 'trading';
  return LOW_TIER_JOBS.has(job) ? 'low' : 'normal';
}

export interface GlobalLimiterOptions {
  total: number;
  tradingReserve: number;
  backoffMs?: number;
  now?: () => number;
}

interface Waiter {
  job: string;
  trading: boolean;
  tier: Tier;
  startedAt: number;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class GlobalLimiter {
  readonly total: number;
  readonly tradingReserve: number;
  private readonly backoffMs: number;
  private readonly now: () => number;
  private inFlight = 0;
  private inFlightNonTrading = 0;
  private backoffUntil = 0;
  private readonly waiters: Waiter[] = [];

  constructor(opts: GlobalLimiterOptions) {
    this.total = Math.max(1, Math.floor(opts.total));
    this.tradingReserve = Math.min(Math.max(0, Math.floor(opts.tradingReserve)), this.total - 1);
    this.backoffMs = opts.backoffMs ?? QUOTA_BACKOFF_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Non-trading calls may hold at most this many slots right now (halved during a quota squeeze). */
  nonTradingLimit(): number {
    const share = this.total - this.tradingReserve;
    return this.now() < this.backoffUntil ? Math.max(1, Math.floor(share / 2)) : share;
  }

  stats(): { inFlight: number; inFlightNonTrading: number; waiting: number; nonTradingLimit: number } {
    return {
      inFlight: this.inFlight,
      inFlightNonTrading: this.inFlightNonTrading,
      waiting: this.waiters.length,
      nonTradingLimit: this.nonTradingLimit(),
    };
  }

  private fits(tier: Tier): boolean {
    if (this.inFlight >= this.total) return false;
    if (tier === 'trading') return true;
    const limit = tier === 'low' ? this.nonTradingLimit() - LOW_TIER_HEADROOM : this.nonTradingLimit();
    return this.inFlightNonTrading < limit;
  }

  private take(trading: boolean): () => void {
    this.inFlight++;
    if (!trading) this.inFlightNonTrading++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      if (!trading) this.inFlightNonTrading--;
      this.drain();
    };
  }

  /** Admit waiters that now fit: trading first, then other non-trading FIFO, then low-tier FIFO. */
  private drain(): void {
    for (const tier of ['trading', 'normal', 'low'] as const) {
      for (let i = 0; i < this.waiters.length; ) {
        const w = this.waiters[i];
        if (w.tier === tier && this.fits(w.tier)) {
          this.waiters.splice(i, 1);
          if (w.timer) clearTimeout(w.timer);
          w.resolve(this.take(w.trading));
        } else {
          i++;
        }
      }
    }
  }

  /**
   * A slot, or `AgentBusyError` after `waitMs`. Resolves to an idempotent release function, which the
   * caller MUST call when the provider call settles.
   */
  acquire(job: string, trading: boolean, waitMs: number): Promise<() => void> {
    // Trading jumps the queue; non-trading keeps FIFO behind earlier waiters of its own tier, and
    // other non-trading jobs never queue behind low-tier waiters.
    const tier = tierOf(job, trading);
    const queuedAhead =
      tier !== 'trading' && this.waiters.some((w) => w.tier === tier || (tier === 'low' && w.tier === 'normal'));
    if (this.fits(tier) && !queuedAhead) {
      return Promise.resolve(this.take(trading));
    }
    const startedAt = this.now();
    if (!(waitMs > 0)) return Promise.reject(new AgentBusyError(job, 0));
    return new Promise((resolve, reject) => {
      const w: Waiter = { job, trading, tier, startedAt, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new AgentBusyError(job, this.now() - startedAt));
      }, waitMs);
      (w.timer as { unref?: () => void }).unref?.();
      this.waiters.push(w);
    });
  }

  /** A Vertex 429 / quota error: halve the non-trading share for 60 s; `quota` event when a squeeze starts. */
  noteQuota(job: string): void {
    const t = this.now();
    const starting = t >= this.backoffUntil;
    this.backoffUntil = t + this.backoffMs;
    if (starting) emitAgentEvent('quota', { job });
  }
}

function intEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw?.trim());
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

export function globalLimiterFrom(env: NodeJS.ProcessEnv): GlobalLimiter {
  return new GlobalLimiter({
    total: intEnv(env.AGENTS_GLOBAL_CONCURRENCY, DEFAULT_GLOBAL_CONCURRENCY),
    tradingReserve: intEnv(env.AGENTS_TRADING_RESERVE, DEFAULT_TRADING_RESERVE),
  });
}

let shared: GlobalLimiter | null = null;

/** The one limiter of this API process (every caller's transport builds its own `AgentProvider`). */
export function sharedGlobalLimiter(env: NodeJS.ProcessEnv = process.env): GlobalLimiter {
  shared ??= globalLimiterFrom(env);
  return shared;
}

/** Test hook. */
export function resetSharedGlobalLimiter(): void {
  shared = null;
}

/** Vertex quota / rate limit: HTTP 429, the SDK's `RateLimitError`, or a RESOURCE_EXHAUSTED message. */
export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; name?: unknown; constructor?: { name?: string }; message?: unknown };
  if (e.status === 429) return true;
  if (e.constructor?.name === 'RateLimitError' || e.name === 'RateLimitError') return true;
  return typeof e.message === 'string' && /RESOURCE_EXHAUSTED|quota exceeded/i.test(e.message);
}
