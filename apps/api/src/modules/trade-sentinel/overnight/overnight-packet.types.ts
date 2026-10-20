import type { Prisma } from '@prisma/client';
import type { Block, ContextPacket } from '../services/context-packet.service';
import type { ReviewKind } from './overnight-calendar';
import type { Cue, OvernightDecay } from './overnight-evidence';
import type { ScorecardBrief } from './scorecard-block';

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
  /** The 09:10 pre-open check's IEP read for this position (labelled by what it prices); absent in every other window. */
  preOpenGap: Block<Prisma.InputJsonValue>;
  news: Block<Prisma.InputJsonValue>;
  oi: Block<Prisma.InputJsonValue>;
  marketCues: {
    /** US indices: the previous US session close (Nasdaq Composite, S&P 500, Dow). */
    nasdaq: Block<Cue>;
    sp500: Block<Cue>;
    dow: Block<Cue>;
    /** US index futures overnight, at their own quote time. */
    nasdaqFutures: Block<Cue>;
    sp500Futures: Block<Cue>;
    /** GIFT Nifty vs the NSE NIFTY current-month future close — futures-vs-futures. */
    giftNifty: Block<Prisma.InputJsonValue>;
    /** FII/DII cash-market flows (₹ crore) for the latest published session. */
    fiiFlows: Block<Prisma.InputJsonValue>;
    /** FII index futures / index call / index put positioning, and its change. */
    fiiDerivatives: Block<Prisma.InputJsonValue>;
    crudeOil: Block<Cue>;
    gold: Block<Cue>;
    indiaVix: Block<Cue>;
    sectorStrength: Block<Prisma.InputJsonValue>;
    underlyingChange: Block<Cue>;
  };
  /**
   * The position's deterministic scorecard (factor points, total, band). The key
   * is ABSENT — not an absent block — unless SENTINEL_SCORECARD=on and a
   * scorecard exists, so the packet is byte-identical to before otherwise, and
   * its presence is what selects the scorecard prompt (see overnightPromptFor).
   */
  scorecard?: Block<ScorecardBrief>;
};

export type OvernightPacket = ContextPacket & { overnight: OvernightSection };

/** Compile-time proof the overnight packet is storable as-is. See `packetAsJson`. */
export function overnightPacketAsJson(packet: OvernightPacket): Prisma.InputJsonValue {
  return packet;
}
