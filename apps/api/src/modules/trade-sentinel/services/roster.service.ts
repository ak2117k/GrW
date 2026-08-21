import { Inject, Injectable, Logger } from '@nestjs/common';
import { OPEN_POSITIONS, type OpenPositionsPort } from '../ports/open-positions.port';
// From `charges.ts`, NOT from the tick source that also exports `segmentFor`:
// that adapter imports `UserFeedManager` and reaches the broker, and the cycle
// imports this file. See the note on `segmentFor` for why it was moved.
import { isDerivativeSegment, segmentFor } from '../charges';
import { normaliseSymbol } from '../symbols';

/** Hard cap on concurrently watched positions (spec §2). */
export const SENTINEL_MAX_WATCHED = 5;

export type Ownership = 'SENTINEL' | 'OBSERVE_ONLY';

export interface RosterEntry {
  /**
   * The tenant this trade belongs to.
   *
   * Carried on the entry rather than passed alongside it: everything downstream
   * (the thesis row, the verdict row) is tenant-scoped, and a userId travelling
   * as a separate argument is a userId that can be forgotten at one call site or
   * paired with the wrong entry at another. `build()` already has it.
   */
  userId: string;
  trackerId: string;
  symbol: string;
  /**
   * Where this trade actually trades — 'NSE', 'NFO', 'MCX', 'BFO'.
   *
   * Carried so the packet counts down to THIS position's own session close
   * rather than a hardcoded 15:30. MCX runs to 23:30, and a commodity contract
   * told at 16:00 that "the session has already closed, nothing left to run
   * today" was being handed a false deadline — with provenance attached, at
   * exactly the hours when crude and gold move most.
   */
  exchange: string;
  kind: 'POSITION' | 'HOLDING';
  ownership: Ownership;
  watched: boolean;
  reason: string;
}

/**
 * Resolves the ownership question the spec's §11 raises: `watch-monitor` and the
 * `*-track` modules already close trades they own, so a position they manage is
 * observed but never claimed. One owner per trade.
 *
 * THE RETURNED SET IS NORMALISED — every member must have been through
 * {@link normaliseSymbol}, because that is what `build()` compares against. The
 * two sides spell symbols differently (broker `tradingsymbol` here, base symbol
 * there) and an un-normalised set fails OPEN: no match, so the sentinel CLAIMS a
 * position another engine is managing. See `symbols.ts` for the full argument.
 */
export interface EngineOwnershipProbe {
  symbolsOwnedByOtherEngines(userId: string): Promise<Set<string>>;
}

/**
 * DI token for {@link EngineOwnershipProbe}. It is an interface, so
 * `design:paramtypes` emits `Object` and Nest cannot resolve the parameter by
 * type — the same reason `OPEN_POSITIONS` and `TICK_SOURCE` exist.
 */
export const ENGINE_OWNERSHIP_PROBE = 'SENTINEL_ENGINE_OWNERSHIP_PROBE';

/** Why an entry is not watched. Never dropped silently — the reason is recorded. */
const OVER_CAPACITY_REASON = `over capacity: more than ${SENTINEL_MAX_WATCHED} open, not watched`;

