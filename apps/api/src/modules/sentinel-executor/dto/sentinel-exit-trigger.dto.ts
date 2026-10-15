// apps/api/src/modules/sentinel-executor/dto/sentinel-exit-trigger.dto.ts
import type { SentinelExitTrigger } from '@prisma/client';

/**
 * Wire contract of GET /api/sentinel-executor/triggers (copied verbatim into the
 * web, price-triggers plan Task 18). What WILL fire (ruling R16): the executor's
 * own table, never the sentinel's verdict. No userId, no watch token.
 */
export interface SentinelExitTriggerDto {
  id: string;
  trackerId: string;
  verdictId: string;
  symbol: string;
  instrument: 'UNDERLYING' | 'PREMIUM' | null;
  op: 'BELOW' | 'ABOVE' | null;
  price: number | null;
  watchSymbol: string | null;
  refPrice: number | null;
  status: 'ARMED' | 'FIRED' | 'SUPERSEDED' | 'REJECTED' | 'EXPIRED';
  reason: string | null;
  armedAt: string | null;
  endedAt: string | null;
  firedAt: string | null;
  firedPrice: number | null;
  firedTickAt: string | null;
  createdAt: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toSentinelExitTriggerDto(r: SentinelExitTrigger): SentinelExitTriggerDto {
  return {
    id: r.id, trackerId: r.trackerId, verdictId: r.verdictId, symbol: r.symbol,
    instrument: r.instrument as SentinelExitTriggerDto['instrument'], op: r.op as SentinelExitTriggerDto['op'],
    price: r.price, watchSymbol: r.watchSymbol, refPrice: r.refPrice,
    status: r.status as SentinelExitTriggerDto['status'], reason: r.reason,
    armedAt: iso(r.armedAt), endedAt: iso(r.endedAt), firedAt: iso(r.firedAt),
    firedPrice: r.firedPrice, firedTickAt: iso(r.firedTickAt), createdAt: r.createdAt.toISOString(),
  };
}
