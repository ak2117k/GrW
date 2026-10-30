import { Controller, Get, Query } from '@nestjs/common';
import { AdminOnly } from '../../../common/decorators';
import { SanityAuditService } from '../services/sanity-audit.service';

/**
 * /api/sanity-audit — read-only. Behind the global JwtAuthGuard and @AdminOnly(): the violations span
 * every tenant's trades.
 */
@Controller('api/sanity-audit')
export class SanityAuditController {
  constructor(private readonly service: SanityAuditService) {}

  /** Violations seen since `since` (ISO; default 7 days), optionally one `check` / `severity` (error | warn | known). */
  @AdminOnly()
  @Get('violations')
  violations(@Query('since') since?: string, @Query('check') check?: string, @Query('severity') severity?: string, @Query('limit') limit?: string) {
    return this.service.list({ since, check, severity, limit });
  }
}
