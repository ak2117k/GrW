import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { HubCandle, Timeframe } from '../../market-hub/candles/candle.types';
import { HUB_CANDLE_SOURCE, type HubCandleSource } from '../../market-hub/hub-candle-source';
import type { InstrumentRef } from '../../market-hub/hub.types';

export type CandleRead = { ok: true; candles: HubCandle[]; complete: boolean } | { ok: false; reason: string };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Ruling J7: the core reads candles only from the hub's CandleStore (one cache, one pacing gate),
 * reached lazily as the market-data controller does. Every failure is a reason, never a throw.
 */
@Injectable()
export class CoreCandles {
  constructor(private readonly moduleRef: ModuleRef) {}

  async read(ref: InstrumentRef, timeframe: Timeframe, from: Date, to: Date): Promise<CandleRead> {
    let source: HubCandleSource | null;
    try {
      source = this.moduleRef.get<HubCandleSource>(HUB_CANDLE_SOURCE, { strict: false }) ?? null;
    } catch (err) {
      return { ok: false, reason: errorText(err) };
    }
    try {
      if (!source || !source.servesCharts()) return { ok: false, reason: 'hub candles are off (HUB_CANDLES_ENABLED / HUB_SERVES_CHARTS)' };
      const r = await source.candles(ref, timeframe, from, to);
      return { ok: true, candles: r.candles, complete: r.incomplete.length === 0 };
    } catch (err) {
      return { ok: false, reason: errorText(err) };
    }
  }
}
