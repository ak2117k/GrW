import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { CoreOrder, ExecutionAdapter } from '../execution/execution.types';
import { CORE_EXECUTION_ADAPTER } from '../execution/paper-execution.adapter';
import { PaperLedgerService } from '../execution/paper-ledger.service';
import { CORE_JOURNAL, type CoreJournalPort } from './journal-ports';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Spec §8.1 ORDER_PLACED / ORDER_STATE / FILL from the adapter's order-update stream (M4 L3). Every
 * row carries a dedupe key, so the repeated emissions of one order and a restart never duplicate.
 */
@Injectable()
export class OrderJournaler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderJournaler.name);
  private off: (() => void) | null = null;

  constructor(
    @Inject(CORE_EXECUTION_ADAPTER) private readonly adapter: ExecutionAdapter,
    private readonly ledger: PaperLedgerService,
    @Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort,
  ) {}

  onModuleInit(): void {
    if (!this.off) this.off = this.adapter.onOrderUpdate((o) => void this.onOrder(o));
  }

  onModuleDestroy(): void {
    this.off?.();
    this.off = null;
  }

  /** Never rejects: a journal failure is logged and never reaches the order flow (fail open). */
  async onOrder(o: CoreOrder): Promise<void> {
    try {
      await this.write(o);
    } catch (err) {
      this.logger.error(`core order ${o.id} (${o.state}) not journaled: ${errorText(err)}`);
    }
  }

  private async write(o: CoreOrder): Promise<void> {
    const base = { userId: o.userId, positionId: o.positionId ?? null, strategyVersionId: o.strategyVersionId, symbol: o.instrument.symbol };
    this.journal.record({
      ...base, type: 'ORDER_PLACED', at: o.submittedAt, priceUsed: o.refPrice, dedupeKey: `order:${o.id}:placed`,
      payload: { orderId: o.id, idempotencyKey: o.idempotencyKey, purpose: o.purpose, side: o.side, qty: o.qty, type: o.type, vehicle: o.vehicle },
    });
    this.journal.record({
      ...base, type: 'ORDER_STATE', at: o.updatedAt, priceUsed: o.avgFillPrice, dedupeKey: `order:${o.id}:${o.state}:${o.filledQty}`,
      payload: { orderId: o.id, state: o.state, filledQty: o.filledQty, avgFillPrice: o.avgFillPrice, rejectReason: o.rejectReason },
    });
    if (o.filledQty === 0) return;
    try {
      for (const f of await this.ledger.fillsFor(o.userId, [o.id])) {
        this.journal.record({
          ...base, type: 'FILL', at: f.priceAt, priceUsed: f.price.toNumber(), priceAgeMs: Math.max(0, f.createdAt.getTime() - f.priceAt.getTime()), dedupeKey: `fill:${f.id}`,
          payload: { orderId: o.id, fillId: f.id, qty: f.qty, price: f.price.toFixed(4), charges: f.chargesTotal.toFixed(2) },
        });
      }
    } catch (err) {
      this.logger.warn(`fills of core order ${o.id} not journaled this time: ${errorText(err)}`);
    }
  }
}
