import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { chargesForLeg } from '../../trade-sentinel/charges';
import { PRICE_MAX_AGE_MS } from '../execution/fill-model';
import { istDate } from '../execution/ledger-math';
import { PaperLedgerService, SEGMENT_BY_VEHICLE } from '../execution/paper-ledger.service';
import { JOURNAL_RISK_READS, type JournalRiskReadsPort } from '../journal/journal-risk-reads';
import type { ReconBlock } from '../journal/recon-checks';
import type { RiskStateProvider } from '../risk-wall/ports';
import type { RiskLiveState, RiskOpenPosition } from '../risk-wall/risk-wall.types';
import { VEHICLES, type Vehicle } from '../strategies/blocks/block-types';
import { round2 } from './exit-plan';
import { LIFECYCLE_MARKS, type LifecycleMarks } from './lifecycle-ports';
import { isActiveStatus, type CorePosition } from './lifecycle.types';
import { CorePositionRepository } from './repositories/core-position.repository';

/** A ledger amount string as rupees; anything unparseable is unknown (null), which the wall rejects. */
function rupees(s: string): number | null {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
}

/** Open P&L at `ltp`, net of the exit leg's charges (Risk Wall rupees are net of charges). */
export function markToMarket(p: Pick<CorePosition, 'vehicle' | 'side' | 'openQty' | 'entryAvgPrice'>, ltp: number): number {
  const dir = p.side === 'BUY' ? 1 : -1;
  const gross = (ltp - (p.entryAvgPrice ?? ltp)) * p.openQty * dir;
  const exitLeg = chargesForLeg({ segment: SEGMENT_BY_VEHICLE[p.vehicle], leg: p.side === 'BUY' ? 'SELL' : 'BUY', price: ltp, qty: p.openQty }).total;
  return round2(gross - exitLeg);
}

/**
 * RISK_STATE_PROVIDER (spec §5.1; M2 notes for M4): open positions from core_positions with
 * their strategy and exposure underlying, `priced` from a lifecycle mark no older than
 * PRICE_MAX_AGE_MS, open P&L from those marks (null when any open position is unpriced: the
 * wall then rejects), today's realised P&L, per-strategy P&L, entries and deployed capital
 * from the ledger. A ledger or position read failure throws. M5: the daily-loss latch (J13)
 * and the reconciliation block (J12, O10) are read from the journal; a journal read failure
 * does NOT throw — it sets `journalUnreadable` (the wall rejects entries JOURNAL_UNAVAILABLE),
 * because this state also feeds DailyLossMonitor, and a journal outage must never stop the
 * daily-loss square-off (exits are never blocked).
 */
@Injectable()
export class CoreRiskStateProvider implements RiskStateProvider {
  private readonly logger = new Logger(CoreRiskStateProvider.name);

  constructor(
    private readonly ledger: PaperLedgerService,
    private readonly positions: CorePositionRepository,
    @Inject(LIFECYCLE_MARKS) private readonly marks: LifecycleMarks,
    @Optional() @Inject(JOURNAL_RISK_READS) private readonly reads?: JournalRiskReadsPort,
  ) {}

  /** The journal-derived inputs; never rejects. */
  private async journalInputs(userId: string, at: Date): Promise<{ dailyLossLatched: boolean; reconBlocked: ReconBlock; journalUnreadable: boolean }> {
    const none: ReconBlock = { all: false, strategyIds: [] };
    if (!this.reads) return { dailyLossLatched: false, reconBlocked: none, journalUnreadable: false };
    try {
      const [dailyLossLatched, reconBlocked] = await Promise.all([this.reads.latched(userId, istDate(at)), this.reads.reconBlock(userId)]);
      return { dailyLossLatched, reconBlocked, journalUnreadable: false };
    } catch (err) {
      this.logger.error(`journal risk reads for ${userId} failed (entries rejected JOURNAL_UNAVAILABLE): ${err instanceof Error ? err.message : String(err)}`);
      return { dailyLossLatched: false, reconBlocked: none, journalUnreadable: true };
    }
  }

  async liveState(userId: string, at: Date): Promise<RiskLiveState> {
    const dayStart = new Date(`${istDate(at)}T00:00:00.000+05:30`);
    const [funds, day, rows, realisedByPosition, journal] = await Promise.all([
      this.ledger.funds(userId),
      this.ledger.dayStats(userId, at),
      this.positions.listForUser(userId, dayStart),
      this.ledger.netPnlTodayByPosition(userId, at),
      this.journalInputs(userId, at),
    ]);
    const byStrategy: Record<string, number> = {};
    const add = (strategyId: string, v: number) => {
      byStrategy[strategyId] = round2((byStrategy[strategyId] ?? 0) + v);
    };
    let openPnl: number | null = 0;
    const openPositions: RiskOpenPosition[] = [];
    for (const p of rows) {
      const realised = realisedByPosition.get(p.id);
      if (realised) add(p.strategyId, realised.toNumber());
      if (!isActiveStatus(p.status)) continue;
      let priced = true;
      if (p.openQty > 0) {
        const m = this.marks.mark(p.id);
        if (m === null || p.entryAvgPrice === null || m.at > at.getTime() || at.getTime() - m.at > PRICE_MAX_AGE_MS) {
          priced = false;
          openPnl = null;
        } else {
          const u = markToMarket(p, m.ltp);
          add(p.strategyId, u);
          if (openPnl !== null) openPnl = round2(openPnl + u);
        }
      }
      openPositions.push({
        positionId: p.id,
        strategyId: p.strategyId,
        vehicle: p.vehicle,
        symbol: p.instrument.symbol,
        underlying: p.underlying,
        direction: p.direction,
        state: p.status,
        priced,
      });
    }
    return {
      asOf: at,
      openPositions,
      realisedPnlToday: day.netPnlToday.toNumber(),
      openPnl,
      pnlTodayByStrategy: byStrategy,
      tradesToday: day.entriesToday,
      deployedCapital: Object.fromEntries(VEHICLES.map((v) => [v, rupees(funds.deployedByVehicle[v])])) as Record<Vehicle, number | null>,
      dailyLossLatched: journal.dailyLossLatched,
      reconBlocked: journal.reconBlocked,
      ...(journal.journalUnreadable ? { journalUnreadable: true } : {}),
    };
  }
}
