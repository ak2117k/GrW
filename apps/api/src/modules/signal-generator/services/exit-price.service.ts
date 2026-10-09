import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { lookupHubPrices, type HubPriceSource } from '../../market-hub/hub-prices';
import { isHubExchange, refKey, type InstrumentRef } from '../../market-hub/hub.types';
import { LevelBookService } from './level-book.service';

export type ExitPriceSource = 'hub' | 'rest-batch' | 'rest-single' | 'levelbook';

export interface ExitPrice {
  price: number;
  fresh: boolean;
  source: ExitPriceSource | 'none';
}

/** Hub watch owner for strategy-track exits (system paper tracks, no userId). */
export const EXIT_WATCH_OWNER = 'track:exit';
/** Paper track exits are demotable (3): real open positions (0) keep the live slots; near-live polling (~5 s) meets the 10 s bound. */
export const EXIT_WATCH_PRIORITY = 3;
/** Renewed on every resolve: a track that stops asking stops holding a slot within 2 min. */
export const EXIT_WATCH_TTL_MS = 120_000;
/** Spec §5.3: trading decisions accept a price at most 10 s old. */
export const EXIT_HUB_MAX_AGE_MS = 10_000;

/**
 * Risk-critical exit pricing resolver. Exit pollers historically called
 * `getLtpsBatch` and SILENTLY skipped any token the batch omitted — a held
 * position could blow past its stop and never exit because we never saw a
 * price for it.
 *
 * This service implements a "fresh-or-surface" policy: get a FRESH price
 * when possible; never fire a stop on a stale price; surface (do NOT silently
 * drop) when no fresh price exists so the caller can decide what to do.
 *
 * SP1 M3 (HUB_PRICES_TRACKS): the market hub is tier 0. Every token is watched
 * at priority 3 (owner `track:exit`, 2 min TTL renewed per call) and read with a
 * 10 s bound; anything the hub cannot serve fresh falls through to the legacy
 * tiers for that token. With the flag off or no hub, behaviour is exactly M2's.
 */
@Injectable()
export class ExitPriceService {
  private readonly logger = new Logger(ExitPriceService.name);

  /** A level-book price counts as fresh only if its last tick is within this window. */
  private static readonly FRESH_WINDOW_MS = 120_000; // 2 min

  private hubSourceRef: HubPriceSource | null = null;

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly levelBook: LevelBookService,
    // Resolves HUB_PRICE_SOURCE lazily: MarketHubModule imports MarketDataModule,
    // which this @Global module imports too. Optional: a hand-built instance has no hub tier.
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * Resolve an exit price per token with the fresh-or-surface policy:
   *  0. The hub (HUB_PRICES_TRACKS), a price ≤ 10 s old -> fresh, source 'hub'.
   *  1. REST batch (getLtpsBatch) -> fresh.
   *  2. For tokens the batch dropped: per-token getLiveQuote (REST) -> fresh if ltp>0.
   *  3. Still missing: level-book `spot` ONLY if the book's lastTickAt is within
   *     FRESH_WINDOW_MS and spot>0 (NEVER a vwap/prevClose-only seed) -> fresh.
   *  4. Otherwise { price: 0, fresh: false, source: 'none' } — caller must
   *     SURFACE, not fire a stop.
   *
   * Returns an entry for EVERY input token, in input order. `symbolByToken`
   * names the hub watch (the token is used when it is absent).
   */
  async resolveExitPrices(
    exchange: string,
    tokens: string[],
    symbolByToken?: Map<string, string>,
  ): Promise<Map<string, ExitPrice>> {
    const out = new Map<string, ExitPrice>();
    const uniq = [...new Set(tokens)];
    if (uniq.length === 0) return out;

    const source = this.hubSource();
    const resolved = new Map<string, ExitPrice>();
    const legacy = this.fromHub(source, exchange, uniq, symbolByToken, resolved);

    if (legacy.length > 0) {
      // Tier 1: REST batch.
      const batch = await this.adapter.getLtpsBatch(exchange, legacy);
      for (const token of legacy) {
        const ltp = batch.get(token);
        // Tiers 2 + 3 for everything the batch dropped.
        resolved.set(
          token,
          ltp != null && ltp > 0 ? { price: ltp, fresh: true, source: 'rest-batch' } : await this.resolveMissing(exchange, token),
        );
      }
    }

    for (const token of uniq) out.set(token, resolved.get(token) as ExitPrice);
    this.count(source, out);
    return out;
  }

