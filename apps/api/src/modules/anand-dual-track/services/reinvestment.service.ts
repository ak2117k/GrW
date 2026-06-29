import { Injectable, Logger } from '@nestjs/common';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';

const NOTIONAL = 200_000;
/** Profit realized by a swing +10% target hit, reinvested as a new lot. */
export const SWING_PROFIT = 0.1 * NOTIONAL; // ₹20,000

@Injectable()
export class ReinvestmentService {
  private readonly logger = new Logger(ReinvestmentService.name);

  constructor(private readonly repo: AnandDualTrackRepository) {}

  /**
   * Fired when a SwingEntry hits +10%. Capital "returns to the pool"; only the
   * ₹20k profit is reinvested as a new lot in the same symbol. Idempotent per
   * swingEntryId (the lot's sourceSwingEntryId is unique).
   */
  async onSwingTargetHit(input: { swingEntryId: string; symbol: string; exitPrice: number }): Promise<void> {
    const lot = await this.repo.createReinvestmentLot({
      symbol: input.symbol,
      sourceSwingEntryId: input.swingEntryId,
      capital: SWING_PROFIT,
      entryPrice: input.exitPrice,
    });
    if (!lot) return; // already created on a prior poll — do not double-count the pool
    await this.repo.applyPoolDelta({ harvestedTotal: SWING_PROFIT, deployedActive: SWING_PROFIT });
    this.logger.log(`[reinvest] deployed ₹${SWING_PROFIT} into ${input.symbol} @ ${input.exitPrice} (lot ${lot.id})`);
  }

  /** Close an open lot at `ltp`, moving capital+pnl back to the idle pool. */
  async closeLot(
    lot: { id: string; capital: number; entryPrice: number },
    ltp: number,
    status: 'TARGET_HIT' | 'STOPPED',
  ): Promise<void> {
    const pnlPct = ((ltp - lot.entryPrice) / lot.entryPrice) * 100;
    const lotPnl = (pnlPct / 100) * lot.capital;
    const { transitioned } = await this.repo.closeReinvestmentLot(lot.id, {
      status,
      exitPrice: ltp,
      exitedAt: new Date(),
      exitReason: status,
    });
    if (!transitioned) return; // another poll already closed it — do not double-count the pool
    await this.repo.applyPoolDelta({
      deployedActive: -lot.capital,
      idleBalance: lot.capital + lotPnl,
      realizedPnl: lotPnl,
    });
    this.logger.log(`[reinvest] closed lot ${lot.id} ${status} pnl=₹${lotPnl.toFixed(0)}`);
  }
}
