import type { Prisma } from '@prisma/client';
import type { Block, ContextPacket } from '../services/context-packet.service';
import type { ReviewKind } from './overnight-calendar';
import type { Cue, OvernightDecay } from './overnight-evidence';

/**
 * The overnight half of the packet. `type`, not `interface`, throughout — the
 * whole packet is written verbatim to a jsonb column (see `packetAsJson`).
 */
export type OvernightGreeks = {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
};

export type OvernightSection = {
  review: {
    kind: ReviewKind;
    /** The idempotency tag this verdict is recorded under. */
    window: string;
    /** The session close this review looks back on. */
    lastCloseAt: string | null;
    /** The session open the plan is for. */
    nextOpenAt: string | null;
    hoursUntilOpen: number | null;
    /** When `position.ltp` was last printed — it is NOT a live price overnight. */
    lastPriceAt: string | null;
    /** What `lastPriceAt` measures — see LAST_PRICE_AT_BASIS. */
    lastPriceAtBasis: string;
  };
  expiry: Block<{ expiry: string; calendarDays: number; tradingSessionsLeft: number }>;
  decay: Block<OvernightDecay>;
  greeks: Block<OvernightGreeks>;
  preOpenPrice: Block<number>;
  news: Block<Prisma.InputJsonValue>;
  oi: Block<Prisma.InputJsonValue>;
  marketCues: {
    nasdaq: Block<Cue>;
    crudeOil: Block<Cue>;
    gold: Block<Cue>;
    fiiFlows: Block<Cue>;
    indiaVix: Block<Cue>;
    sectorStrength: Block<Prisma.InputJsonValue>;
    underlyingChange: Block<Cue>;
  };
};

export type OvernightPacket = ContextPacket & { overnight: OvernightSection };

/** Compile-time proof the overnight packet is storable as-is. See `packetAsJson`. */
export function overnightPacketAsJson(packet: OvernightPacket): Prisma.InputJsonValue {
  return packet;
}
