import type { TradeTracker } from '@prisma/client';

/**
 * The EXACT wire shape the Portfolio-page "Trade Tracker" section consumes
 * (design §5). This is a hard frontend contract: field names and types must
 * not drift. All DateTime columns are emitted as ISO-8601 strings; every
 * nullable DB column maps to `T | null` (never `undefined`) so the client can
 * render "—" deterministically.
 */
export interface TradeTrackerDto {
  id: string;
  symbol: string;
  exchange: string;
  token: string;
  kind: 'POSITION' | 'HOLDING';
  entryPrice: number;
  qty: number;
  entryTime: string; // ISO
  exitPrice: number | null;
  exitTime: string | null; // ISO | null
  status: 'OPEN' | 'CLOSED';
  holdingHigh: number | null;
  holdingLow: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  lastLtp: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  updatedAt: string; // ISO
}

/**
 * Map a persisted TradeTracker row to the frontend DTO. Dates → ISO strings;
 * nullable Float/DateTime columns → `null` (Prisma yields `null`, never
 * `undefined`, but `?? null` keeps the contract explicit and total).
 */
export function toTradeTrackerDto(t: TradeTracker): TradeTrackerDto {
  return {
    id: t.id,
    symbol: t.symbol,
    exchange: t.exchange,
    token: t.token,
    kind: t.kind as 'POSITION' | 'HOLDING',
    entryPrice: t.entryPrice,
    qty: t.qty,
    entryTime: t.entryTime.toISOString(),
    exitPrice: t.exitPrice ?? null,
    exitTime: t.exitTime ? t.exitTime.toISOString() : null,
    status: t.status as 'OPEN' | 'CLOSED',
    holdingHigh: t.holdingHigh ?? null,
    holdingLow: t.holdingLow ?? null,
    dayHigh: t.dayHigh ?? null,
    dayLow: t.dayLow ?? null,
    lastLtp: t.lastLtp ?? null,
    pnl: t.pnl ?? null,
    pnlPercent: t.pnlPercent ?? null,
    updatedAt: t.updatedAt.toISOString(),
  };
}
