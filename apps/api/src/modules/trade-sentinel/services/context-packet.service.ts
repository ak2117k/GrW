import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { computeGreenFloor, type Segment, type Side } from '../charges';
import type { SentinelVerdictRepository } from '../repositories/sentinel-verdict.repository';
import type { TripwireFire } from '../tripwires/types';
import type { RosterEntry } from './roster.service';

/**
 * Every packet field is either present WITH provenance, or explicitly absent
 * WITH a reason. There is no third state and no silent zero.
 *
 * This matters more for an LLM than for a scoring function: handed a packet
 * where the OI block is quietly missing, the model will not say "I cannot see
 * OI" — it will reason fluently from the eight blocks it can see and sound
 * exactly as confident. Absent evidence must be present as an absence.
 * (Same lesson as commit 34e1268.)
 */
export type Block<T> =
  | { available: true; value: T; source: string; at: string }
  | { available: false; reason: string };

export function absent(reason: string): Block<never> {
  return { available: false, reason };
}

export function present<T>(value: T, source: string, at: string): Block<T> {
  return { available: true, value, source, at };
}

/**
 * Keep the reported floor on the market's side of `ltp`.
 *
 * `computeGreenFloor` rounds one tick conservatively after convergence, so at
 * the exact arming tick the floor can land one tick beyond the current price.
 * Clamping costs at most one paisa of floor precision and removes a whole class
 * of Stage 1 stop-placement bug. Null passes through untouched.
 */
export function clampFloorTowardLtp(
  floorPrice: number | null,
  ltp: number,
  side: Side,
): number | null {
  if (floorPrice === null || !Number.isFinite(floorPrice)) return null;
  // A LONG's floor sits below the market; a SHORT's sits above it.
  return side === 'LONG' ? Math.min(floorPrice, ltp) : Math.max(floorPrice, ltp);
}

export interface TickSnapshot {
  segment: Segment;
  side: Side;
  entryPrice: number;
  qty: number;
  ltp: number;
  /**
   * Price of the UNDERLYING. Equal to `ltp` for cash segments; for OPT/FUT this
   * is the spot while `ltp` is the contract's own price. Null when unresolvable —
   * sensors that compare against levels or OI walls must then stay silent rather
   * than fall back to `ltp` (see the SCALE HAZARD note on TripwireInput).
   */
  underlyingLtp: number | null;
  /** Nearest level from the level book, on the UNDERLYING's scale. */
  nearestSupport: number | null;
  nearestResistance: number | null;
  holdingHigh: number | null;
  holdingLow: number | null;
  entryTime: Date;
  expiry: string | null;
  volumeRatio: number | null;
  freshNewsCount: number | null;
  factorValues: Record<string, number>;
  oiWallNow: { callWall: number | null; putWall: number | null } | null;
  oiWallPrev: { callWall: number | null; putWall: number | null } | null;
}

/**
 * NOTE: `type`, not `interface` — and the same for `ContextPacket` and `Block`.
 * A declared `interface` gets no implicit index signature, so it does NOT assign
 * to `Prisma.InputJsonValue`, and the whole packet is written to a `jsonb`
 * column by SentinelVerdictRepository.record(). Declaring these as interfaces
 * makes Task 11 fail to compile. Verified against the generated client:
 * `type Alias = {x: number}` assigns; `interface Iface {x: number}` does not;
 * neither does `Record<string, unknown>` or a nested hand-written interface.
 */
export type StoredThesis = {
  direction: string;
  reason: string;
  levelPrice: number | null;
  targetPrice: number | null;
  invalidation: number | null;
  source: string;
};

export type ContextPacket = {
  position: {
    symbol: string;
    kind: string;
    segment: Segment;
    side: Side;
    qty: number;
    entryPrice: number;
    entryTime: string;
    expiry: string | null;
  };
  money: {
    grossPnl: number;
    charges: number;
    netPnl: number;
    greenFloorPrice: number | null;
    greenFloorArmed: boolean;
    mfe: number | null;
    mae: number | null;
  };
  thesis: Block<StoredThesis>;
  structure: Block<Prisma.InputJsonValue>;
  flow: {
    volumeRatio: Block<number>;
    oiWalls: Block<Prisma.InputJsonValue>;
  };
  macro: {
    fiiDii: Block<never>;
    sector: Block<never>;
    globalCues: Block<never>;
    realFactors: Block<Record<string, number>>;
  };
  news: Block<Prisma.InputJsonValue>;
  session: { nowIst: string; expiry: string | null };
  trigger: Block<Prisma.InputJsonValue>;
  memory: Block<Prisma.InputJsonValue>;
};

/**
 * Compile-time proof that a packet is storable in the `jsonb` column as-is.
 * If this stops compiling, some field of ContextPacket has been declared as an
 * `interface` (or otherwise lost its implicit index signature) — fix the
 * declaration rather than casting at the call site, because a cast would defer
 * the failure to a runtime Prisma error on the write path.
 */
export function packetAsJson(packet: ContextPacket): Prisma.InputJsonValue {
  return packet;
}

/** How many of this trade's own prior verdicts the agent is shown. */
const PRIOR_VERDICT_LIMIT = 3;

const STUB_REASON =
  'context-scoring factor is a stub (returns isStub: true) — no real data behind it';

/**
 * The evidence sources are injected as NARROW shims, not as the real services.
 * Task 12 supplies the adapters. Keeping them JSON-shaped here is deliberate:
 * whatever comes back is copied verbatim into a `jsonb` column, so a source
 * that cannot produce JSON cannot be an evidence source.
 */
export interface ChartContextShim {
  levelsFor(symbol: string): Promise<Prisma.InputJsonValue | null>;
}

