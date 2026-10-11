import type { GiftGap, GiftReading, NiftyFutureClose } from '../market-cues.types';
import { istDateTimeToIso, nseDateToYmd, round2, venueNumber } from './ist-dates';

/**
 * GIFT Nifty, and the gap it implies.
 *
 * Primary: NSE IX `api/market-rate?type=derivative` — the nearest-expiry NIFTY
 * FUTIDX row. Fallback: the `giftnifty` block of NSE `api/marketStatus`. Angel
 * One has no NSE IX route.
 *
 * THE GAP IS FUTURES-VS-FUTURES. GIFT Nifty is a future; comparing it with Nifty
 * SPOT folds the cost of carry into the "gap". It is compared with the NSE NIFTY
 * current-month FUTURE's close (`api/liveEquity-derivatives?index=nse50_fut`).
 */

function giftRow(r: Record<string, unknown>): GiftReading | null {
  const price = venueNumber(r.LASTPRICE);
  const expiry = nseDateToYmd(String(r.EXPIRYDATE ?? ''));
  const at = istDateTimeToIso(String(r.TIMESTMP ?? ''));
  if (price === null || price <= 0 || !expiry || !at) return null;
  const dc = venueNumber(r.DAYCHANGE_1 ?? r.DAYCHANGE);
  return { price, expiry, at, dayChange: dc };
}

/**
 * `sessionDate` ('YYYY-MM-DD'): contracts expiring before it are dropped — on a
 * rollover morning the venue may still list yesterday's expired contract.
 */
export function parseNseIxGift(data: unknown, sessionDate?: string): GiftReading {
  const rows = (data as { data?: unknown[] })?.data;
  if (!Array.isArray(rows)) throw new Error('NSE IX: no data array');
  const readings = (rows as Array<Record<string, unknown>>)
    .filter((r) => String(r.INSTRUMENTTYPE).toUpperCase() === 'FUTIDX' && String(r.SYMBOL).toUpperCase() === 'NIFTY')
    .map(giftRow)
    .filter((r): r is GiftReading => r !== null)
    .filter((r) => !sessionDate || r.expiry >= sessionDate)
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  if (readings.length === 0) throw new Error('NSE IX: no unexpired NIFTY FUTIDX row with a price, expiry and time');
  return readings[0];
}

export function parseMarketStatusGift(data: unknown, sessionDate?: string): GiftReading {
  const g = (data as { giftnifty?: Record<string, unknown> })?.giftnifty;
  const r = g ? giftRow(g) : null;
  if (!r) throw new Error('NSE marketStatus: no usable giftnifty block');
  if (sessionDate && r.expiry < sessionDate) throw new Error(`NSE marketStatus: giftnifty is the expired ${r.expiry} contract`);
  return r;
}

/**
 * The NIFTY current-month (nearest-expiry) future's CLOSE — `closePrice`, NSE's
 * official close, not the last trade. Throws when there is none (a zero close
 * during the session is "not yet", not 0).
 */
export function parseNseNiftyFutures(data: unknown): NiftyFutureClose {
  const d = data as { data?: unknown[]; timestamp?: string; marketStatus?: { marketCurrentTradingDate?: string } };
  if (!Array.isArray(d?.data)) throw new Error('NSE futures: no data array');
  const sessionDate = nseDateToYmd(d.marketStatus?.marketCurrentTradingDate ?? '') ?? nseDateToYmd(d.timestamp ?? '');
  if (!sessionDate) throw new Error('NSE futures: no session date');
  // Current month = the nearest expiry ON OR AFTER the session (an expiring
  // contract is still the front on its own expiry day).
  const rows = (d.data as Array<Record<string, unknown>>)
    .filter((r) => String(r.instrumentType).toUpperCase() === 'FUTIDX' && String(r.underlying).toUpperCase() === 'NIFTY')
    .map((r) => ({ expiry: nseDateToYmd(String(r.expiryDate ?? '')), close: venueNumber(r.closePrice) }))
    .filter((r): r is { expiry: string; close: number | null } => r.expiry !== null && r.expiry >= sessionDate)
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  const front = rows[0];
  if (!front) throw new Error('NSE futures: no unexpired NIFTY FUTIDX row');
  if (front.close === null || front.close <= 0) throw new Error(`NSE futures: NIFTY ${front.expiry} has no close yet`);
  return { close: front.close, expiry: front.expiry, sessionDate, closedAt: istDateTimeToIso(d.timestamp ?? '') };
}

export function computeGiftGap(gift: GiftReading, fut: NiftyFutureClose | null): GiftGap {
  const comparison =
    'futures-vs-futures gap: GIFT Nifty near-month future minus the NSE NIFTY current-month future close ' +
    '(not spot — spot would fold the cost of carry into the gap)';
  if (!fut) return { gift, niftyFuture: null, gap: null, gapPercent: null, expiryMatches: null, comparison };
  // Two different contracts (rollover, or an expiry evening): their difference
  // is calendar spread, not an opening gap — no gap at all rather than a wrong one.
  if (gift.expiry !== fut.expiry) {
    return { gift, niftyFuture: fut, gap: null, gapPercent: null, expiryMatches: false, comparison };
  }
  const gap = round2(gift.price - fut.close);
  return {
    gift,
    niftyFuture: fut,
    gap,
    gapPercent: round2((gap / fut.close) * 100),
    expiryMatches: gift.expiry === fut.expiry,
    comparison,
  };
}
