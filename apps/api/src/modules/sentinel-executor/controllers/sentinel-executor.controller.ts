// apps/api/src/modules/sentinel-executor/controllers/sentinel-executor.controller.ts
import { BadRequestException, Controller, ForbiddenException, Get, HttpCode, Logger, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { parseAutoExitConfig } from '../domain/auto-exit.config';
import { AiExitExecutionRepository } from '../repositories/ai-exit-execution.repository';
import { toAiExitExecutionDto, type AiExitExecutionDto } from '../dto/ai-exit-execution.dto';
import { SentinelExitTriggerRepository } from '../repositories/sentinel-exit-trigger.repository';
import { toSentinelExitTriggerDto, type SentinelExitTriggerDto } from '../dto/sentinel-exit-trigger.dto';
import { ManualExitService } from '../services/manual-exit.service';
import { AiExitOutcomeRepository } from '../repositories/ai-exit-outcome.repository';
import { istDate } from '../../exit-discipline/decision';
import type { OutcomeKind } from '../../exit-discipline/types';
import { scorecard, type Scorecard } from '../../exit-discipline/scorecard';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A real calendar day as YYYY-MM-DD. */
const isIsoDay = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
/** `?limit=` clamped to 1..MAX_LIMIT; anything unparsable is DEFAULT_LIMIT. */
const takeOf = (limit: string | undefined) => {
  const n = Number.parseInt(String(limit ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
};

/**
 * What the auto-exit did (spec §8), plus the owner's manual "Exit now". Global
 * JWT guard; caller must be ADMIN or allow-listed (ruling R13); rows are ALWAYS
 * the caller's own. Deliberately not on SentinelController, which must stay exit-free.
 */
@Controller('api/sentinel-executor')
export class SentinelExecutorController {
  private readonly logger = new Logger(SentinelExecutorController.name);

  constructor(
    private readonly repo: AiExitExecutionRepository,
    private readonly triggerRepo: SentinelExitTriggerRepository,
    private readonly manual: ManualExitService,
    private readonly outcomes: AiExitOutcomeRepository,
  ) {}

  @Get('executions')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ): Promise<AiExitExecutionDto[]> {
    this.assertAllowed(user);
    const rows = await this.repo.listForUser(user.userId, takeOf(limit));
    // Exit discipline §8: the page's outcomes in ONE query, joined by executionId.
    const outcomes = await this.outcomes.byExecutionIds(rows.map((r) => r.id));
    const byExec = new Map(outcomes.map((o) => [o.executionId, o]));
    return rows.map((r) => toAiExitExecutionDto(r, byExec.get(r.id) ?? null));
  }

  /**
   * Exit discipline E7: the caller's daily scorecard (executed / dry-run / what the
   * gate's holds returned) for IST day `day` (YYYY-MM-DD, default yesterday IST).
   */
  @Get('scorecard')
  async scorecard(
    @CurrentUser() user: AuthenticatedUser,
    @Query('day') day?: string,
    now: Date = new Date(),
  ): Promise<Scorecard> {
    this.assertAllowed(user);
    const d = day === undefined || day === '' ? istDate(new Date(now.getTime() - 86_400_000)) : day;
    if (!isIsoDay(d)) throw new BadRequestException('day must be YYYY-MM-DD');
    const rows = await this.outcomes.forDay(user.userId, d);
    return scorecard(d, rows.map((r) => ({
      kind: r.kind as OutcomeKind, missedPnl: r.missedPnl ?? 0, savedPnl: r.savedPnl ?? 0, netAtEnd: r.netAtEnd ?? 0,
    })));
  }

  /** Price triggers (armed first, then recent), the caller's own — what WILL fire (ruling R16). */
  @Get('triggers')
  async triggers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ): Promise<SentinelExitTriggerDto[]> {
    this.assertAllowed(user);
    const rows = await this.triggerRepo.listForUser(user.userId, takeOf(limit));
    return rows.map(toSentinelExitTriggerDto);
  }

  /** ADMIN or allow-listed (ruling R13); checked before any query. */
  private assertAllowed(user: AuthenticatedUser | undefined): void {
    const allowed = parseAutoExitConfig(process.env).userIds;
    if (!user?.userId || (user.role !== 'ADMIN' && !allowed.includes(user.userId))) {
      throw new ForbiddenException('AI exits are not enabled for this account');
    }
  }

  /**
   * The owner's "Exit now" on one OPEN F&O position tracker. Places a REAL
   * order. Returns at once with the attempt's row — CLAIMED when this request
   * started it, or the attempt already working (a repeat click) — and the
   * broker work continues in the background; the UI polls GET executions.
   * 403 not allowed / 404 not the caller's tracker / 422 not exitable here.
   */
  @Post('exit/:trackerId')
  @HttpCode(202)
  async exit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('trackerId') trackerId: string,
  ): Promise<AiExitExecutionDto> {
    const r = await this.manual.request(user, trackerId);
    r.done.catch((err) => this.logger.error(`[manual-exit] attempt ${r.row.id} errored: ${errText(err)} — row left for the sweep`));
    return toAiExitExecutionDto(r.row);
  }
}
