import type { StockMonitor } from '@prisma/client';
import { IsNumber, IsPositive, IsString, MaxLength } from 'class-validator';

/**
 * Request body for `POST /api/monitor`. `targetPercent` is the upside profit
 * target (strictly positive) measured from the reference price captured when
 * the stock is added.
 */
export class CreateStockMonitorDto {
  @IsString()
  @MaxLength(64)
  symbol!: string;

  @IsString()
  @MaxLength(16)
  exchange!: string;

  @IsString()
  @MaxLength(32)
  token!: string;

  @IsNumber()
  @IsPositive()
  targetPercent!: number;
}

/**
 * The EXACT wire shape the `/monitor` page consumes (design §4.5). This is a
 * hard frontend contract: field names and types must not drift. `createdAt`
 * and `triggeredAt` are ISO-8601 strings; every nullable DB column maps to
 * `T | null` (never `undefined`) so the client can render "—" deterministically.
 */
export interface StockMonitorDto {
  id: string;
  symbol: string;
  exchange: string;
  token: string;
  referencePrice: number | null;
  targetPercent: number;
  targetPrice: number | null;
  status: 'WATCHING' | 'TARGET_HIT';
  lastLtp: number | null;
  currentPercent: number | null;
  triggeredAt: string | null; // ISO | null
  createdAt: string; // ISO
}

/**
 * Map a persisted StockMonitor row to the frontend DTO. Dates → ISO strings;
 * nullable Float/DateTime columns → `null` (Prisma yields `null`, never
 * `undefined`, but `?? null` keeps the contract explicit and total).
 */
export function toStockMonitorDto(m: StockMonitor): StockMonitorDto {
  return {
    id: m.id,
    symbol: m.symbol,
    exchange: m.exchange,
    token: m.token,
    referencePrice: m.referencePrice ?? null,
    targetPercent: m.targetPercent,
    targetPrice: m.targetPrice ?? null,
    status: m.status as 'WATCHING' | 'TARGET_HIT',
    lastLtp: m.lastLtp ?? null,
    currentPercent: m.currentPercent ?? null,
    triggeredAt: m.triggeredAt ? m.triggeredAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
}
