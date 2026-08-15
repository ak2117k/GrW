import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { computeGreenFloor, type Segment, type Side } from '../charges';
// A VALUE import, deliberately. `import type` is erased, so
// `design:paramtypes` would emit `Object` for this parameter and Nest could not
// resolve it by type — the class has to survive to runtime to be its own token.
import { SentinelVerdictRepository } from '../repositories/sentinel-verdict.repository';
import type { TripwireFire } from '../tripwires/types';
import type { Ownership, RosterEntry } from './roster.service';

/**
 * Every packet field is either present WITH provenance, or explicitly absent
 * WITH a reason. There is no third state and no silent zero.
 *
 * This matters more for an LLM than for a scoring function: handed a packet
 * where the OI block is quietly missing, the model will not say "I cannot see
 * OI" — it will reason fluently from the eight blocks it can see and sound
 * exactly as confident. Absent evidence must be present as an absence.
 * (Same lesson as commit 34e1268.)
 *
 * The corollary bites just as hard in the other direction: a field that is
 * present but WRONG is worse than one that is missing, because it arrives with
 * provenance attached and is persisted verbatim for replay. See
 * `clampFloorTowardLtp` for the case that taught us that here.
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
 * A finite number, or a stated absence. Every numeric block in the packet goes
 * through here: `Number.isFinite`, never `!== null`. A NaN marked `present`
 * reaches the agent as a real reading — it does not crash on "volume NaN x the
 * 20-day average", it reasons confidently from it. Task 6 hardened the sensors
 * the same way; the packet is the second, independent consumer of the same
 * fields.
 */
function numberBlock(
  value: number | null | undefined,
  source: string,
  at: string,
  reason: string,
): Block<number> {
  return Number.isFinite(value as number) ? present(value as number, source, at) : absent(reason);
}

/**
 * The widest gap between the solved floor and `ltp` that can be a rounding
 * artifact rather than real distance: two ticks of ₹0.01. See
 * {@link clampFloorTowardLtp}.
 */
export const FLOOR_CLAMP_TOLERANCE_RUPEES = 0.02;

/**
 * Repair the one-tick rounding artifact in the floor — and NOTHING else.
 *
 * `computeGreenFloor` returns a `floorPrice` for every position with qty != 0.
 * It is a TARGET while the trade is unarmed and a PROTECTIVE LEVEL once armed,
 * and the same number serves both roles. The only defect worth repairing here is
 * the conservative one-tick rounding applied after convergence: at the arming
 * tick that can leave the floor a single tick on the wrong side of the market —
 * above `ltp` for a LONG, below it for a SHORT — which a Stage 1 executor would
 * turn into a stop on the wrong side of the book.
 *
 * Clamping unconditionally is far worse than not clamping at all. A LONG at
 * entry 100, qty 100, ltp 90 is ₹1050 underwater and its floor is ₹102.01; an
 * unscoped clamp reports `greenFloorPrice: 90` next to `netPnl: -1050`, and the
 * agent reads "I am sitting exactly on my protected floor" when it is ₹12 away.
 * That lie carries provenance and is persisted, so it replays identically
 * forever. Hence the tolerance: only a gap small enough to BE the rounding
 * artifact is closed. Anything larger is real distance and is reported as it is.
 *
 * Gating on `armed` instead would not be enough — a latched-armed position that
 * has pulled back to 100.50 with a floor at 102.01 is genuinely ₹1.51 below its
 * floor, and that gap is the whole signal.
 */
export function clampFloorTowardLtp(
  floorPrice: number | null,
  ltp: number,
  side: Side,
): number | null {
  if (floorPrice === null || !Number.isFinite(floorPrice)) return null;
  // A LONG's floor sits below the market; a SHORT's sits above it.
  const onWrongSide = side === 'LONG' ? floorPrice > ltp : floorPrice < ltp;
  if (!onWrongSide) return floorPrice;
  if (Math.abs(floorPrice - ltp) > FLOOR_CLAMP_TOLERANCE_RUPEES) return floorPrice;
  return ltp;
}

