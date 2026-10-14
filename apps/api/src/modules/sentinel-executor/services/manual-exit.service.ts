// apps/api/src/modules/sentinel-executor/services/manual-exit.service.ts
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AiExitExecution } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { CLAIM_STALE_MS } from '../domain/claim-timing';
import { AUTO_EXIT_EXCHANGES } from '../domain/auto-exit.types';
import { MANUAL_REASON_PREFIX, manualVerdictId } from '../domain/manual-exit';
import { AiExitExecutionRepository, type PendingVerdict } from '../repositories/ai-exit-execution.repository';
import { SentinelExitExecutor, type AiExitOutcome } from './sentinel-exit-executor.service';


// CLAIM_STALE_MS: the shared worst-case-derived staleness bound (domain/claim-timing).

export interface ManualExitResult {
  /** The attempt's row: freshly CLAIMED (started) or the attempt already working (not started). */
  row: AiExitExecution;
  started: boolean;
  /** Settles when the started attempt ends; the controller does NOT await it. */
  done: Promise<AiExitOutcome | null>;
}

type Tracker = { id: string; userId: string; symbol: string; status: string; kind: string; exchange: string };

/**
 * The owner's "Exit now" on one Trade Tracker row. Validates the caller and the
 * tracker, then hands a claimed attempt to the SAME executor pipeline the
 * sentinel auto-exit uses (trigger MANUAL): claim before any broker call, fresh
 * positions + order book, every position guard, one MARKET (+ the one LIMIT
 * fallback), ORDER_UNCERTAIN never retried.
 *
 * Idempotency: one working manual attempt per tracker. A request first returns
 * an attempt that is still CLAIMED / PLACED today; otherwise it claims
 * `man_<trackerId>_<n+1>` (n = attempts so far) — concurrent requests compute
 * the same id and UNIQUE(verdictId) lets exactly one claim; the loser returns
 * the winner's row. Anything that slips past (a retry racing a finished
 * attempt) still meets the executor's in-flight / prior-exit / open-order /
 * already-flat guards, so it can never become a second order.
 */
@Injectable()
export class ManualExitService {
  private readonly logger = new Logger(ManualExitService.name);

  constructor(
    private readonly repo: AiExitExecutionRepository,
    private readonly prisma: PrismaService,
    private readonly executor: SentinelExitExecutor,
  ) {}

  async request(
    user: AuthenticatedUser,
    trackerId: string,
    opts: { now?: Date; env?: Record<string, string | undefined> } = {},
  ): Promise<ManualExitResult> {
    const now = opts.now ?? new Date();
    const cfg = parseAutoExitConfig(opts.env ?? process.env);

    if (!user?.userId || (user.role !== 'ADMIN' && !cfg.userIds.includes(user.userId))) {
      throw new ForbiddenException('Manual exit is not enabled for this account');
    }
    const tracker = (await this.prisma.tradeTracker.findUnique({ where: { id: String(trackerId) } })) as Tracker | null;
    // Another user's tracker is indistinguishable from a missing one.
    if (!tracker || tracker.userId !== user.userId) throw new NotFoundException('Tracker not found');
    if (tracker.status !== 'OPEN') throw new UnprocessableEntityException('TRACKER_CLOSED: this position is already closed');
    if (tracker.kind !== 'POSITION') throw new UnprocessableEntityException('NOT_POSITION: only F&O positions can be exited here');
    const exchange = String(tracker.exchange ?? '').toUpperCase();
    if (!AUTO_EXIT_EXCHANGES.includes(exchange)) {
      throw new UnprocessableEntityException(`EXCHANGE_NOT_FNO: only ${AUTO_EXIT_EXCHANGES.join('/')} positions can be exited here`);
    }
    if (!cfg.qtyUnits[exchange]) {
      throw new UnprocessableEntityException(
        `QTY_UNIT_UNCONFIGURED:${exchange}: set AI_AUTO_EXIT_QTY_UNITS (e.g. ${exchange}:units) before exiting ${exchange} from here`,
      );
    }

    // Without the AI poller running nobody else sweeps a crashed attempt, and a
    // stuck CLAIMED row would block this tracker forever. Marked FAILED: INTERRUPTED (never re-sent).
    await this.repo.sweepInterrupted(new Date(now.getTime() - CLAIM_STALE_MS));

    const active = await this.repo.findActiveManual(tracker.id, user.userId, now);
    if (active) return { row: active, started: false, done: Promise.resolve(null) };

    const seq = (await this.repo.countManualForTracker(tracker.id)) + 1;
    const v: PendingVerdict = {
      id: manualVerdictId(tracker.id, seq),
      userId: user.userId,
      trackerId: tracker.id,
      symbol: tracker.symbol,
      reason: `${MANUAL_REASON_PREFIX} owner Exit now (Portfolio)`,
      createdAt: now,
    };
    // CLAIM — before any broker call, live mode (the owner's order is always live).
    const id = await this.repo.claim(v, 'live');
    if (!id) {
      const existing = await this.repo.findByVerdictId(v.id);
      if (!existing) throw new Error(`manual exit ${v.id} lost its claim but the row is missing`);
      return { row: existing, started: false, done: Promise.resolve(null) };
    }
    const row = await this.repo.findById(id);
    if (!row) throw new Error(`manual exit row ${id} vanished after its claim`);
    this.logger.warn(`[manual-exit] ${user.userId} requested Exit now on ${tracker.symbol} (${exchange}) — attempt ${v.id}`);
    const done = this.executor.execute(id, v, cfg, now, 'MANUAL');
    return { row, started: true, done };
  }
}
