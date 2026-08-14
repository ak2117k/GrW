import { Injectable, Logger } from '@nestjs/common';
import { TradeTrackerService } from '../../trade-tracker/services/trade-tracker.service';

/** Hard cap on concurrently watched positions (spec §2). */
export const SENTINEL_MAX_WATCHED = 5;

export type Ownership = 'SENTINEL' | 'OBSERVE_ONLY';

export interface RosterEntry {
  trackerId: string;
  symbol: string;
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
 * Stage 0 defines only the interface — Task 12 supplies the concrete probe.
 */
export interface EngineOwnershipProbe {
  symbolsOwnedByOtherEngines(userId: string): Promise<Set<string>>;
}

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
    private readonly trackers: TradeTrackerService,
    private readonly ownership: EngineOwnershipProbe,
  ) {}

  async build(userId: string): Promise<RosterEntry[]> {
    const open = await this.trackers.listOpen(userId);
    const ownedElsewhere =
      await this.ownership.symbolsOwnedByOtherEngines(userId);

    // Slot allocation is decided HERE, not by listOpen's orderBy — see
    // byWatchPriority for the policy and why it is stated in this module.
    const ordered = [...open].sort(byWatchPriority);

    let watchedCount = 0;
    const roster = ordered.map((t): RosterEntry => {
      const watched = watchedCount < SENTINEL_MAX_WATCHED;
      if (watched) watchedCount += 1;

      if (t.kind === 'HOLDING') {
        return {
          trackerId: t.id,
          symbol: t.symbol,
          kind: 'HOLDING',
          ownership: 'OBSERVE_ONLY',
          watched,
          reason: watched
            ? 'holding — observed, never closed'
            : OVER_CAPACITY_REASON,
        };
      }

      if (ownedElsewhere.has(t.symbol)) {
        return {
          trackerId: t.id,
          symbol: t.symbol,
          kind: 'POSITION',
          ownership: 'OBSERVE_ONLY',
          watched,
          reason: watched
            ? 'managed by another engine — observed only'
            : OVER_CAPACITY_REASON,
        };
      }

      return {
        trackerId: t.id,
        symbol: t.symbol,
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
