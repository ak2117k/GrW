import type { TickData } from '../../common/interfaces/broker-adapter.interface';
import type { Price } from './hub.types';

function finite(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/**
 * What a hub price carries beyond the LTP: the day bar and the book. An all-zero
 * day bar and an empty book are LEFT OFF. The day bar is kept when EITHER open or
 * close is positive, so `day.close` can still be 0 ("not reported") when only the
 * open was: a consumer must guard `day.close > 0` before deriving a change from
 * it (as priceToBrowserTick and tickToQuote do), or it reads as a -100 % day.
 */
export function tickExtras(t: TickData): Pick<Price, 'day' | 'depth'> {
  const out: Pick<Price, 'day' | 'depth'> = {};
  if (finite(t.close) > 0 || finite(t.open) > 0) {
    out.day = { open: finite(t.open), high: finite(t.high), low: finite(t.low), close: finite(t.close) };
  }
  if (t.depth && (t.depth.bids.length > 0 || t.depth.asks.length > 0)) {
    out.depth = { bids: t.depth.bids.map((l) => ({ ...l })), asks: t.depth.asks.map((l) => ({ ...l })) };
  }
  return out;
}
