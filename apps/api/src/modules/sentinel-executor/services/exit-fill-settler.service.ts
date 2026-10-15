// apps/api/src/modules/sentinel-executor/services/exit-fill-settler.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { answeredPositions } from '../../trade-tracker/services/trade-tracker.service';
import { CLAIM_STALE_MS } from '../domain/claim-timing';
import { findOrderFill } from '../domain/exit-fill';
import { istDayStartUtc } from '../domain/exit-order';
import { AiExitExecutionRepository } from '../repositories/ai-exit-execution.repository';
import { OwnerBrokerSessionProvider } from './owner-broker-session.provider';

/** A row is re-read from the order book at most this often. */
const RECHECK_MS = 30_000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * E5 (exit discipline plan Task 13): live exit rows left PLACED (the order was
 * still resting after the executor's 10 s confirm) are settled from the ORDER
 * BOOK: `complete` ⇒ FILLED with the fill, `rejected`/`cancelled` ⇒ REJECTED.
 *
 * Observation only. It reads the order book and nothing else: it never places,
 * cancels or modifies an order, never touches a position, and never logs in
 * (`allowEphemeralLogin: false` — no warm feed session ⇒ the row waits). A row is
 * left alone until CLAIM_STALE_MS after its claim, the bound by which any
 * executor attempt on it has ended, and is moved only while it is STILL PLACED.
 */
@Injectable()
export class ExitFillSettler {
  private readonly logger = new Logger(ExitFillSettler.name);
  private readonly checkedAt = new Map<string, number>();
  private running = false;

  constructor(
    private readonly repo: AiExitExecutionRepository,
    private readonly sessions: OwnerBrokerSessionProvider,
  ) {}

  /** One sweep. Single-flight; never throws. */
  async runOnce(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.repo.placedAwaitingFill(istDayStartUtc(now));
      for (const r of rows) {
        if (now.getTime() - r.createdAt.getTime() < CLAIM_STALE_MS) continue; // the executor may still own it
        if (now.getTime() - (this.checkedAt.get(r.id) ?? 0) < RECHECK_MS) continue;
        this.checkedAt.set(r.id, now.getTime());
        try {
          await this.sessions.withOwnerSession(r.userId, async (s) => {
            const book = answeredPositions(await s.getOrderBookEnvelope());
            const f = book ? findOrderFill(book, String(r.brokerOrderId)) : null;
            if (!f) return;
            if (f.status === 'complete') {
              const moved = await this.repo.settlePlaced(r.id, {
                status: 'FILLED', orderStatus: 'complete', fillPrice: f.averagePrice, fillQty: f.filledQty, fillAt: f.fillAt ?? now,
              });
              if (moved) this.logger.log(`[exit-fill] ${r.symbol} order ${r.brokerOrderId} FILLED @ ${f.averagePrice ?? '?'} (settled late) — verdict ${r.verdictId}`);
            } else if (f.status === 'rejected' || f.status === 'cancelled') {
              const moved = await this.repo.settlePlaced(r.id, {
                status: 'REJECTED', reason: f.status === 'cancelled' ? 'CANCELLED' : 'BROKER_REJECTED',
                orderStatus: f.status, brokerMessage: f.text || null,
              });
              if (moved) this.logger.warn(`[exit-fill] ${r.symbol} order ${r.brokerOrderId} ${f.status} after PLACED — the position was NOT exited — verdict ${r.verdictId}`);
            }
          }, { allowEphemeralLogin: false });
        } catch (err) {
          this.logger.debug?.(`[exit-fill] ${r.symbol}: ${errText(err)}`);
        }
      }
      for (const [id, at] of this.checkedAt) if (now.getTime() - at > 86_400_000) this.checkedAt.delete(id);
    } catch (err) {
      this.logger.warn(`[exit-fill] sweep failed: ${errText(err)}`);
    } finally {
      this.running = false;
    }
  }
}
