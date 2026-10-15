// apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { describeExitDiscipline, parseExitDisciplineConfig } from '../../exit-discipline/config';
import type { AutoExitConfig } from '../domain/auto-exit.types';
import { CLAIM_STALE_MS, SECOND_SWEEP_MS } from '../domain/claim-timing';
import { AiExitExecutionRepository } from '../repositories/ai-exit-execution.repository';
import { ExitFillSettler } from './exit-fill-settler.service';
import { ExitOutcomeService } from './exit-outcome.service';
import { SentinelExitExecutor } from './sentinel-exit-executor.service';

export const AI_EXIT_POLL_MS = 5_000;
/** E5 fill settle sweep (plan R11): its own timer, never the exit poll's. */
export const EXIT_FILL_SETTLE_MS = 30_000;
/** Exit discipline §8 outcome scoring (plan R11): its own timer, never the exit poll's. */
export const EXIT_OUTCOME_MS = 60_000;
const PER_PASS = 5;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Spec §5.1. Disabled (the default), BOOT_JOBS=false, or an empty allow-list:
 * NOTHING runs — no timer, no query, no broker call. Enabled: crash sweep now and
 * again after CLAIM_STALE_MS + 5 s (ruling R8; bound derived in domain/claim-timing),
 * then one indexed query every 5 s. No @Cron.
 */
@Injectable()
export class SentinelExitPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SentinelExitPoller.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  private outcomeTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cfg: AutoExitConfig | null = null;

  constructor(
    private readonly repo: AiExitExecutionRepository,
    private readonly executor: SentinelExitExecutor,
    private readonly settler: ExitFillSettler,
    private readonly outcomes: ExitOutcomeService,
  ) {}

  onModuleInit(): void {
    const cfg = parseAutoExitConfig(process.env);
    for (const p of cfg.problems) this.logger.warn(`[ai-exit] ${p}`);
    if (!bootJobsEnabled()) {
      this.logger.log(BOOT_JOBS_DISABLED);
      return;
    }
    if (!cfg.enabled) {
      this.logger.log('[ai-exit] disabled (AI_AUTO_EXIT_ENABLED is not true)');
      return;
    }
    if (cfg.userIds.length === 0) {
      this.logger.error('[ai-exit] AI_AUTO_EXIT_ENABLED=true but AI_AUTO_EXIT_USER_IDS is empty — not starting');
      return;
    }
    this.cfg = cfg;
    const units = Object.entries(cfg.qtyUnits).map(([ex, u]) => `${ex}:${u}`).join(',') || 'none';
    this.logger.warn(
      `[ai-exit] ENABLED mode=${cfg.mode} users=${cfg.userIds.length} cap=${cfg.dailyCap}/day ` +
        `maxAge=${cfg.maxVerdictAgeSec}s fallback=${cfg.limitFallbackPct}% qty-units=${units} cancel-protective=${cfg.cancelProtective ? 'ON' : 'off'}`,
    );
    const d = parseExitDisciplineConfig(process.env);
    for (const p of d.problems) this.logger.warn(`[exit-discipline] ${p}`);
    this.logger.warn(`[exit-discipline] ${describeExitDiscipline(d)}`);
    void this.sweep();
    this.sweepTimer = setTimeout(() => void this.sweep(), SECOND_SWEEP_MS);
    this.sweepTimer.unref?.();
    this.timer = setInterval(() => void this.runOnce(), AI_EXIT_POLL_MS);
    this.timer.unref?.();
    // E5: settles PLACED rows from the order book (reads only, never logs in).
    this.settleTimer = setInterval(() => void this.settler.runOnce(), EXIT_FILL_SETTLE_MS);
    this.settleTimer.unref?.();
    // Exit discipline §8: post-decision scoring (DB + governed hub reads only).
    this.outcomeTimer = setInterval(() => void this.outcomes.runOnce(), EXIT_OUTCOME_MS);
    this.outcomeTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    if (this.settleTimer) clearInterval(this.settleTimer);
    if (this.outcomeTimer) clearInterval(this.outcomeTimer);
    this.timer = null;
    this.sweepTimer = null;
    this.settleTimer = null;
    this.outcomeTimer = null;
    this.cfg = null;
  }

  /** One pass. Single-flight; a no-op unless onModuleInit started the poller. */
  async runOnce(now: Date = new Date()): Promise<void> {
    const cfg = this.cfg;
    if (!cfg || this.running) return;
    this.running = true;
    try {
      const since = new Date(now.getTime() - 2 * cfg.maxVerdictAgeSec * 1000);
      const verdicts = await this.repo.pendingVerdicts(cfg.userIds, since, PER_PASS);
      for (const v of verdicts) {
        try {
          await this.executor.process(v, cfg);
        } catch (err) {
          this.logger.error(`[ai-exit] verdict ${v.id} errored: ${errText(err)}`);
        }
      }
    } catch (err) {
      this.logger.warn(`[ai-exit] poll failed: ${errText(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async sweep(): Promise<void> {
    try {
      const n = await this.repo.sweepInterrupted(new Date(Date.now() - CLAIM_STALE_MS));
      if (n > 0) this.logger.warn(`[ai-exit] ${n} interrupted attempt(s) marked FAILED: INTERRUPTED (never re-sent)`);
    } catch (err) {
      this.logger.warn(`[ai-exit] sweep failed: ${errText(err)}`);
    }
  }
}
