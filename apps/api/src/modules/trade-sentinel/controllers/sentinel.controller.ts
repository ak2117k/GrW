import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import { SentinelVerdictRepository } from '../repositories/sentinel-verdict.repository';
import {
  WatchedPositionRepository,
  type WatchedPosition,
} from '../repositories/watched-position.repository';
import { ThesisService } from '../services/thesis.service';
import type { StoredThesis } from '../services/context-packet.service';
import {
  CorrectThesisDto,
  toSentinelVerdictDto,
  type SentinelVerdictDto,
} from '../dto/sentinel.dto';

/** Default and hard ceiling on how many verdicts one read returns. */
export const DEFAULT_VERDICT_LIMIT = 50;
export const MAX_VERDICT_LIMIT = 200;

/**
 * Stage 0's surface: read what the sentinel decided, and correct a thesis it
 * read wrong.
 *
 * THERE IS NO EXIT ROUTE HERE, BY DESIGN, and the absence is structural rather
 * than a matter of restraint — this controller injects a verdict repository and
 * a thesis service, neither of which can reach an executor. Adding a route that
 * could close a position would require adding a collaborator that can, which is
 * a change a reviewer sees.
 *
 * Authenticated by the GLOBAL `JwtAuthGuard` (the house style — see
 * `TradeTrackerController`), and every read and write is scoped to
 * `@CurrentUser('userId')`. The thesis write is tenant-scoped a second time
 * inside the repository, because `trackerId` alone is an IDOR on the one row
 * every later judgement is measured against.
 */
@Controller('api/trade-sentinel')
export class SentinelController {
  constructor(
    private readonly verdicts: SentinelVerdictRepository,
    private readonly thesis: ThesisService,
    private readonly watched: WatchedPositionRepository,
  ) {}

  /**
   * GET /api/trade-sentinel/positions — the caller's OPEN positions, each with
   * the sentinel's latest verdict and its thesis.
   *
   * This is the CHART's read. One call returns everything an overlay draws, so
   * a page showing five positions does not make eleven requests, and the entry,
   * the green floor and the verdict a user reads together cannot come from
   * three different instants.
   */
  @Get('positions')
  async positions(@CurrentUser('userId') userId: string): Promise<WatchedPosition[]> {
    return this.watched.listForUser(userId);
  }

  /**
   * GET /api/trade-sentinel/verdicts — the caller's own recorded verdicts,
   * newest first.
   */
  @Get('verdicts')
  async list(
    @CurrentUser('userId') userId: string,
    @Query('limit') limit?: string,
  ): Promise<SentinelVerdictDto[]> {
    const rows = await this.verdicts.listForUser(userId, parseLimit(limit));
    return rows.map(toSentinelVerdictDto);
  }

  /**
   * POST /api/trade-sentinel/thesis/:trackerId — restate what this trade was
   * actually for.
   *
   * The patch is REBUILT field by field rather than forwarded. The global
   * `ValidationPipe` runs with `whitelist: true` so an extra `direction` in the
   * body is already stripped — but the repository's `sanitisePatch` DOES accept
   * `direction`, so if that pipe were ever reconfigured, forwarding the body
   * wholesale would let a user set a thesis direction opposing their real
   * position. See {@link CorrectThesisDto} for why that must not be possible.
   */
  @Post('thesis/:trackerId')
  async correctThesis(
    @CurrentUser('userId') userId: string,
    @Param('trackerId') trackerId: string,
    @Body() body: CorrectThesisDto,
  ): Promise<StoredThesis> {
    return this.thesis.correct(trackerId, userId, {
      reason: body.reason,
      levelPrice: body.levelPrice,
      targetPrice: body.targetPrice,
      invalidation: body.invalidation,
    });
  }
}

/**
 * A caller-supplied limit, clamped into [1, {@link MAX_VERDICT_LIMIT}].
 *
 * Exported and pure because every branch here is a way to hand Prisma a bad
 * `take`: `Number('')` is 0, `Number('abc')` is NaN, and a negative `take`
 * makes Prisma read BACKWARDS from the cursor rather than erroring.
 */
export function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_VERDICT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_VERDICT_LIMIT);
}