/** IST is UTC + 5:30. Same convention as `common/utils/market-hours.ts`. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** NSE regular session ends 15:30 IST — minutes since IST midnight. */
export const SESSION_CLOSE_MIN = 15 * 60 + 30;

/**
 * IST wall-clock time as 'YYYY-MM-DD HH:mm:ss IST'.
 *
 * The packet's clock field is named `nowIst` and must therefore BE IST. A UTC
 * instant under that label invites the agent to be wrong about the close by five
 * and a half hours — exactly the confident-from-bad-evidence failure the packet
 * exists to prevent. Same `Asia/Kolkata` formatter as
 * `TradeTrackerService.istDateString`, extended to the time of day.
 */
export function istWallClock(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')} IST`;
}

/**
 * Minutes remaining in the IST session, as a block.
 *
 * Derived here rather than left to the agent: "how long have I got" is the
 * quantity every prompt actually wants, and computing it from a timestamp is
 * timezone arithmetic an LLM should never be asked to perform.
 */
export function minutesToSessionClose(now: Date): Block<number> {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) {
    return absent('not a trading day (IST weekend) — no session close to count down to');
  }
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minutes >= SESSION_CLOSE_MIN) {
    return absent('the IST session has already closed (15:30) — nothing left to run today');
  }
  return present(
    SESSION_CLOSE_MIN - minutes,
    'derived from IST wall clock (15:30 close; NSE trading holidays are NOT modelled)',
    now.toISOString(),
  );
}

export interface TickSnapshot {
  segment: Segment;
  side: Side;
  /**
   * The symbol the LEVEL BOOK and the NEWS FEED are keyed by — which for a
   * derivative is NOT the tradingsymbol, and null when it cannot be resolved.
   *
   * Carried on the tick rather than derived here, and that placement is the
   * point. `entry.symbol` is the broker's tradingsymbol and deliberately stays
   * that way, because a verdict row spelling a symbol the broker never used
   * would be unjoinable against the tracker it came from. But
   * `NIFTY28AUG2524000CE` matches nothing in the instrument master (which holds
   * cash equities) and nothing in `relatedSymbols` (which holds base symbols),
   * so using it here makes the level-book and headline blocks permanently
   * absent for every derivative — silently, and in the packet the agent
   * actually reads.
   *
   * The tick source resolves the underlying once per contract and puts the
   * answer here. Resolving it a second time in this service would duplicate the
   * derivative logic and let the two paths drift apart — which is exactly how
   * the tripwire path came to be fixed while this one was not.
   *
   * NULL MEANS DO NOT ASK. It is never a licence to fall back to the
   * tradingsymbol: that call is guaranteed to miss, and a miss is reported as
   * "no level book for this symbol", which reads as a fact about the market
   * rather than a failure to look.
   */
  structureSymbol: string | null;
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
  /**
   * When the OI walls above were actually READ, as an ISO string, or null to
   * fall back to the packet's build time.
   *
   * Walls are captured on their own cadence rather than per tick (see
   * `OI_CAPTURE_INTERVAL_MS`), so this pair can be up to a minute older than
   * every other block in the packet. Stamping it with the build time would put
   * a wrong `at` on a block whose whole contract is "present WITH provenance",
   * and the prompt teaches the model to read `at` — so the one block that is not
   * from this instant has to say so.
   */
  oiWallsAt: string | null;
  /**
   * Whether the green floor has EVER armed for this position.
   *
   * `charges.ts` states that `computeGreenFloor.armed` is computed from the
   * current ltp only and that the caller owns the ratchet — and this service is
   * that caller. It is legitimately stateless, so the latch is passed in: Task
   * 12's cycle state owns and persists it. Without this the agent watches the
   * floor un-arm on every pullback, which contradicts the whole promise the
   * floor makes.
   */
  greenFloorArmedLatched: boolean;
}

