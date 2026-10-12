import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AUDIT_ACTIONS } from '../../../common/audit/audit-actions';
import { AuditService } from '../../../common/audit/audit.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { istDate } from '../execution/ledger-math';
import { CORE_SQUARE_OFF, RISK_STATE_PROVIDER, type CoreSquareOffPort, type RiskStateProvider } from '../risk-wall/ports';
import { decideDailyLoss } from '../risk-wall/risk-wall';
import type { DailyLossDecision } from '../risk-wall/risk-wall.types';
import { CoreRiskLimitService } from '../risk-wall/services/core-risk-limit.service';
import { CorePositionRepository } from './repositories/core-position.repository';

/** Ruling L15: the cadence of the daily-loss check. */
export const DAILY_LOSS_CHECK_MS = 5_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Spec §5.3 (M2 notes for M4): for every user with active core positions, decideDailyLoss on
 * the limits in force and the live state; when the action is BLOCK_AND_SQUARE_OFF and the loss
 * is reached, CORE_SQUARE_OFF with cause DAILY_LOSS, once per user per IST day in this process
 * (a repeat after a restart only exits what is still open). A state that cannot be read is
 * never a reason to exit (positions keep their stops; the wall already rejects entries).
 */
@Injectable()
export class DailyLossMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyLossMonitor.name);
  private readonly firedOn = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly positions: CorePositionRepository,
    @Inject(RISK_STATE_PROVIDER) private readonly state: RiskStateProvider,
    private readonly limits: CoreRiskLimitService,
    @Inject(CORE_SQUARE_OFF) private readonly squareOff: CoreSquareOffPort,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    this.timer = setInterval(() => void this.runOnce(), DAILY_LOSS_CHECK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const userId of await this.positions.listActiveUserIds()) await this.checkUser(userId, now);
    } catch (err) {
      this.logger.error(`daily-loss check failed: ${errorText(err)}`);
    } finally {
      this.running = false;
    }
  }

  async checkUser(userId: string, now: Date): Promise<DailyLossDecision | null> {
    const day = istDate(now);
    if (this.firedOn.get(userId) === day) return null;
    let d: DailyLossDecision;
    let openPnlKnown: boolean;
    try {
      const live = await this.state.liveState(userId, now);
      openPnlKnown = typeof live.openPnl === 'number' && Number.isFinite(live.openPnl);
      d = decideDailyLoss(await this.limits.inForce(userId, now), live);
    } catch (err) {
      this.logger.warn(`daily-loss check for ${userId} skipped (state unreadable; positions keep their stops): ${errorText(err)}`);
      return null;
    }
    // Owner ruling 2026-10-12: with open P&L unknown (a blind position), a realised loss alone at
    // the limit is BREACHED (decideDailyLoss) and squares off here; under it, UNKNOWN does nothing.
    if (d.status !== 'BREACHED' || !d.squareOffCore) return d;
    this.firedOn.set(userId, day);
    const reason = openPnlKnown
      ? `today's loss ₹${d.lossRupees} reached the ₹${d.limitRupees} daily limit`
      : `today's realised loss ₹${d.lossRupees} reached the ₹${d.limitRupees} daily limit (open P&L unknown)`;
    let detail: string;
    try {
      detail = (await this.squareOff.squareOffAll(userId, 'DAILY_LOSS', reason)).detail;
    } catch (err) {
      this.firedOn.delete(userId);
      this.logger.error(`daily-loss square-off for ${userId} failed; retried on the next check: ${errorText(err)}`);
      return d;
    }
    this.logger.warn(`daily loss for ${userId}: ${detail}`);
    // The audit is separate from the square-off: an audit failure (even a synchronous throw)
    // must never clear the day's latch and re-square the user every check.
    try {
      await this.audit.append({ action: AUDIT_ACTIONS.lifecycle.CORE_DAILY_LOSS_SQUARE_OFF, userId, target: `core_daily_loss:${userId}:${day}`, meta: { reason, result: detail } });
    } catch (err) {
      this.logger.error(`daily-loss audit for ${userId} failed (the square-off ran): ${errorText(err)}`);
    }
    return d;
  }
}
