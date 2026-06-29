import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { LevelBookService } from './level-book.service';

export type ExitPriceSource = 'rest-batch' | 'rest-single' | 'levelbook';

export interface ExitPrice {
  price: number;
  fresh: boolean;
  source: ExitPriceSource | 'none';
}

/**
 * Risk-critical exit pricing resolver. Exit pollers historically called
 * `getLtpsBatch` and SILENTLY skipped any token the batch omitted — a held
 * position could blow past its stop and never exit because we never saw a
 * price for it.
 *
 * This service implements a "fresh-or-surface" policy: get a FRESH price
 * when possible; never fire a stop on a stale price; surface (do NOT silently
 * drop) when no fresh price exists so the caller can decide what to do.
 */
@Injectable()
export class ExitPriceService {
  private readonly logger = new Logger(ExitPriceService.name);

  /** A level-book price counts as fresh only if its last tick is within this window. */
  private static readonly FRESH_WINDOW_MS = 120_000; // 2 min

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly levelBook: LevelBookService,
  ) {}

  /**
   * Resolve an exit price per token with the fresh-or-surface policy:
   *  1. REST batch (getLtpsBatch) -> fresh.
   *  2. For tokens the batch dropped: per-token getLiveQuote (REST) -> fresh if ltp>0.
   *  3. Still missing: level-book `spot` ONLY if the book's lastTickAt is within
   *     FRESH_WINDOW_MS and spot>0 (NEVER a vwap/prevClose-only seed) -> fresh.
   *  4. Otherwise { price: 0, fresh: false, source: 'none' } — caller must
   *     SURFACE, not fire a stop.
   *
   * Returns an entry for EVERY input token. `symbolByToken` is accepted for
   * forward-compat (tier-3 lazyLoad) but v1 keeps tier 3 cheap (cached read only).
   */
  async resolveExitPrices(
    exchange: string,
    tokens: string[],
    _symbolByToken?: Map<string, string>,
  ): Promise<Map<string, ExitPrice>> {
    void _symbolByToken;
    const out = new Map<string, ExitPrice>();
    const uniq = [...new Set(tokens)];
    if (uniq.length === 0) return out;

    // Tier 1: REST batch.
    const batch = await this.adapter.getLtpsBatch(exchange, uniq);

    const missing: string[] = [];
    for (const token of uniq) {
      const ltp = batch.get(token);
      if (ltp != null && ltp > 0) {
        out.set(token, { price: ltp, fresh: true, source: 'rest-batch' });
      } else {
        missing.push(token);
      }
    }

    // Tiers 2 + 3 for everything the batch dropped.
    for (const token of missing) {
      out.set(token, await this.resolveMissing(exchange, token));
    }

    return out;
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
