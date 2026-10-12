import { Injectable, Logger } from '@nestjs/common';
import type { CoreOrder } from './execution.types';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * SP2 M4 ruling L3: every committed core order change, in process. PaperLedgerService
 * emits after its transaction commits; the lifecycle listens. A listener that throws is
 * logged and never reaches the writer. Delivery is best effort: the lifecycle also
 * re-reads its positions' orders every 5 s.
 */
@Injectable()
export class CoreOrderEvents {
  private readonly logger = new Logger(CoreOrderEvents.name);
  private readonly listeners = new Set<(order: CoreOrder) => void>();

  subscribe(fn: (order: CoreOrder) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(order: CoreOrder): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(order);
      } catch (err) {
        this.logger.error(`core order ${order.id}: an update listener failed: ${errorText(err)}`);
      }
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