/**
 * NOTE: `type`, not `interface` — and the same for `ContextPacket` and `Block`.
 * A declared `interface` gets no implicit index signature, so it does NOT assign
 * to `Prisma.InputJsonValue`, and the whole packet is written to a `jsonb`
 * column by SentinelVerdictRepository.record(). Declaring these as interfaces
 * makes Task 11 fail to compile. Verified against the generated client:
 * `type Alias = {x: number}` assigns; `interface Iface {x: number}` does not;
 * neither does `Record<string, unknown>` or a nested hand-written interface.
 * `packetAsJson` below turns a regression into a compile error at this file.
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
    /**
     * Whether the sentinel would ever be permitted to act on this trade.
     *
     * `OBSERVE_ONLY` covers holdings (which the roster says are "observed, never
     * closed") and positions another engine already manages. Such trades ARE
     * still evaluated and their verdicts ARE still recorded — a Stage 0 shadow
     * whose whole purpose is measuring judgement quality should not throw away
     * judgements — but the verdict has to be attributable, for two reasons:
     * Task 13's accuracy scoring must be able to separate verdicts the sentinel
     * could have acted on from ones it never could, and a Stage 1 reader wiring
     * an executor must key off THIS field and not off `watched`.
     */
    ownership: Ownership;
    segment: Segment;
    side: Side;
    qty: number;
    entryPrice: number;
    /**
     * The contract's OWN current price — the premium for an option. Carried
     * explicitly: it is the single most important number in the packet, and
     * making the agent back it out of grossPnl/qty/direction is how a floor that
     * has collapsed onto the market goes unnoticed.
     */
    ltp: number;
    /** SCALE HAZARD: levels and OI walls are on THIS scale, `ltp` is not. */
    underlyingLtp: Block<number>;
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
  structure: {
    levelBook: Block<Prisma.InputJsonValue>;
    nearestSupport: Block<number>;
    nearestResistance: Block<number>;
  };
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
  news: {
    headlines: Block<Prisma.InputJsonValue>;
    /** Headlines in the last 30 minutes — the recency signal the list lacks. */
    freshCount: Block<number>;
  };
  session: {
    nowIst: string;
    nowUtc: string;
    minutesToClose: Block<number>;
    expiry: string | null;
  };
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

/**
 * Why the level book and the headlines are missing when the underlying could
 * not be resolved.
 *
 * Deliberately NOT the wording used when a source was asked and came back with
 * nothing. "No level book for this symbol" is a claim about the market; this is
 * a claim about us. An LLM told the first will reason confidently about an
 * instrument with no structure — which is a completely different trade from one
 * whose structure we simply failed to fetch.
 */
const UNRESOLVED_UNDERLYING_REASON =
  'the underlying behind this contract could not be resolved, so the level book and the ' +
  'headlines were never looked up. This is a FAILURE TO LOOK, not a finding: do not read it ' +
  'as an instrument with no structure or no news.';

const STUB_REASON =
  'context-scoring factor is a stub (returns isStub: true) — no real data behind it';

/**
 * What an evidence shim returns: the value AND its own provenance.
 *
 * The source must come from the shim, not from a constant here. A level book
 * depends entirely on the interval it was built from, which this service never
 * names — without this, two packets both reading `source: 'chart-context.service'`
 * could carry a 5-minute and a daily level book and nothing would distinguish
 * them. `at` is optional and should be the moment the DATA was captured, not the
 * moment the packet was built; the packet's own build time is the fallback.
 */
export type SourcedValue = {
  value: Prisma.InputJsonValue | null;
  source: string;
  at?: string;
};

/**
 * The evidence sources are injected as NARROW shims, not as the real services.
 * Task 12 supplies the adapters. Keeping them JSON-shaped is deliberate:
 * whatever comes back is copied verbatim into a `jsonb` column, so a source that
 * cannot produce JSON cannot be an evidence source.
 */
