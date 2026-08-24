import { Controller, Get, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOnly, Public } from '../../common/decorators';
import { HealthService, sessionContext } from './health.service';
import { unavailable, type HealthPayload } from './health.types';
import { HealthDetailService, type HealthDetailPayload } from './health-detail.service';

/**
 * Liveness + keep-warm + freshness endpoint (`GET /healthz`).
 *
 * Three jobs on the free-tier deploy:
 *
 *  1. **Keep-warm.** The external cron (.github/workflows/keep-warm.yml) pings
 *     this on a wide daily schedule so Render's web service rarely sleeps and
 *     real users don't hit a 30-90s cold start (the root cause of the bogus
 *     "unable to sign in" timeout).
 *  2. **Wake Neon.** The `SELECT 1` touches Postgres so the autosuspended Neon
 *     compute is warm too — otherwise the first *login* would still pay the DB
 *     wake-up cost even with the web dyno already up.
 *  3. **Report whether the platform can still SEE.** This is the part that was
 *     missing. The old body — `{"status":"ok","db":"ok","uptimeSec":9444}` —
 *     answered only "can I serve an HTTP request right now", and it answered
 *     `ok` continuously through an OOM crash loop that restarted the container
 *     every ~14 minutes, through an open option position whose price had been
 *     frozen for 21 hours for want of a feed subscription slot, and through a
 *     trade-sentinel that had never once executed in production. A probe blind
 *     to all three is not a health check. See {@link HealthService}.
 *
 * **Always HTTP 200, and `status` is always `ok`.** Not laziness — Render uses
 * this endpoint to decide whether to KILL the container. A check that returns
 * non-200 when the DB blinks turns a transient blip into a restart loop, and a
 * check that judged "stale candles = unhealthy" would fire every single night
 * at 02:00 IST, when stale candles are simply correct. So the payload reports
 * NUMBERS (ages in seconds) plus the market-session context needed to read
 * them, and leaves the verdict to alerting, which can be silenced overnight and
 * cannot restart anything.
 *
 * `GET /healthz` is unauthenticated and scraped by external monitors, so its
 * body carries no credentials, no connection strings and no user data — counts
 * and clocks only. Its sibling `GET /healthz/detail` is admin-only precisely
 * because its body DOES describe internals — job names and capacity numbers.
 * See {@link HealthDetailService}.
 */
@ApiTags('Health')
@Controller('healthz')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly health: HealthService,
    private readonly healthDetail: HealthDetailService,
  ) {}

  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness + keep-warm + platform freshness signals' })
  async check(): Promise<HealthPayload> {
    try {
      return await this.health.check();
    } catch (err) {
      // Belt and braces. HealthService is written so that every signal degrades
      // on its own and nothing rejects; if that contract is ever broken by a
      // future edit, the failure mode must still be a 200 with every signal
      // marked unavailable — never a 500, which Render would read as "kill it".
      // A collector bug is not a reason to restart a working container.
      const reason = err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
      this.logger.error(`Health collector threw, degrading whole payload: ${reason}`);
      const now = new Date();
      return {
        status: 'ok',
        db: 'error',
        uptimeSec: Math.round(process.uptime()),
        checkedAt: now.toISOString(),
        session: sessionContext(now),
        feed: unavailable(reason),
        lastCandleAt: unavailable(reason),
        lastTrackerUpdateAt: unavailable(reason),
        lastVerdictAt: unavailable(reason),
        openPositions: unavailable(reason),
      };
    }
  }

  /**
   * Admin-only detail: per-job last-run, process memory, feed slot pressure.
   *
   * Behind a role check because job names describe internals and slot counts
   * describe capacity. `/healthz` stays public precisely so this can be private.
   */
  @Get('detail')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin-only platform execution evidence' })
  async detail(): Promise<HealthDetailPayload> {
    return this.healthDetail.check();
  }
}
