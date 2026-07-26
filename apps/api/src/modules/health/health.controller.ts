import { Controller, Get, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Liveness + keep-warm endpoint (`GET /healthz`).
 *
 * Purpose is twofold on the free-tier deploy:
 *  1. **Keep-warm.** The external cron (.github/workflows/keep-warm.yml) pings
 *     this on a wide daily schedule so Render's web service rarely sleeps and
 *     real users don't hit a 30-90s cold start (the root cause of the bogus
 *     "unable to sign in" timeout).
 *  2. **Wake Neon.** The `SELECT 1` touches Postgres so the autosuspended Neon
 *     compute is warm too — otherwise the first *login* would still pay the DB
 *     wake-up cost even with the web dyno already up.
 *
 * Always returns 200 so the keep-warm cron never false-alarms: its job is to
 * wake the stack, not to page on a DB blip. The body reports the DB status
 * (`ok` | `error`) for anyone who wants to read it.
 */
@ApiTags('Health')
@Public()
@Controller('healthz')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe + keep-warm (pings the DB)' })
  async check(): Promise<{ status: 'ok'; db: 'ok' | 'error'; uptimeSec: number }> {
    let db: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      db = 'error';
      this.logger.warn(`Health DB ping failed: ${(err as Error).message}`);
    }
    return { status: 'ok', db, uptimeSec: Math.round(process.uptime()) };
  }
}
