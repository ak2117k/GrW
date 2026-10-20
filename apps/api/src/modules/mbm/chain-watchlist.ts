// apps/api/src/modules/mbm/chain-watchlist.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { normaliseUnderlying } from './domain/stock-chain';
import { MBM_CONFIG, type MbmConfig } from './mbm.config';
import { MbmChainRepository } from './repositories/mbm-chain.repository';
import { MBM_NOW } from './services/mbm-bar-refresher.service';

/** One chain to capture: the instrument-master underlying name and the chain's venue (always 'NFO' here). */
export interface ChainSymbol {
  symbol: string;
  exchange: string;
}

/** The dynamic per-symbol chain-capture list (overnight scorecard, stream A). */
export interface ChainWatchlist {
  symbols(): Promise<ChainSymbol[]>;
}

/** Nest token for the watchlist (stream B's news scan injects it and calls `add`). */
export const CHAIN_WATCHLIST = Symbol('CHAIN_WATCHLIST');

/** NIFTY has its own 5-min ±15 capture (MBM_CHAIN_CAPTURE); it never rides the per-symbol list. */
export const INDEX_CAPTURED_ELSEWHERE: ReadonlySet<string> = new Set(['NIFTY']);
/** Upper bound on a registration's life, so a bad caller cannot pin a symbol forever. */
export const MAX_TTL_HOURS = 72;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Default watchlist: the underlyings of the owner's (MBM_FEED_USER_ID) OPEN Angel NFO positions, read from
 * the broker-synced trade_trackers each call, plus symbols registered with `add(symbols, ttlHours)` until
 * their TTL lapses. Registrations live in memory (a restart drops them; the next news batch re-adds).
 * A failed positions read degrades to the registered symbols only — it never throws.
 */
@Injectable()
export class ChainWatchlistService implements ChainWatchlist {
  private readonly logger = new Logger(ChainWatchlistService.name);
  /** underlying → expiry epoch ms */
  private readonly added = new Map<string, number>();

  constructor(
    @Inject(MBM_CONFIG) private readonly config: MbmConfig,
    private readonly repo: MbmChainRepository,
    @Inject(MBM_NOW) private readonly now: () => Date,
  ) {}

  /**
   * Registers symbols (underlying names like `RELIANCE`, or `{symbol, exchange}`; a `-EQ` suffix is
   * dropped) for `ttlHours` (clamped to 0 < ttl ≤ MAX_TTL_HOURS). Re-adding extends, never shortens.
   * Returns the names registered.
   */
  add(symbols: ReadonlyArray<string | { symbol: string; exchange?: string }>, ttlHours: number): string[] {
    const ttl = Number.isFinite(ttlHours) ? Math.min(Math.max(ttlHours, 0), MAX_TTL_HOURS) : 0;
    if (ttl <= 0) return [];
    const until = this.now().getTime() + ttl * 3_600_000;
    const out: string[] = [];
    for (const s of symbols) {
      const name = normaliseUnderlying(typeof s === 'string' ? s : s?.symbol);
      if (!name) continue;
      this.added.set(name, Math.max(this.added.get(name) ?? 0, until));
      out.push(name);
    }
    return out;
  }

  async symbols(): Promise<ChainSymbol[]> {
    const names = new Set<string>();
    const user = this.config.feedUserId;
    if (user) {
      try {
        for (const n of await this.repo.openFnoUnderlyings(user)) {
          const name = normaliseUnderlying(n);
          if (name) names.add(name);
        }
      } catch (e) {
        this.logger.warn(`[mbm] chain watchlist: open positions unreadable, using registered symbols only: ${errText(e)}`);
      }
    }
    const nowMs = this.now().getTime();
    for (const [name, until] of this.added) {
      if (until <= nowMs) this.added.delete(name);
      else names.add(name);
    }
    return [...names].filter((n) => !INDEX_CAPTURED_ELSEWHERE.has(n)).map((symbol) => ({ symbol, exchange: 'NFO' }));
  }
}
