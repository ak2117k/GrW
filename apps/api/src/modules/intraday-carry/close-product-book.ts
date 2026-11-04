import { Injectable } from '@nestjs/common';
import { NO_CLOSE_CONTEXT, type CloseContext, type CloseProductLookup } from '../trade-sentinel/ports/close-products.port';
import { carryWindowFor, isLiveCarryUser, parseCarryConfig, type CarryConfig } from './domain/carry-config';

/** A product read older than this is "unknown" (the cycle then behaves as before 2026-11-04). */
export const PRODUCT_STALE_MS = 5 * 60_000;
/** The carry framing is offered only while the carry service has run a pass this recently. */
export const CARRY_ALIVE_MS = 2 * 60_000;

/**
 * The live cycle's CLOSE_PRODUCTS (ports/close-products.port.ts): an in-memory cache of each open
 * tracker's broker product, filled by IntradayCarryService from warm position-book reads.
 *
 * WHY THE CARRY WINDOW IS GATED ON A HEARTBEAT: the CARRY/EXIT framing tells the judge "HOLD means
 * CARRY — the engine converts it". If the carry service is not actually running (BOOT_JOBS=false, a
 * crash, a broker outage) a HOLD would silently leave an MIS position to the broker's square-off —
 * the silent-absence failure (memory: correct code, inert, silent). So `carry` is returned only for a
 * live-allowed user (INTRADAY_CARRY_USERS) while the service has marked a pass in the last
 * CARRY_ALIVE_MS; otherwise the position gets today's look.
 *
 * Imports nothing that reaches a broker — it is provided in TradeSentinelModule beside the cycle.
 */
@Injectable()
export class CloseProductBook implements CloseProductLookup {
  private readonly products = new Map<string, { productType: string; at: number }>();
  private alivePassAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly cfg: CarryConfig = parseCarryConfig(process.env), private readonly clock: () => number = Date.now) {}

  set(trackerId: string, productType: string, at: number = this.clock()): void {
    this.products.set(trackerId, { productType: String(productType).trim().toUpperCase(), at });
  }

  forget(trackerId: string): void {
    this.products.delete(trackerId);
  }

  /** The carry service ran a pass (its timer is alive and it read the books it needed). */
  markAlive(at: number = this.clock()): void {
    this.alivePassAt = at;
  }

  productTypeOf(trackerId: string): string | null {
    const r = this.products.get(trackerId);
    return r && this.clock() - r.at <= PRODUCT_STALE_MS ? r.productType : null;
  }

  closeContextFor(entry: { userId: string; trackerId: string; exchange: string }): CloseContext {
    const productType = this.productTypeOf(entry.trackerId);
    if (productType === null) return NO_CLOSE_CONTEXT;
    const alive = this.clock() - this.alivePassAt <= CARRY_ALIVE_MS;
    const carry = alive && isLiveCarryUser(this.cfg, entry.userId) ? carryWindowFor(this.cfg, entry.exchange) : null;
    return { productType, carry };
  }
}
