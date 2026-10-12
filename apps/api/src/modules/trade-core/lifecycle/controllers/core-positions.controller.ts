import { Body, Controller, Get, HttpCode, HttpStatus, Logger, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import { AuditService } from '../../../../common/audit/audit.service';
import { CurrentUser } from '../../../../common/decorators';
import { CoreLifecycleService } from '../core-lifecycle.service';
import { ExitPositionDto } from '../dto/core-position.dto';
import type { CorePosition } from '../lifecycle.types';

/** How far back closed positions are listed: a display window, not a risk value. */
const RECENT_CLOSED_MS = 7 * 86_400_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The caller's own core positions (ruling L18). Authenticated by the global JwtAuthGuard;
 * the user always comes from the token. A manual exit is never refused for rate (a safety
 * action, like the kill switch) and is audited; an audit failure never fails the exit.
 */
@ApiTags('Trade core: positions')
@Controller('api/trade-core/positions')
export class CorePositionsController {
  private readonly logger = new Logger(CorePositionsController.name);

  constructor(
    private readonly lifecycle: CoreLifecycleService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser('userId') userId: string): Promise<{ positions: CorePosition[] }> {
    return { positions: await this.lifecycle.positionsFor(userId, new Date(Date.now() - RECENT_CLOSED_MS)) };
  }

  @Post(':id/exit')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  async exit(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() dto: ExitPositionDto): Promise<{ position: CorePosition }> {
    const reason = dto.reason.trim();
    const position = await this.lifecycle.requestExit(userId, id, 'MANUAL', reason);
    try {
      await this.audit.append({ action: AUDIT_ACTIONS.lifecycle.CORE_POSITION_EXIT_REQUESTED, userId, target: `core_positions:${id}`, meta: { reason, status: position.status } });
    } catch (err) {
      this.logger.error(`CORE_POSITION_EXIT_REQUESTED audit failed for ${id} (the exit was requested): ${errorText(err)}`);
    }
    return { position };
  }
}
