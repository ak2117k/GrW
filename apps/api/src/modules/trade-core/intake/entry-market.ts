import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { HubCandle, Timeframe } from '../../market-hub/candles/candle.types';
import { lookupHubPrices, type HubPrices } from '../../market-hub/hub-prices';
import type { InstrumentRef } from '../../market-hub/hub.types';
import { MBM_CONFIG, type MbmConfig } from '../../mbm/mbm.config';
import { MbmClient } from '../../mbm/services/mbm-client.service';
import { atr } from '../../signal-generator/strategies/indicators';
import { PRICE_MAX_AGE_MS } from '../execution/fill-model';
import { CoreCandles } from '../market/core-candles';
import type { CandleTimeframe, StopBlock } from '../strategies/blocks/block-types';

/** Ruling J6: how long the intake waits for the first fresh price of a hit's instrument. */
export const ENTRY_PRICE_WAIT_MS = 5_000;
export const ENTRY_PRICE_POLL_MS = 250;
/** The intake's watch lapses on its own if an attempt dies before releasing it. */
export const ENTRY_WATCH_TTL_MS = 60_000;
/** The silo's ATR window (adaptive-stop-watch.service.ts atr5mFor: 3 days of 5m bars). */
export const ATR_LOOKBACK_DAYS = 3;
export const DAILY_ATR_LOOKBACK_DAYS = 60;

export const intakeOwner = (intentId: string): string => `core-intake:${intentId}`;

export type PriceRead = { ok: true; ltp: number; at: number } | { ok: false; reason: 'NO_PRICE_SOURCE' | 'NO_FRESH_PRICE'; detail: string };

export interface AtrRead {
  atr: number | null;
  source: 'hub' | 'none';
  detail: string;
}

/** The block timeframes the hub candle store builds. */
const HUB_TIMEFRAME: Partial<Record<CandleTimeframe, Timeframe>> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1d': '1d' };

/** The silo's ATR (signal-generator indicators), over at least period + 1 bars; null when unusable. */
export function atrFrom(candles: readonly HubCandle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const a = atr(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), period);
  return a !== null && Number.isFinite(a) && a > 0 ? a : null;
}

/**
 * The intake's market inputs (rulings J6, J7): the entry price from the hub that prices the user's
 * positions, and candles from the hub candle store. No legacy lane, no second cache.
 */
@Injectable()
export class EntryMarket {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly candles: CoreCandles,
  ) {}

  /** Test seam (the specs replace it to advance a fake clock). */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * MBM M3: MbmClient and MBM_CONFIG from MbmModule, resolved lazily like the hub (TradeCoreModule
   * imports nothing new); null when MbmModule is not loaded.
   */
  mbm(): { client: MbmClient; config: MbmConfig } | null {
    try {
      const client = this.moduleRef.get(MbmClient, { strict: false });
      const config = this.moduleRef.get<MbmConfig>(MBM_CONFIG, { strict: false });
      return client && config ? { client, config } : null;
    } catch {
      return null;
    }
  }

  private hub(userId: string): HubPrices | null {
    return lookupHubPrices(this.moduleRef)?.hubFor(userId, 'positions') ?? null;
  }

  async freshPrice(userId: string, ref: InstrumentRef, owner: string, waitMs: number = ENTRY_PRICE_WAIT_MS): Promise<PriceRead> {
    const hub = this.hub(userId);
    if (!hub) return { ok: false, reason: 'NO_PRICE_SOURCE', detail: 'the market hub does not price this user (owner-only hub, HUB_PRICES_POSITIONS)' };
    void hub.watch([ref], 1, owner, ENTRY_WATCH_TTL_MS);
    const start = Date.now();
    for (;;) {
      const r = hub.price(ref, { maxAgeMs: PRICE_MAX_AGE_MS });
      if (r.kind === 'fresh' && r.price.ltp > 0) return { ok: true, ltp: r.price.ltp, at: r.price.at };
      if (Date.now() - start >= waitMs) return { ok: false, reason: 'NO_FRESH_PRICE', detail: `no fresh price within ${waitMs} ms (hub: ${r.kind})` };
      await this.sleep(ENTRY_PRICE_POLL_MS);
    }
  }

  release(userId: string, ref: InstrumentRef, owner: string): void {
    const hub = this.hub(userId);
    if (hub) void hub.unwatch([ref], owner);
  }

  async candlesFor(ref: InstrumentRef, tf: Timeframe, days: number, now: Date): Promise<HubCandle[] | null> {
    const r = await this.candles.read(ref, tf, new Date(now.getTime() - days * 86_400_000), now);
    return r.ok ? r.candles : null;
  }

  async atr(ref: InstrumentRef, stop: StopBlock, now: Date): Promise<AtrRead> {
    if (stop.kind !== 'atr') return { atr: null, source: 'none', detail: 'fixed stop' };
    const tf = HUB_TIMEFRAME[stop.timeframe];
    if (!tf) return { atr: null, source: 'none', detail: `the hub does not build ${stop.timeframe} candles` };
    const days = tf === '1d' ? DAILY_ATR_LOOKBACK_DAYS : ATR_LOOKBACK_DAYS;
    const r = await this.candles.read(ref, tf, new Date(now.getTime() - days * 86_400_000), now);
    if (!r.ok) return { atr: null, source: 'none', detail: r.reason };
    const a = atrFrom(r.candles, stop.period);
    if (a === null) return { atr: null, source: 'none', detail: `${r.candles.length} ${tf} candle(s); ATR(${stop.period}) needs ${stop.period + 1}` };
    return { atr: a, source: 'hub', detail: `ATR(${stop.period}) over ${r.candles.length} ${tf} candle(s)${r.complete ? '' : ' (range incomplete)'}` };
  }
}
