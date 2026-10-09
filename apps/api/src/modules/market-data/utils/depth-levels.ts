import type { TickDepth, TickDepthLevel } from '../../../common/interfaces/broker-adapter.interface';

/** Angel One reports five levels a side in SNAP_QUOTE and FULL. */
export const DEPTH_LEVELS = 5;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function levels(raw: unknown, toLevel: (l: any) => TickDepthLevel): TickDepthLevel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, DEPTH_LEVELS)
    .map(toLevel)
    .filter((l) => l.price > 0);
}

/** No level on either side means "not reported" (LTP/QUOTE mode, indices), never an empty book. */
function pack(bids: TickDepthLevel[], asks: TickDepthLevel[]): TickDepth | undefined {
  return bids.length === 0 && asks.length === 0 ? undefined : { bids, asks };
}

/**
 * WebSocketV2 SNAP_QUOTE (smartapi-javascript `websocket2.0.js`): `best_5_buy_data` /
 * `best_5_sell_data`, each `{ flag, quantity, price, no_of_orders }`, prices in paise.
 */
export function depthFromSnapQuote(tick: unknown, paiseDivisor: number): TickDepth | undefined {
  const t = tick as { best_5_buy_data?: unknown; best_5_sell_data?: unknown } | null | undefined;
  const toLevel = (l: any): TickDepthLevel => ({
    price: num(l?.price) / paiseDivisor,
    qty: num(l?.quantity),
    orders: num(l?.no_of_orders),
  });
  return pack(levels(t?.best_5_buy_data, toLevel), levels(t?.best_5_sell_data, toLevel));
}

/**
 * REST `marketData({ mode: 'FULL' })` entry: `depth.buy` / `depth.sell`, each
 * `{ price, quantity, orders }`, in rupees. Same key fallbacks as the shared
 * adapter's getMarketDepth (some SDK versions camel-case them).
 */
export function depthFromFullQuote(node: unknown): TickDepth | undefined {
  const n = node as any;
  const toLevel = (l: any): TickDepthLevel => ({
    price: num(l?.price ?? l?.Price),
    qty: num(l?.quantity ?? l?.qty ?? l?.Quantity),
    orders: num(l?.orders ?? l?.noOfOrders ?? l?.NoOfOrders),
  });
  const buy = n?.depth?.buy ?? n?.depth?.bestBids ?? n?.bestBids ?? n?.buy;
  const sell = n?.depth?.sell ?? n?.depth?.bestAsks ?? n?.bestAsks ?? n?.sell;
  return pack(levels(buy, toLevel), levels(sell, toLevel));
}