export interface NewsShim {
  recentFor(symbol: string): Promise<Prisma.InputJsonValue[]>;
}

@Injectable()
export class ContextPacketService {
  private readonly logger = new Logger(ContextPacketService.name);

  constructor(
    private readonly verdicts: SentinelVerdictRepository,
    private readonly chartContext: ChartContextShim,
    private readonly news: NewsShim,
  ) {}

  async build(
    entry: RosterEntry,
    tick: TickSnapshot,
    thesis: StoredThesis | null,
    fires: TripwireFire[] = [],
  ): Promise<ContextPacket> {
    const at = new Date().toISOString();

    const floor = computeGreenFloor({
      segment: tick.segment,
      entryPrice: tick.entryPrice,
      ltp: tick.ltp,
      qty: tick.qty,
      side: tick.side,
    });
    const dir = tick.side === 'LONG' ? 1 : -1;
    const grossPnl = (tick.ltp - tick.entryPrice) * tick.qty * dir;

    const structure = await this.safely(
      () => this.chartContext.levelsFor(entry.symbol),
      'chart-context.service',
      at,
      'level book unavailable for this symbol',
    );

    const newsBlock = await this.safely(
      () => this.news.recentFor(entry.symbol),
      'news-aggregator.service',
      at,
      'news aggregator returned nothing for this symbol',
    );

    const priorVerdicts = await this.verdicts.recentForTracker(
      entry.trackerId,
      PRIOR_VERDICT_LIMIT,
    );

    return {
      position: {
        symbol: entry.symbol,
        kind: entry.kind,
        segment: tick.segment,
        side: tick.side,
        qty: tick.qty,
        entryPrice: tick.entryPrice,
        entryTime: tick.entryTime.toISOString(),
        expiry: tick.expiry,
      },
      money: {
        grossPnl,
        charges: floor.charges,
        netPnl: floor.netPnl,
        // Clamped toward ltp. `computeGreenFloor` rounds one tick in the
        // conservative direction after convergence, which means that at the
        // exact arming tick the floor can sit one tick BEYOND the market —
        // above it for a LONG, below for a SHORT. Harmless in Stage 0 (nothing
        // places orders), but a Stage 1 executor placing a stop at floorPrice
        // the instant it arms would emit a stop on the wrong side of the book.
        // Clamp here so that defect never reaches the executor.
        greenFloorPrice: clampFloorTowardLtp(floor.floorPrice, tick.ltp, tick.side),
        greenFloorArmed: floor.armed,
        // Excursions are read from the position's side: a LONG's best case is
        // the high, a SHORT's is the low.
        mfe: tick.side === 'LONG' ? tick.holdingHigh : tick.holdingLow,
        mae: tick.side === 'LONG' ? tick.holdingLow : tick.holdingHigh,
      },
      thesis: thesis
        ? present(thesis, thesis.source === 'USER' ? 'user correction' : 'agent inference', at)
        : absent('no thesis formed yet for this position'),
      structure,
      flow: {
        // `Number.isFinite`, not `!== null`. A NaN or Infinity here would be
        // marked `present` and shipped to the LLM as a real reading — the agent
        // does not crash on "volume NaN x the 20-day average", it reasons
        // confidently from it. Task 6 hardened the sensors the same way; the
        // packet is the second, independent consumer of the same fields.
        volumeRatio: Number.isFinite(tick.volumeRatio as number)
          ? present(tick.volumeRatio as number, 'market-data', at)
          : absent('session volume vs average not available or not a finite reading'),
        oiWalls:
          tick.oiWallNow === null
            ? absent('no options chain for this symbol, so no OI walls')
            : present({ now: tick.oiWallNow, previous: tick.oiWallPrev }, 'oi-wall.service', at),
      },
      macro: {
        fiiDii: absent(
          `${STUB_REASON}. Note FII/DII is published post-close and can never be an intraday trigger.`,
        ),
        sector: absent(STUB_REASON),
        globalCues: absent(`${STUB_REASON} (gold, crude-oil, nasdaq)`),
        realFactors:
          Object.keys(tick.factorValues).length > 0
            ? present(tick.factorValues, 'context-scoring (greeks, mtfTrend, volatility only)', at)
            : absent('no real context factors computed for this symbol'),
      },
      news: newsBlock,
      session: { nowIst: at, expiry: tick.expiry },
      // Re-built as plain object literals rather than passed through: `TripwireFire`
      // and `SentinelVerdict` are declared types without an implicit index
      // signature, so neither array assigns to `Prisma.InputJsonValue` — and the
      // packet has to survive the write to the jsonb column.
      trigger:
        fires.length > 0
          ? present(
              fires.map((f) => ({ name: f.name, detail: f.detail })),
              'tripwire.service',
              at,
            )
          : present(
              [{ name: 'heartbeat', detail: 'no sensor fired; scheduled review' }],
              'tripwire.service',
              at,
            ),
      memory:
        priorVerdicts.length > 0
          ? present(
              priorVerdicts.map((v) => ({
                verdict: v.verdict,
                reason: v.reason,
                at: v.createdAt.toISOString(),
              })),
              'sentinel-verdict.repository',
              at,
            )
          : absent('no prior verdicts for this position — this is the first look'),
    };
  }

  /**
   * A source that throws must become a stated absence, never an exception that
   * kills the whole evaluation and never a silently empty block.
   */
  private async safely(
    fn: () => Promise<Prisma.InputJsonValue | null | undefined>,
    source: string,
    at: string,
    fallbackReason: string,
  ): Promise<Block<Prisma.InputJsonValue>> {
    try {
      const value = await fn();
      if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
        return absent(fallbackReason);
      }
      return present(value, source, at);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${source} failed while building packet: ${message}`);
      return absent(`${source} failed: ${message}`);
    }
  }
}
