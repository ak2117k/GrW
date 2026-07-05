import { BadRequestException, Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { Segment } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators';
import { UpdateAutoExecDto } from '../dto/update-auto-exec.dto';
import {
  AUTO_EXEC_SEGMENTS,
  AutoExecSettingsService,
  AutoExecState,
} from '../services/auto-exec-settings.service';

/**
 * Per-user auto-execution control surface (TDA-017). Authenticated (global
 * `JwtAuthGuard`) and scoped to the caller via `@CurrentUser('userId')`;
 * `AutoTradeConsent` is tenant-scoped by TDA-003.
 *
 *   GET   /api/me/auto-exec            both segments' control state (defaults if unset)
 *   PATCH /api/me/auto-exec/:segment   upsert the (userId, segment) controls
 *
 * SAFETY: enabling requires an accepted current disclosure (409 otherwise); the
 * kill switch is never gated (see {@link AutoExecSettingsService}). No orders
 * are placed and no broker credentials are touched here.
 */
@Controller('api/me/auto-exec')
export class MeAutoExecController {
  constructor(private readonly settings: AutoExecSettingsService) {}

  @Get()
  getAll(@CurrentUser('userId') userId: string): Promise<AutoExecState[]> {
    return this.settings.getForUser(userId);
  }

  @Patch(':segment')
  update(
    @CurrentUser('userId') userId: string,
    @Param('segment') segmentParam: string,
    @Body() dto: UpdateAutoExecDto,
  ): Promise<AutoExecState> {
    const segment = this.parseSegment(segmentParam);
    return this.settings.update(userId, segment, dto);
  }

  /** Reject anything that is not INTRADAY/SWING with 400 (case-insensitive). */
  private parseSegment(raw: string): Segment {
    const seg = raw?.toUpperCase() as Segment;
    if (!AUTO_EXEC_SEGMENTS.includes(seg)) {
      throw new BadRequestException(
        `Unknown segment '${raw}' — expected INTRADAY or SWING`,
      );
    }
    return seg;
  }
}
