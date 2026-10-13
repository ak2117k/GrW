import { Inject, Injectable, Logger } from '@nestjs/common';
import { istDate, istDayStart } from '../execution/ledger-math';
import { PaperLedgerService } from '../execution/paper-ledger.service';
import { CorePositionRepository } from '../lifecycle/repositories/core-position.repository';
import { CORE_CORPUS, type CoreCorpusPort, type CoreTradeHistory, type PositionClosedListener } from './journal-ports';
import type { TradeSummary } from './journal.types';
import { CoreTradeSummaryRepository } from './repositories/core-trade-summary.repository';
import { outcomeOf, summarizeTrade } from './trade-summary';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Spec §8.2 (J16): one summary per CLOSED position, from its orders and their ledger rows; first
 * write wins. Also the intake's trade history (J5): a closed trade without a summary is summarised
 * on read, and when that fails the answer is UNKNOWN (the intake then skips: fail closed).
 */
@Injectable()
export class CoreTradeSummaryService implements PositionClosedListener, CoreTradeHistory {
  private readonly logger = new Logger(CoreTradeSummaryService.name);

  constructor(
    private readonly positions: CorePositionRepository,
    private readonly ledger: PaperLedgerService,
    private readonly summaries: CoreTradeSummaryRepository,
    @Inject(CORE_CORPUS) private readonly corpus: CoreCorpusPort,
  ) {}

  async positionClosed(userId: string, positionId: string): Promise<void> {
    await this.writeFor(userId, positionId);
  }

  async writeFor(userId: string, positionId: string): Promise<TradeSummary | null> {
    const existing = await this.summaries.findByPosition(userId, positionId);
    if (existing) return existing;
    const p = await this.positions.findForUser(userId, positionId);
    if (!p || p.status !== 'CLOSED' || p.openedAt === null || p.closedAt === null) return null;
    const orders = await this.ledger.listPositionOrders(userId, positionId);
    const rows = await this.ledger.ledgerRowsForPosition(userId, orders.map((o) => o.id), p.instrument.token, istDate(p.openedAt), istDate(p.closedAt));
    const r = summarizeTrade({ position: p, orders, ledger: rows });
    if (!r.ok) throw new Error(r.error);
    const s = await this.summaries.createIfAbsent(r.summary);
    try {
      await this.corpus.outcome(p.intentId, { ...outcomeOf(s) }, s.closedAt);
    } catch (err) {
      this.logger.warn(`corpus outcome for ${p.intentId} not written: ${errorText(err)}`);
    }
    return s;
  }

  async intentSeen(intentId: string): Promise<boolean> {
    return (await this.positions.findByIntent(intentId)) !== null;
  }

  lastOpenedAt(userId: string, strategyId: string, token: string): Promise<Date | null> {
    return this.positions.lastOpenedAt(userId, strategyId, token);
  }

  async lastClosedNetToday(userId: string, strategyId: string, token: string, now: Date): Promise<number | 'UNKNOWN' | null> {
    const [last] = await this.positions.listClosedSince(userId, strategyId, token, istDayStart(now));
    if (!last) return null;
    try {
      const s = await this.writeFor(userId, last.id);
      return s ? Number(s.netPnl) : 'UNKNOWN';
    } catch (err) {
      this.logger.warn(`last trade ${last.id} cannot be summarised (entries on it fail closed): ${errorText(err)}`);
      return 'UNKNOWN';
    }
  }
}
