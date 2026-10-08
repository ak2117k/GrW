import type { CandlesResult, Timeframe } from './candles/candle.types';
import type { InstrumentRef } from './hub.types';

/**
 * How the market-data controller reaches the hub's CandleStore without a
 * module import cycle (MarketHubModule imports MarketDataModule). Resolve it
 * lazily with ModuleRef.get(HUB_CANDLE_SOURCE, { strict: false }).
 * This file must stay free of runtime imports.
 */
export const HUB_CANDLE_SOURCE = 'HUB_CANDLE_SOURCE';

export interface HubCandleSource {
  /** True only when the hub runs, HUB_CANDLES_ENABLED and HUB_SERVES_CHARTS are on. */
  servesCharts(): boolean;
  candles(ref: InstrumentRef, timeframe: Timeframe, from: Date, to: Date): Promise<CandlesResult>;
}
