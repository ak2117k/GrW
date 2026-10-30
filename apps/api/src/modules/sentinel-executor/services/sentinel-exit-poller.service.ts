// apps/api/src/modules/sentinel-executor/services/sentinel-exit-poller.service.ts
import { Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { describeExitDiscipline, parseExitDisciplineConfig } from '../../exit-discipline/config';
import type { AutoExitConfig } from '../domain/auto-exit.types';
import { CLAIM_STALE_MS, SECOND_SWEEP_MS } from '../domain/claim-timing';
import { AiExitExecutionRepository, type PendingVerdict } from '../repositories/ai-exit-execution.repository';
import { ExitNoiseReadService } from '../../exit-noise/exit-noise.service';
import { ExitFillSettler } from './exit-fill-settler.service';
import { ExitOutcomeService } from './exit-outcome.service';
import { SentinelExitExecutor, type AiExitOutcome } from './sentinel-exit-executor.service';

/** The executor outcomes that are an exit (sent, filled, or rehearsed in dry-run): each gets a noise read. */
export const NOISE_READ_STATUSES: ReadonlySet<string> = new Set(['PLACED', 'FILLED', 'DRY_RUN']);

/** An attempt's exit price for the noise read: the fill, else the LTP at the order, else at the decision. */
export function exitPriceOf(row: { fillPrice?: number | null; orderLtp?: number | null; decisionLtp?: number | null } | null | undefined): number | null {
  const ok = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;
  if (!row) return null;
  return ok(row.fillPrice) ? row.fillPrice : ok(row.orderLtp) ? row.orderLtp : ok(row.decisionLtp) ? row.decisionLtp : null;
}

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
    @Optional() private readonly noise?: ExitNoiseReadService,
  ) {}

  /**
   * "Noise or real?" (record only) for an EXIT_NOW the executor acted on (sent, filled or
   * rehearsed): fired after the attempt ended, never awaited — it cannot block, delay or change it.
   */
  private noiseRead(v: PendingVerdict, out: AiExitOutcome, rule: 'AI_EXIT', at: Date): void {
    if (!this.noise || !out || !NOISE_READ_STATUSES.has(out.status)) return;
    void Promise.resolve()
      .then(async () => {
        const exitPrice = exitPriceOf(await Promise.resolve().then(() => this.repo.findByVerdictId(v.id)).catch(() => null));
        const context = { execution: out.status, verdictAt: v.createdAt instanceof Date ? v.createdAt.toISOString() : null };
        return this.noise?.record({ source: 'real', refId: v.id, exitRule: rule, at, trackerId: v.trackerId, userId: v.userId, exitPrice, context });
      })
      .catch((e) => this.logger.warn(`[ai-exit] noise read for verdict ${v.id} failed: ${errText(e)}`));
  }

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
          const at = new Date();
          const out = await this.executor.process(v, cfg);
          this.noiseRead(v, out, 'AI_EXIT', at);
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
