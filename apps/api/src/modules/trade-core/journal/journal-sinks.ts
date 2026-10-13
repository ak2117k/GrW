import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { istDate } from '../execution/ledger-math';
import type { LifecycleEventSink } from '../lifecycle/lifecycle-events';
import type { LifecycleEvent } from '../lifecycle/lifecycle.types';
import type { RiskVerdictSink } from '../risk-wall/ports';
import type { RiskVerdict } from '../risk-wall/risk-wall.types';
import { CORE_JOURNAL, CORE_POSITION_CLOSED, type CoreJournalPort, type PositionClosedListener } from './journal-ports';
import type { JournalEntry } from './journal.types';

/** Ruling J15: at most one trailing STOP_MOVED row per position in this window. */
export const STOP_MOVED_COALESCE_MS = 30_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function lifecycleEntry(e: LifecycleEvent): JournalEntry {
  return {
    type: e.type,
    userId: e.userId,
    at: e.at,
    positionId: e.positionId,
    strategyVersionId: e.strategyVersionId,
    payload: e.payload,
    priceUsed: e.priceUsed,
    priceAgeMs: e.priceAgeMs,
  };
}

/** A rule-driven trailing move (breakeven / ATR trail / re-arm), not a guard-rail proposal. */
const isTrailMove = (e: LifecycleEvent): boolean => e.type === 'STOP_MOVED' && e.payload.why !== 'GUARD_RAIL' && e.payload.source === undefined;

/**
 * M4 ruling L12 rebound to core_journal. The lifecycle calls record() without awaiting it and
 * logs a rejection, so nothing here can delay a decision. A close (POSITION_STATE → CLOSED) is
 * handed to the summary writer (J16), whose failure is logged; the reconciler repairs it.
 */
@Injectable()
export class JournalLifecycleSink implements LifecycleEventSink {
  private readonly logger = new Logger(JournalLifecycleSink.name);
  private readonly lastStopAt = new Map<string, number>();
  private readonly heldStop = new Map<string, LifecycleEvent>();

  constructor(
    @Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort,
    @Optional() @Inject(CORE_POSITION_CLOSED) private readonly closed?: PositionClosedListener,
  ) {}

  async record(e: LifecycleEvent): Promise<void> {
    if (isTrailMove(e)) {
      const last = this.lastStopAt.get(e.positionId);
      if (last !== undefined && e.at.getTime() - last < STOP_MOVED_COALESCE_MS) {
        this.heldStop.set(e.positionId, e);
        return;
      }
      this.heldStop.delete(e.positionId);
      this.lastStopAt.set(e.positionId, e.at.getTime());
    } else {
      this.flushHeld(e.positionId);
    }
    this.journal.record(lifecycleEntry(e));

    const to = e.type === 'POSITION_STATE' ? e.payload.to : null;
    if (to === 'CLOSED' || to === 'CANCELLED') {
      this.lastStopAt.delete(e.positionId);
      this.heldStop.delete(e.positionId);
    }
    if (to === 'CLOSED' && this.closed) {
      try {
        await this.closed.positionClosed(e.userId, e.positionId);
      } catch (err) {
        this.logger.error(`summary for closed position ${e.positionId} not written (the reconciler repairs it): ${errorText(err)}`);
      }
    }
  }

  private flushHeld(positionId: string): void {
    const held = this.heldStop.get(positionId);
    if (!held) return;
    this.heldStop.delete(positionId);
    this.lastStopAt.set(positionId, held.at.getTime());
    this.journal.record(lifecycleEntry(held));
  }
}

/**
 * M2's RISK_VERDICT_SINK rebound to core_journal (J10): awaited, so a verdict that cannot be
 * recorded rejects the entry (RiskWallService maps it to JOURNAL_UNAVAILABLE) while an exit
 * verdict's failure is only logged there. A DAILY_LOSS rejection latches the IST day (J13).
 */
@Injectable()
export class JournalRiskVerdictSink implements RiskVerdictSink {
  constructor(@Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort) {}

  async record(v: RiskVerdict): Promise<void> {
    const at = new Date(v.checkedAt);
    const row: JournalEntry = { type: 'RISK_VERDICT', userId: v.userId, at, intentId: v.intentId, payload: v as unknown as Record<string, unknown> };
    // An exit is never blocked or delayed (Global Constraints): its verdict row goes through the
    // buffered, non-throwing path instead of an awaited write the wall would wait on.
    if (v.intentKind === 'EXIT') this.journal.record(row);
    else await this.journal.recordNow(row);
    if (v.reasons.some((r) => r.code === 'DAILY_LOSS')) {
      const day = istDate(at);
      this.journal.record({
        type: 'DAILY_LOSS_LATCHED',
        userId: v.userId,
        at,
        intentId: v.intentId,
        payload: { day, source: 'RISK_VERDICT', lossRupees: v.dailyLoss?.lossRupees ?? null, limitRupees: v.dailyLoss?.limitRupees ?? null, action: v.dailyLoss?.action ?? null },
        dedupeKey: `latch:${v.userId}:${day}`,
      });
    }
  }
}