  /** Tier 0. Fills `resolved` with fresh hub prices and returns the tokens left for the legacy tiers. */
  private fromHub(
    source: HubPriceSource | null,
    exchange: string,
    tokens: string[],
    symbolByToken: Map<string, string> | undefined,
    resolved: Map<string, ExitPrice>,
  ): string[] {
    const hub = source?.hubFor(null, 'tracks') ?? null;
    const ex = exchange.toUpperCase();
    if (!hub || !isHubExchange(ex)) return tokens;

    const refs: InstrumentRef[] = tokens.map((token) => ({ exchange: ex, token, symbol: symbolByToken?.get(token) ?? token }));
    // Register or renew, fire-and-forget: a slow broker subscribe must never hold an exit decision.
    void hub.watch(refs, EXIT_WATCH_PRIORITY, EXIT_WATCH_OWNER, EXIT_WATCH_TTL_MS).catch(() => undefined);
    const results = hub.prices(refs, { maxAgeMs: EXIT_HUB_MAX_AGE_MS });
    const legacy: string[] = [];
    for (const ref of refs) {
      const r = results.get(refKey(ref));
      if (r?.kind === 'fresh' && r.price.ltp > 0) {
        resolved.set(ref.token, { price: r.price.ltp, fresh: true, source: 'hub' });
      } else {
        // stale, market-closed, never-priced, not-watched, throttled, no-session: never a price of 0 from here.
        legacy.push(ref.token);
      }
    }
    return legacy;
  }

  /** /healthz/detail → hub.consumers.tracks. */
  private count(source: HubPriceSource | null, out: Map<string, ExitPrice>): void {
    if (!source) return;
    let hub = 0;
    let legacy = 0;
    let unpriced = 0;
    for (const r of out.values()) {
      if (!r.fresh) unpriced++;
      else if (r.source === 'hub') hub++;
      else legacy++;
    }
    source.record('tracks', 'hub', hub);
    source.record('tracks', 'legacy', legacy);
    source.record('tracks', 'unpriced', unpriced);
  }

  /** Resolved lazily; a miss (no hub in this container) is retried on the next call. */
  private hubSource(): HubPriceSource | null {
    if (!this.hubSourceRef) this.hubSourceRef = lookupHubPrices(this.moduleRef);
    return this.hubSourceRef;
  }

  private async resolveMissing(exchange: string, token: string): Promise<ExitPrice> {
    // Tier 2: per-token REST FULL quote (throws if nothing).
    try {
      const quote = await this.adapter.getLiveQuote(token, exchange);
      const ltp = Number(quote?.ltp ?? 0);
      if (ltp > 0) {
        return { price: ltp, fresh: true, source: 'rest-single' };
      }
    } catch (err) {
      this.logger.debug(
        `getLiveQuote(${token}) failed, trying level book: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Tier 3: cached level-book spot, fresh ONLY if last tick is recent.
    const book = this.levelBook.getLevels(token);
    if (book && book.spot > 0) {
      const age = Date.now() - new Date(book.lastTickAt).getTime();
      if (age <= ExitPriceService.FRESH_WINDOW_MS) {
        return { price: book.spot, fresh: true, source: 'levelbook' };
      }
    }

    // Tier 4: surface — no fresh price. Caller must NOT fire a stop on this.
    return { price: 0, fresh: false, source: 'none' };
  }
}