/** Entry timestamp in ms, or `null` when the row carries no usable one. */
function entryMillis(t: { entryTime?: Date | string | null }): number | null {
  const raw = t.entryTime;
  if (raw === null || raw === undefined) return null;
  const ms = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Which open trades get the {@link SENTINEL_MAX_WATCHED} watch slots. This is a
 * TRADING POLICY and it lives here deliberately — it must not be inherited from
 * whatever `orderBy` the repository happens to use, because changing a query's
 * sort for an unrelated reason would then silently change which of a user's
 * trades goes unmonitored.
 *
 * 1. Positions before holdings. Only a position can ever gain close authority,
 *    so a position must never lose a slot to an instrument the sentinel could
 *    not act on even if every sensor fired.
 * 2. Within a kind, OLDEST `entryTime` first. The tie-break is for churn
 *    resistance: newest-first would reshuffle the watched set on every new
 *    fill, and a position dropped mid-observation loses its tripwire history
 *    (peak, giveback, last-verdict clock) — continuity is worth more here than
 *    recency. Rows with no usable `entryTime` compare equal, so the store's own
 *    order is preserved rather than an arbitrary one invented.
 *
 * Stage 0 fixes this policy; whether it should instead rank by capital at risk
 * is a trading decision, not a code cleanup.
 */
function byWatchPriority(
  a: { kind: string; entryTime?: Date | string | null },
  b: { kind: string; entryTime?: Date | string | null },
): number {
  if (a.kind !== b.kind) return a.kind === 'POSITION' ? -1 : 1;
  const aMs = entryMillis(a);
  const bMs = entryMillis(b);
  if (aMs === null || bMs === null) return 0;
  return aMs - bMs;
}

@Injectable()
export class RosterService {
  private readonly logger = new Logger(RosterService.name);

  constructor(
    // A narrow READ-ONLY port, not TradeTrackerService: that service holds the
    // Angel One adapter, which would put placeOrder one property access away
    // from a live cycle. See the note on OpenPositionsPort.
    @Inject(OPEN_POSITIONS) private readonly trackers: OpenPositionsPort,
    @Inject(ENGINE_OWNERSHIP_PROBE) private readonly ownership: EngineOwnershipProbe,
  ) {}

  async build(userId: string): Promise<RosterEntry[]> {
    const open = await this.trackers.listOpen(userId);
    // Re-normalised HERE as well as in the probe, rather than trusted.
    //
    // The probe's contract says its set is already normalised, and the shipped
    // adapter honours it — but the contract is a comment and a probe is exactly
    // the kind of thing that gets a second implementation. Normalising only our
    // OWN side makes the guarantee ONE-DIRECTIONAL: a probe returning
    // `SUZLON-EQ` against a tracker holding `SUZLON` silently never matches,
    // and this failure FAILS OPEN — no match means the sentinel CLAIMS a
    // position another engine is managing. `normaliseSymbol` is idempotent, so
    // the cost of making it symmetric is one pass over at most a handful of
    // strings.
    const ownedElsewhere = new Set(
      [...(await this.ownership.symbolsOwnedByOtherEngines(userId))].map(normaliseSymbol),
    );

    // F&O POSITIONS ONLY. Two filters, and they exclude different things for
    // different reasons — neither subsumes the other.
    //
    // (1) NOT HOLDINGS. The original design had them OBSERVE_ONLY: watched and
    // explained but never closed. In practice that inverted the feature. A real
    // book carries a handful of positions and DOZENS of holdings (52 open trades
    // here: 4 positions, 48 holdings), and since holdings sort no differently
    // once the cap binds, the five watch slots filled with long-term equity the
    // user was not asking about while the option positions they actually opened
    // today went UNWATCHED. The cap is 5 because five is what the agent can
    // reason about well; spending it on the wrong five is worse than spending it
    // on none.
    //
    // (2) NOT CASH EQUITY. The sentinel's remit is derivatives — OPT and FUT.
    // This is a deliberate scope decision, not an optimisation, and it is the
    // one the instrument actually justifies: an option decays, expires on a
    // fixed date, and can lose its entire premium in a session, so "should I
    // still be holding this?" is a question with a deadline attached. A cash
    // equity has no expiry and no theta; the same question there is a portfolio
    // decision on a horizon of weeks, which a 30-second poll is the wrong shape
    // for and which the user has not asked the agent to make.
    //
    // The consequence is stated rather than hidden: a book of nothing but cash
    // positions produces an EMPTY roster, and the cycle correctly reports having
    // watched nothing. That is the intended behaviour, not a silent failure —
    // the alternative is spending agent calls and the user's money judging
    // trades the sentinel was never meant to have an opinion about.
    const positions = open.filter(
      (t) => t.kind !== 'HOLDING' && isDerivativeSegment(segmentFor(t)),
    );

    // Slot allocation is decided HERE, not by listOpen's orderBy — see
    // byWatchPriority for the policy and why it is stated in this module.
    const ordered = [...positions].sort(byWatchPriority);

    let watchedCount = 0;
    const roster = ordered.map((t): RosterEntry => {
      const watched = watchedCount < SENTINEL_MAX_WATCHED;
      if (watched) watchedCount += 1;

      // Holdings were filtered out above and cannot reach here. The guard stays
      // anyway: if that filter is ever loosened, the fall-through below would
      // classify a holding as a claimable POSITION and hand the sentinel exit
      // authority over long-term equity. That failure is silent and it fails
      // OPEN, which is the one direction this module never permits.
      if (t.kind === 'HOLDING') {
        return {
          userId,
          trackerId: t.id,
          symbol: t.symbol,
          exchange: t.exchange,
          kind: 'HOLDING',
          ownership: 'OBSERVE_ONLY',
          watched: false,
          reason: 'holding — outside the sentinel’s remit, never watched',
        };
      }

      // Normalised on BOTH sides, both of them here — see the note on the set's
      // construction above. A raw compare silently never matches
      // (`SUZLON-EQ` vs `SUZLON`) and the sentinel then claims a position
      // another engine manages. See symbols.ts.
      if (ownedElsewhere.has(normaliseSymbol(t.symbol))) {
        return {
          userId,
          trackerId: t.id,
          symbol: t.symbol,
          exchange: t.exchange,
          kind: 'POSITION',
          ownership: 'OBSERVE_ONLY',
          watched,
          reason: watched
            ? 'managed by another engine — observed only'
            : OVER_CAPACITY_REASON,
        };
      }

      return {
        userId,
        trackerId: t.id,
        symbol: t.symbol,
        exchange: t.exchange,
        kind: 'POSITION',
        ownership: 'SENTINEL',
        watched,
        reason: watched
          ? 'unowned position — sentinel claims it'
          : OVER_CAPACITY_REASON,
      };
    });

    const skipped = roster.length - watchedCount;
    if (skipped > 0) {
      this.logger.warn(
        `[roster] user ${userId}: ${roster.length} open trades exceeds the cap of ` +
          `${SENTINEL_MAX_WATCHED}; ${skipped} listed UNWATCHED: ` +
          roster
            .filter((r) => !r.watched)
            .map((r) => r.symbol)
            .join(', '),
      );
    }

    return roster;
  }
}
