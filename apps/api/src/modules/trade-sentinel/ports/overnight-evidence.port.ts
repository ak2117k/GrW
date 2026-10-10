/**
 * What the overnight review reads beyond the live packet: news since the close,
 * the end-of-day OI picture, and the market cues a trader checks before the
 * open.
 *
 * A PORT, for the reason every other sentinel port is one (see
 * `open-positions.port.ts`): the services behind it — news, options-chain,
 * market-data — reach the market feed and from there the Angel One adapter,
 * which has `placeOrder`. `SentinelOvernightService` depends on this interface
 * only; the broker-capable implementation (`adapters/overnight-evidence.adapter.ts`)
 * is named only in the module's composition root. The import-graph walk in
 * `sentinel-cycle.service.spec.ts` enforces it.
 *
 * Every method returns RAW readings. Turning them into packet blocks — the
 * build-up quadrant, staleness, "unavailable" with its reason — is pure code in
 * `overnight/overnight-evidence.ts`. Methods may throw; the service turns a
 * throw into a stated absence naming the source.
 */
import type { Prisma } from '@prisma/client';
import type { Segment } from '../charges';
import type { CueBasis, NewsEvidence, ParsedOption, RawOiAnalysis } from '../overnight/overnight-evidence';
import type { OvernightGreeks } from '../overnight/overnight-packet.types';
import type { CueRecord, MarketCuesSnapshot, PreOpenBook } from '../../market-cues/market-cues.types';

export interface OvernightEvidenceQuery {
  userId: string;
  /** Broker tradingsymbol. */
  symbol: string;
  exchange: string;
  segment: Segment;
  /** The underlying's name as the news feed and the options chain key it ('NIFTY', 'CRUDEOIL'), or null. */
  underlying: string | null;
  /** 'YYYY-MM-DD', or null. */
  expiry: string | null;
  option: ParsedOption | null;
  underlyingLtp: number | null;
  /** The last session close this review looks back on. */
  since: Date;
  now: Date;
}

/** One cue as read from its source: a reading, or why there is none. */
export type RawCue =
  | {
      /** `at` is the source's own time, or the close of the session the value describes — never the review time. */
      reading: { value: number; change: number | null; changePercent: number | null; at: string; basis: CueBasis };
      source: string;
    }
  | { reading: null; reason: string };

export interface RawCues {
  /**
   * US closes and futures, FII/DII, FII index OI and GIFT Nifty from the
   * market-cues service — each record with its own source time, basis and
   * status. All 'unavailable' (with the reason) when the service is off.
   */
  market: MarketCuesSnapshot;
  crudeOil: RawCue;
  gold: RawCue;
  indiaVix: RawCue;
  underlyingChange: RawCue;
  sectorStrength:
    | { value: Prisma.InputJsonValue; source: string; at: string }
    | { value: null; reason: string };
}

export interface RawOiEvidence {
  analysis: RawOiAnalysis;
  /** Greeks for the position's own strike off the chain, or null when there is no such leg. */
  legGreeks: (OvernightGreeks & { source: string; at: string }) | null;
}

export interface OvernightEvidenceSource {
  news(q: OvernightEvidenceQuery): Promise<NewsEvidence>;
  oi(q: OvernightEvidenceQuery): Promise<RawOiEvidence>;
  cues(q: OvernightEvidenceQuery): Promise<RawCues>;
  /** Today's NSE pre-open book (IEP per symbol) for the 09:10 check; fetched if this process has not got today's. */
  preOpen(now: Date): Promise<CueRecord<PreOpenBook>>;
}

/** DI token — an interface cannot be resolved by type. */
export const OVERNIGHT_EVIDENCE = 'SENTINEL_OVERNIGHT_EVIDENCE';
