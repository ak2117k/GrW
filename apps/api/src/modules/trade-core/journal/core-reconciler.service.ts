import { Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AUDIT_ACTIONS } from '../../../common/audit/audit-actions';
import { AuditService } from '../../../common/audit/audit.service';
import { JobRunnerService } from '../../../common/job-registry';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import type { SessionClock } from '../../market-hub/session-clock';
import type { CoreOrder, ExecutionAdapter } from '../execution/execution.types';
import { PRICE_MAX_AGE_MS } from '../execution/fill-model';
import { istDate, istDayStart } from '../execution/ledger-math';
import { CORE_EXECUTION_ADAPTER } from '../execution/paper-execution.adapter';
import { PaperLedgerService } from '../execution/paper-ledger.service';
import { CorePaperDefaultsService } from '../execution/services/core-paper-defaults.service';
import { CorePositionRepository } from '../lifecycle/repositories/core-position.repository';
import { CORE_SESSION_CLOCK } from '../risk-wall/ports';
import { CORE_JOURNAL, CORE_POSITION_CLOSED, type CoreJournalPort, type PositionClosedListener } from './journal-ports';
import type { JournalRow } from './journal.types';
import { intradayFindings, nightlyFindings, type ReconFinding, type ReconSnapshot } from './recon-checks';
import { CoreJournalRepository } from './repositories/core-journal.repository';
import { CoreTradeSummaryRepository } from './repositories/core-trade-summary.repository';

/** Spec §8.3: every 5 minutes in session. */
export const RECON_INTERVAL_MS = 300_000;
export const CORE_RECON_JOB = 'core-recon-nightly';
const RECON_LEASE_MS = 30 * 60_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Spec §8.3 (J17, J18, O10). Every 5 minutes while NSE is open, and nightly at 15:45 IST, for each
 * user with core activity today: read a snapshot, run the pure checks, repair what is repairable
 * (a missing summary is written; a stuck ENTRY order is cancelled — an exit never is), and journal
 * the rest as RECON_MISMATCH (once per finding per IST day), which blocks the strategy's entries
 * until the owner acknowledges it. A snapshot that cannot be read is logged, never a finding.
 */
