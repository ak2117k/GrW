import { Controller, Get } from '@nestjs/common';
import type { PreOpenOutlook } from '../domain/outlook';
import { PreOpenOutlookService, type RunResult } from '../services/pre-open-outlook.service';

/**
 * GET /api/pre-open-outlook      — the newest stored outlook per underlying (last 24 h).
 * GET /api/pre-open-outlook/run  — compute now (live Yahoo / market-cues reads), store, return. Sends
 *                                  no Telegram alert (only the 08:30 cron does). Places nothing.
 * Authenticated by the global JwtAuthGuard.
 */
@Controller('api/pre-open-outlook')
export class PreOpenOutlookController {
  constructor(private readonly service: PreOpenOutlookService) {}

  @Get()
  latest(): Promise<PreOpenOutlook[]> {
    return this.service.latest(new Date());
  }

  @Get('run')
  run(): Promise<RunResult> {
    return this.service.run(new Date(), { alert: false });
  }
}