export interface ChartContextShim {
  levelsFor(symbol: string): Promise<SourcedValue | null>;
}

export interface NewsShim {
  recentFor(symbol: string): Promise<SourcedValue | null>;
}

/**
 * DI tokens for the two shims. Both are interfaces, so `design:paramtypes`
 * emits `Object` and Nest cannot resolve them by type — the same reason
 * `OPEN_POSITIONS`, `OI_WALL_SOURCE` and `TICK_SOURCE` exist.
 */
export const CHART_CONTEXT_SHIM = 'SENTINEL_CHART_CONTEXT_SHIM';
export const NEWS_SHIM = 'SENTINEL_NEWS_SHIM';

@Injectable()
export class ContextPacketService {
  private readonly logger = new Logger(ContextPacketService.name);

  constructor(
    private readonly verdicts: SentinelVerdictRepository,
    @Inject(CHART_CONTEXT_SHIM) private readonly chartContext: ChartContextShim,
    @Inject(NEWS_SHIM) private readonly news: NewsShim,
  ) {}

  async build(
    entry: RosterEntry,
    tick: TickSnapshot,
    thesis: StoredThesis | null,
    fires: TripwireFire[] = [],
  ): Promise<ContextPacket> {
    const now = new Date();
    const at = now.toISOString();

    const floor = computeGreenFloor({
      segment: tick.segment,
      entryPrice: tick.entryPrice,
      ltp: tick.ltp,
      qty: tick.qty,
      side: tick.side,
    });
    const dir = tick.side === 'LONG' ? 1 : -1;
    const grossPnl = (tick.ltp - tick.entryPrice) * tick.qty * dir;

    /**
     * THE EVIDENCE SOURCES ARE KEYED BY THE UNDERLYING, NOT BY THE CONTRACT.
     *
     * `entry.symbol` is the broker's tradingsymbol and is used everywhere else
     * in this packet, correctly — `position.symbol` has to stay joinable to the
     * tracker the verdict came from. But the level book is looked up in the
     * instrument master (cash equities) and the headlines in `relatedSymbols`
     * (base symbols), so `NIFTY28AUG2524000CE` matches NEITHER. Passing it here
     * makes both blocks permanently absent for every derivative — in the packet
     * the agent actually reads, which is the corpus Task 13 scores.
     *
     * `tick.structureSymbol` is the tick source's single resolution of that
     * question, carried through rather than recomputed. See its doc comment.
     */
    const structureSymbol = tick.structureSymbol;

    const [levelBook, headlines] = structureSymbol
      ? await Promise.all([
          this.safely(
            () => this.chartContext.levelsFor(structureSymbol),
            'chart-context.service',
            at,
            'level book unavailable for this symbol',
          ),
          this.safely(
            () => this.news.recentFor(structureSymbol),
            'news-aggregator.service',
            at,
            'news aggregator returned nothing for this symbol',
          ),
        ])
      : // NO FALLBACK TO THE TRADINGSYMBOL. That call is guaranteed to miss, and
        // `safely` would report the miss as "level book unavailable for this
        // symbol" — which reads as a FACT ABOUT THE MARKET (this instrument has
        // no levels) when the truth is that we never managed to look. The
        // distinction is the whole discipline of this packet: absent WITH a
        // reason, and the reason has to be the real one.
        [absent(UNRESOLVED_UNDERLYING_REASON), absent(UNRESOLVED_UNDERLYING_REASON)];

    const priorVerdicts = await this.verdicts.recentForTracker(
      entry.trackerId,
      PRIOR_VERDICT_LIMIT,
    );

    return {
      position: {
        symbol: entry.symbol,
        kind: entry.kind,
        ownership: entry.ownership,
        segment: tick.segment,
        side: tick.side,
        qty: tick.qty,
        entryPrice: tick.entryPrice,
        ltp: tick.ltp,
        underlyingLtp: numberBlock(
          tick.underlyingLtp,
          'market-data (underlying spot)',
          at,
          "the underlying's price could not be resolved — levels and OI walls below " +
            'are on the underlying scale and CANNOT be compared against ltp',
        ),
        entryTime: tick.entryTime.toISOString(),
        expiry: tick.expiry,
      },
      money: {
        grossPnl,
        charges: floor.charges,
        netPnl: floor.netPnl,
        // Only the one-tick rounding artifact is repaired — see
        // clampFloorTowardLtp for why an unconditional clamp makes the packet
        // lie about a losing position.
        greenFloorPrice: clampFloorTowardLtp(floor.floorPrice, tick.ltp, tick.side),
        // The latch wins: `floor.armed` is a snapshot of the CURRENT ltp, and a
        // floor that un-arms on a pullback is not a floor.
        greenFloorArmed: tick.greenFloorArmedLatched || floor.armed,
        // Excursions are read from the position's side: a LONG's best case is
        // the high, a SHORT's is the low. Both are PRICES, not rupee figures.
        mfe: tick.side === 'LONG' ? tick.holdingHigh : tick.holdingLow,
        mae: tick.side === 'LONG' ? tick.holdingLow : tick.holdingHigh,
      },
      // Copied field-by-field rather than passed by reference: the packet is
      // persisted verbatim as the evidence the agent saw, so a later mutation of
      // the caller's thesis object must not retroactively rewrite the record.
      thesis: thesis
        ? present(
            {
              direction: thesis.direction,
              reason: thesis.reason,
              levelPrice: thesis.levelPrice,
              targetPrice: thesis.targetPrice,
              invalidation: thesis.invalidation,
              source: thesis.source,
            },
            thesis.source === 'USER' ? 'user correction' : 'agent inference',
            at,
          )
        : absent('no thesis formed yet for this position'),
      structure: {
        levelBook,
        nearestSupport: numberBlock(
          tick.nearestSupport,
          'level book (underlying scale)',
          at,
          'no support level below this price in the level book',
        ),
        nearestResistance: numberBlock(
          tick.nearestResistance,
          'level book (underlying scale)',
          at,
          'no resistance level above this price in the level book',
        ),
      },
      flow: {
        volumeRatio: numberBlock(
          tick.volumeRatio,
          'market-data',
          at,
          'session volume vs average not available or not a finite reading',
        ),
        oiWalls:
          tick.oiWallNow === null
            ? absent('no options chain for this symbol, so no OI walls')
            : present(
                { now: tick.oiWallNow, previous: tick.oiWallPrev },
                'oi-wall.service',
                // The capture time, NOT the packet build time — these walls are
                // read on their own cadence and can be up to a minute old.
                tick.oiWallsAt ?? at,
              ),
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
      news: {
        headlines,
        freshCount: numberBlock(
          tick.freshNewsCount,
          'news-aggregator.service (headlines in the last 30 minutes)',
          at,
          'no 30-minute headline count available for this symbol',
        ),
      },
      session: {
        nowIst: istWallClock(now),
        nowUtc: at,
        minutesToClose: minutesToSessionClose(now),
        expiry: tick.expiry,
      },
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
   * kills the whole evaluation and never a silently empty block. Provenance is
   * taken from the shim when it supplies it — `label` and `at` are only the
   * fallbacks for a shim that does not know its own.
   */
  private async safely(
    fn: () => Promise<SourcedValue | null | undefined>,
    label: string,
    at: string,
    fallbackReason: string,
  ): Promise<Block<Prisma.InputJsonValue>> {
    try {
      const result = await fn();
      const value = result?.value;
      if (
        result === null ||
        result === undefined ||
        value === null ||
        value === undefined ||
        (Array.isArray(value) && value.length === 0)
      ) {
        return absent(fallbackReason);
      }
      return present(value, result.source || label, result.at ?? at);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${label} failed while building packet: ${message}`);
      return absent(`${label} failed: ${message}`);
    }
  }
}
