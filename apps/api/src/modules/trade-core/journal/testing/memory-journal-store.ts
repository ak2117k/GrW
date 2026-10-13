import { istDate } from '../../execution/ledger-math';
import type { CoreJournalPort } from '../journal-ports';
import type { CoreJournalRepository } from '../repositories/core-journal.repository';
import type { CoreTradeSummaryRepository } from '../repositories/core-trade-summary.repository';
import type { JournalEntry, JournalRow, JournalType, NewTradeSummary, TradeSummary } from '../journal.types';

/** In-memory twins of CoreJournalRepository and CoreTradeSummaryRepository for service tests. */
export class MemoryJournalStore {
  rows: JournalRow[] = [];
  summaries: TradeSummary[] = [];
  /** While true every write rejects (a journal outage). */
  failWrites = false;
  /** A write containing a row this matches rejects (a permanently bad row). */
  rejectRow: ((e: JournalEntry) => boolean) | null = null;
  /** How many append calls were made. */
  appendCalls = 0;
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  readonly repo = {
    append: async (entries: readonly JournalEntry[]) => {
      this.appendCalls += 1;
      if (this.failWrites) throw new Error('journal down');
      if (this.rejectRow && entries.some((e) => this.rejectRow?.(e))) throw new Error('violates core_journal_shape_check');
      let n = 0;
      for (const e of entries) {
        if (e.dedupeKey && this.rows.some((r) => r.dedupeKey === e.dedupeKey)) continue;
        this.rows.push({
          id: this.nextId('jr'),
          userId: e.userId,
          type: e.type,
          positionId: e.positionId ?? null,
          strategyId: e.strategyId ?? null,
          strategyVersionId: e.strategyVersionId ?? null,
          intentId: e.intentId ?? null,
          symbol: e.symbol ?? null,
          payload: JSON.parse(JSON.stringify(e.payload)) as Record<string, unknown>,
          priceUsed: e.priceUsed ?? null,
          priceAgeMs: e.priceAgeMs === null || e.priceAgeMs === undefined ? null : Math.max(0, Math.round(e.priceAgeMs)),
          dedupeKey: e.dedupeKey ?? null,
          istDay: istDate(e.at),
          createdAt: e.at,
        });
        n += 1;
      }
      return n;
    },
    listForPosition: async (userId: string, positionId: string) => this.rows.filter((r) => r.userId === userId && r.positionId === positionId),
    listForDay: async (userId: string, day: string, types?: readonly JournalType[]) =>
      this.rows.filter((r) => r.userId === userId && r.istDay === day && (!types || types.includes(r.type))),
    findForUser: async (userId: string, id: string) => this.rows.find((r) => r.userId === userId && r.id === id) ?? null,
    hasType: async (userId: string, day: string, type: JournalType) => this.rows.some((r) => r.userId === userId && r.istDay === day && r.type === type),
    unackedMismatches: async (userId: string) => {
      const acked = new Set(this.rows.filter((r) => r.userId === userId && r.type === 'RECON_ACK').map((r) => r.dedupeKey));
      return this.rows.filter((r) => r.userId === userId && r.type === 'RECON_MISMATCH' && !acked.has(`ack:${r.id}`));
    },
    listTypeOnDay: async (type: JournalType, day: string, take: number) => this.rows.filter((r) => r.type === type && r.istDay === day).slice(0, take),
  } as unknown as CoreJournalRepository;

  readonly summaryRepo = {
    createIfAbsent: async (s: NewTradeSummary) => {
      if (this.failWrites) throw new Error('journal down');
      const existing = this.summaries.find((x) => x.positionId === s.positionId);
      if (existing) return existing;
      const row: TradeSummary = { ...s, id: this.nextId('sum'), createdAt: s.closedAt };
      this.summaries.push(row);
      return row;
    },
    findByPosition: async (userId: string, positionId: string) => this.summaries.find((x) => x.userId === userId && x.positionId === positionId) ?? null,
    positionIdsWithSummary: async (userId: string, ids: readonly string[]) =>
      new Set(this.summaries.filter((x) => x.userId === userId && ids.includes(x.positionId)).map((x) => x.positionId)),
    listForDay: async (userId: string, day: string) => this.summaries.filter((x) => x.userId === userId && x.istDay === day),
  } as unknown as CoreTradeSummaryRepository;

  /** A CoreJournalPort writing straight to this store (record is fire-and-forget; recordNow awaits). */
  port(): CoreJournalPort {
    return {
      record: (e: JournalEntry) => {
        void this.repo.append([e]).catch(() => undefined);
      },
      recordNow: async (e: JournalEntry) => {
        await this.repo.append([e]);
      },
    };
  }

  /** Test data: a closed cash trade summary. */
  sampleSummary(over: Partial<NewTradeSummary> = {}): NewTradeSummary {
    return {
      userId: 'user_A', positionId: 'pos_1', intentId: 'int_1', strategyId: 'cs_ungated', strategyVersionId: 'csv_ungated_v1',
      vehicle: 'CASH_INTRADAY', exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', side: 'BUY', qty: 100,
      entryAvgPrice: '500.0000', exitAvgPrice: '515.0000', openedAt: new Date('2026-10-13T04:00:00.000Z'), closedAt: new Date('2026-10-13T05:00:00.000Z'),
      grossPnl: '1500.00', charges: '40.00', mtfInterest: '0.00', netPnl: '1460.00', initialRisk: '750.00', rMultiple: '1.9467',
      mfePrice: '516.0000', maePrice: '499.0000', mfeRupees: '1600.00', maeRupees: '-100.00', holdMinutes: 60, exitReason: 'TARGET', istDay: '2026-10-13',
      ...over,
    };
  }
}
