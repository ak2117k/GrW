import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators';
import { NightReportService } from '../services/night-report.service';
import type { NightReport } from '../domain/night-report.types';

/**
 * GET /api/night-report: the morning page. Authenticated by the global
 * JwtAuthGuard and scoped to the caller via `@CurrentUser('userId')`.
 */
@Controller('api/night-report')
export class NightReportController {
  constructor(private readonly service: NightReportService) {}

  @Get()
  get(@CurrentUser('userId') userId: string): Promise<NightReport> {
    return this.service.build(userId);
  }
}
