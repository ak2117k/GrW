/**
 * Test fixtures shaped like prod trade_trackers / ai_exit_executions rows
 * (owner book, 2026-07..11). Used by the portfolio-review specs only.
 */
import type { ClosedTrade, ExitInput, HoldingCheck, HoldingTrend, TrackerInput } from './types';

let seq = 0;
/** IST wall time 'YYYY-MM-DD HH:mm' → Date. */
export const ist = (s: string) => new Date(`${s.replace(' ', 'T')}:00+05:30`);

export function tracker(over: Partial<TrackerInput> & Pick<TrackerInput, 'symbol'>): TrackerInput {
  seq += 1;
  return {
    id: over.id ?? `trk${seq}`,
    exchange: 'NFO',
    token: over.token ?? `tok-${over.symbol}`,
    kind: 'POSITION',
    entryPrice: 100,
    qty: 75,
    entryTime: ist('2026-10-01 10:30'),
    exitPrice: null,
    exitTime: null,
    status: 'CLOSED',
    holdingHigh: null,
    holdingLow: null,
    lastLtp: null,
    pnl: null,
    pnlPercent: null,
    ...over,
  };
}

/** A closed position with pnl filled like the tracker does ((exit − entry) × qty). */
export function closedPos(symbol: string, entryPrice: number, exitPrice: number, qty: number, entry: string, exit: string, over: Partial<TrackerInput> = {}): TrackerInput {
  return tracker({
    symbol,
    entryPrice,
    exitPrice,
    qty,
    entryTime: ist(entry),
    exitTime: ist(exit),
    status: 'CLOSED',
    lastLtp: exitPrice,
    pnl: (exitPrice - entryPrice) * qty,
    holdingHigh: Math.max(entryPrice, exitPrice),
    holdingLow: Math.min(entryPrice, exitPrice),
    ...over,
  });
}

export function holdingRow(symbol: string, entryPrice: number, qty: number, entry: string, exit: string | null, mark: number, over: Partial<TrackerInput> = {}): TrackerInput {
  return tracker({
    symbol,
    exchange: 'NSE',
    token: over.token ?? `tok-${symbol.replace(/-(EQ|BE)$/, '')}`,
    kind: 'HOLDING',
    entryPrice,
    qty,
    entryTime: ist(entry),
    exitTime: exit ? ist(exit) : null,
    exitPrice: exit ? mark : null,
    status: exit ? 'CLOSED' : 'OPEN',
    lastLtp: mark,
    pnl: (mark - entryPrice) * qty,
    holdingHigh: Math.max(entryPrice, mark),
    holdingLow: Math.min(entryPrice, mark),
    ...over,
  });
}

export function exitRow(trackerId: string, verdictId: string, fillPrice: number | null, at = ist('2026-10-20 11:00')): ExitInput {
  return { trackerId, verdictId, status: fillPrice !== null ? 'FILLED' : 'PLACED', fillPrice, createdAt: at };
}

export const okTrend = (over: Partial<HoldingTrend> = {}): HoldingTrend => ({
  status: 'OK',
  bars: 250,
  dma50: 100,
  dma200: 100,
  high52w: 150,
  low52w: 80,
  ret6m: 0,
  ...over,
});

/** A ClosedTrade with sensible defaults, for pattern / suggestion unit tests. */
export function trade(over: Partial<ClosedTrade>): ClosedTrade {
  seq += 1;
  const net = over.net ?? 0;
  return {
    key: over.key ?? `k${seq}`,
    rowIds: [`r${seq}`],
    symbol: 'NIFTY28OCT2625000CE',
    underlying: 'NIFTY',
    exchange: 'NFO',
    token: `t${seq}`,
    kind: 'POSITION',
    segment: 'OPTIONS',
    side: 'LONG',
    status: 'CLOSED',
    qty: 75,
    entryPrice: 100,
    firstEntry: '2026-10-01T05:00:00.000Z',
    exitTime: '2026-10-01T08:00:00.000Z',
    exitPrice: 100,
    exitPriceSource: 'LAST_TICK',
    ltp: null,
    realisedGross: net + (over.charges ?? 0),
    unrealised: 0,
    charges: 0,
    holdingHigh: null,
    holdingLow: null,
    entryNotional: 7500,
    maxQty: 75,
    adds: 0,
    averagedDown: false,
    partialExits: 0,
    partialQty: 0,
    lastPartialAt: null,
    closedBy: 'AT_BROKER',
    openedBy: 'MANUAL',
    derivative: { type: 'CE', expiry: '2026-10-28', strike: 25000, dteAtEntry: 27, premiumPctOfStrike: 0.4 },
    role: 'TRADE',
    flags: [],
    net,
    holdingDays: 0.1,
    holdingBucket: 'INTRADAY',
    entryHourBucket: '10:00-12:00',
    returnPct: 0,
    peakOpenProfit: null,
    gaveBack: 0,
    ...over,
  };
}

export function holdingCheck(over: Partial<HoldingCheck> & Pick<HoldingCheck, 'symbol'>): HoldingCheck {
  return {
    exchange: 'NSE',
    token: `tok-${over.symbol}`,
    qty: 10,
    avgCost: 100,
    cost: 1000,
    ltp: 100,
    value: 1000,
    pnl: 0,
    pnlPct: 0,
    daysHeld: 100,
    firstTracked: '2026-07-11',
    sharePct: 5,
    averagedDown: false,
    trend: okTrend(),
    tags: [],
    tag: 'NEUTRAL',
    note: '',
    ...over,
  };
}