@Injectable()
export class CoreReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoreReconciler.name);
  private readonly flagged = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly positions: CorePositionRepository,
    private readonly ledger: PaperLedgerService,
    private readonly summaries: CoreTradeSummaryRepository,
    private readonly journalRepo: CoreJournalRepository,
    @Inject(CORE_JOURNAL) private readonly journal: CoreJournalPort,
    @Inject(CORE_POSITION_CLOSED) private readonly closed: PositionClosedListener,
    @Inject(CORE_EXECUTION_ADAPTER) private readonly adapter: ExecutionAdapter,
    private readonly defaults: CorePaperDefaultsService,
    @Inject(CORE_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'isOpen'>,
    private readonly jobs: JobRunnerService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    this.timer = setInterval(() => void this.runIntraday(), RECON_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runIntraday(now: Date = new Date()): Promise<void> {
    if (this.running || !this.clock.isOpen('NSE', now)) return;
    this.running = true;
    try {
      for (const userId of await this.positions.listUserIdsSince(istDayStart(now))) await this.reconcileUser(userId, 'INTRADAY', now);
    } catch (err) {
      this.logger.error(`reconciliation run failed: ${errorText(err)}`);
    } finally {
      this.running = false;
    }
  }

  @Cron('0 45 15 * * 1-5', { name: CORE_RECON_JOB, timeZone: 'Asia/Kolkata' })
  async nightly(): Promise<void> {
    await this.runNightly(new Date());
  }

  async runNightly(now: Date): Promise<void> {
    try {
      await this.jobs.run(CORE_RECON_JOB, { ttlMs: RECON_LEASE_MS, onRedisError: 'run-anyway' }, async () => {
        const users = await this.positions.listUserIdsSince(istDayStart(now));
        let findings = 0;
        for (const userId of users) findings += (await this.reconcileUser(userId, 'NIGHTLY', now)).length;
        this.logger.log(`nightly reconciliation ${istDate(now)}: ${users.length} user(s), ${findings} finding(s)`);
        return { users: users.length, findings };
      });
    } catch (err) {
      this.logger.error(`nightly reconciliation failed: ${errorText(err)}`);
    }
  }

  async reconcileUser(userId: string, kind: 'INTRADAY' | 'NIGHTLY', now: Date): Promise<ReconFinding[]> {
    let snap: ReconSnapshot;
    try {
      snap = await this.snapshot(userId, now);
    } catch (err) {
      this.logger.error(`reconciliation of ${userId} skipped (snapshot unreadable): ${errorText(err)}`);
      return [];
    }
    const remaining: ReconFinding[] = [];
    for (const found of kind === 'NIGHTLY' ? nightlyFindings(snap) : intradayFindings(snap)) {
      let f = found;
      if (f.repair === 'WRITE_SUMMARY' && f.positionId) {
        try {
          await this.closed.positionClosed(userId, f.positionId);
          if ((await this.summaries.positionIdsWithSummary(userId, [f.positionId])).has(f.positionId)) continue;
        } catch (err) {
          f = { ...f, detail: `${f.detail}; the repair failed: ${errorText(err)}` };
        }
      }
      if (f.repair === 'CANCEL_ENTRY' && f.orderId) {
        try {
          await this.adapter.cancel(userId, f.orderId);
          f = { ...f, detail: `${f.detail}; the entry was cancelled` };
        } catch (err) {
          f = { ...f, detail: `${f.detail}; the cancel failed: ${errorText(err)}` };
        }
      }
      remaining.push(f);
      const dedupeKey = `recon:${istDate(now)}:${f.fingerprint}`;
      try {
        await this.journal.recordNow({
          type: 'RECON_MISMATCH', userId, at: now, positionId: f.positionId, strategyId: f.strategyId,
          payload: { check: f.check, detail: f.detail, kind, fingerprint: f.fingerprint, orderId: f.orderId, repair: f.repair }, dedupeKey,
        });
        if (!this.flagged.has(dedupeKey)) {
          this.flagged.add(dedupeKey);
          this.logger.error(`RECON_MISMATCH ${userId} ${f.check}: ${f.detail} — entries for ${f.strategyId ?? 'every strategy'} blocked until acknowledged`);
        }
      } catch (err) {
        this.logger.error(`RECON_MISMATCH for ${userId} (${f.check}) not journaled: ${errorText(err)}`);
      }
    }
    return remaining;
  }

  /** The owner acknowledges a finding (O10): its entry block lifts. Audited; an audit failure never fails the ack. */
  async ack(userId: string, mismatchId: string, reason: string, now: Date = new Date()): Promise<{ acknowledged: string }> {
    const row = await this.journalRepo.findForUser(userId, mismatchId);
    if (!row || row.type !== 'RECON_MISMATCH') throw new NotFoundException(`reconciliation finding ${mismatchId} not found`);
    await this.journal.recordNow({
      type: 'RECON_ACK', userId, at: now, positionId: row.positionId, strategyId: row.strategyId,
      payload: { mismatchId, reason, check: row.payload.check ?? null }, dedupeKey: `ack:${mismatchId}`,
    });
    try {
      await this.audit.append({ action: AUDIT_ACTIONS.journal.CORE_RECON_ACKNOWLEDGED, userId, target: `core_journal:${mismatchId}`, meta: { reason } });
    } catch (err) {
      this.logger.error(`CORE_RECON_ACKNOWLEDGED audit failed for ${mismatchId} (the ack is journaled): ${errorText(err)}`);
    }
    return { acknowledged: mismatchId };
  }

  unacked(userId: string): Promise<JournalRow[]> {
    return this.journalRepo.unackedMismatches(userId);
  }

  private async snapshot(userId: string, now: Date): Promise<ReconSnapshot> {
    const settings = await this.defaults.settings(now.getTime());
    const stuckAfterMs = 2 * (settings.ok ? settings.settings.noPriceRejectMs : PRICE_MAX_AGE_MS);
    const positions = await this.positions.listForUser(userId, istDayStart(now));
    const ordersByPosition = new Map<string, CoreOrder[]>();
    for (const p of positions) ordersByPosition.set(p.id, await this.ledger.listPositionOrders(userId, p.id));
    const orderIds = [...ordersByPosition.values()].flat().map((o) => o.id);
    const [fills, marginByOrder, interestTokensToday, summarised] = await Promise.all([
      this.ledger.fillsFor(userId, orderIds),
      this.ledger.marginByOrder(userId, orderIds),
      this.ledger.interestTokensOn(userId, istDate(now)),
      this.summaries.positionIdsWithSummary(userId, positions.filter((p) => p.status === 'CLOSED').map((p) => p.id)),
    ]);
    const fillQtyByOrder = new Map<string, number>();
    for (const f of fills) fillQtyByOrder.set(f.orderId, (fillQtyByOrder.get(f.orderId) ?? 0) + f.qty);
    return { now, positions, ordersByPosition, fillQtyByOrder, marginByOrder, summarised, interestTokensToday, stuckAfterMs };
  }
}
