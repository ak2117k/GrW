import type { ModuleRef } from '@nestjs/core';
import type { HubEngine } from './hub-engine';
import type { InstrumentRef, Price, PriceResult, Priority } from './hub.types';

/**
 * How consumers outside market-hub reach the hub's prices without a module
 * import cycle: MarketHubModule imports TradeTrackerModule and MarketDataModule,
 * and SignalGeneratorModule is @Global and imports MarketDataModule. Resolve it
 * lazily with {@link lookupHubPrices}. Everything this file imports is
 * `import type`, so it is safe to import from any module.
 */
export const HUB_PRICE_SOURCE = 'HUB_PRICE_SOURCE';

/** Which consumer switch a caller sits behind: HUB_PRICES_POSITIONS, HUB_PRICES_TRACKS or HUB_SERVES_BROWSER. */
export type HubConsumer = 'positions' | 'tracks' | 'browser';

/** What a consumer did with one instrument: served by the hub, fell back to its legacy tiers, or got nothing. */
export type HubOutcome = 'hub' | 'legacy' | 'unpriced';

/** One broker session's prices (today: the owner's). */
export interface HubPrices {
  price(ref: InstrumentRef, opts: { maxAgeMs: number }): PriceResult;
  prices(refs: readonly InstrumentRef[], opts: { maxAgeMs: number }): Map<string, PriceResult>;
  /**
   * Register (or renew) every ref under `owner`, then reconcile the live slots once.
   * Never rejects: a broker failure lands in status().lastError. Callers on a price
   * path must not await it.
   */
  watch(refs: readonly InstrumentRef[], priority: Priority, owner: string, ttlMs?: number): Promise<void>;
  /** Drop `owner`'s watch on every ref, then reconcile once. Never rejects (status().lastError). */
  unwatch(refs: readonly InstrumentRef[], owner: string): Promise<void>;
  /** Every price the hub learns (live tick or polled quote). Returns the unsubscribe. */
  onPrice(fn: (p: Price) => void): () => void;
}

export interface HubPriceSource {
  /**
   * THE seam: which hub prices this user's instruments for this consumer.
   * Today: the owner's hub when the hub runs, the consumer's flag is on, and
   * `userId` is HUB_OWNER_USER_ID or null (system-wide paper tracks, which
   * have no user) — except that 'browser' never serves null: a browser always
   * has a user. Otherwise null, and the caller keeps its legacy path.
   * Never another user's session. Multi-tenant: return that user's own hub.
   */
  hubFor(userId: string | null, consumer: HubConsumer): HubPrices | null;
  /** Count outcomes for /healthz/detail → hub.consumers. */
  record(consumer: HubConsumer, outcome: HubOutcome, count?: number): void;
}

/** The hub's price source if this container has the market hub; null otherwise (legacy path). */
export function lookupHubPrices(moduleRef: Pick<ModuleRef, 'get'> | null | undefined): HubPriceSource | null {
  if (!moduleRef) return null;
  try {
    return moduleRef.get<HubPriceSource>(HUB_PRICE_SOURCE, { strict: false }) ?? null;
  } catch {
    return null;
  }
}

/** One engine's prices, as the HubPrices a consumer sees. */
export function engineHubPrices(
  engine: Pick<HubEngine, 'price' | 'prices' | 'watchMany' | 'unwatchMany' | 'onPrice'>,
): HubPrices {
  return {
    price: (ref, opts) => engine.price(ref, opts),
    prices: (refs, opts) => engine.prices(refs, opts),
    watch: (refs, priority, owner, ttlMs) => engine.watchMany(refs, priority, owner, ttlMs),
    unwatch: (refs, owner) => engine.unwatchMany(refs, owner),
    onPrice: (fn) => engine.onPrice(fn),
  };
}
