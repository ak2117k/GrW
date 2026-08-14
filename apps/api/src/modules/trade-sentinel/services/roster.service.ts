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

    // Positions before holdings: only positions can ever gain close authority,
    // so they get first claim on the five watch slots.
    const ordered = [...open].sort((a, b) =>
      a.kind === b.kind ? 0 : a.kind === 'POSITION' ? -1 : 1,
    );

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
