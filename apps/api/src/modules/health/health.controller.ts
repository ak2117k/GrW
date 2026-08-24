import { Body, Controller, Get, HttpCode, HttpStatus, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, Public } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/decorators';
import { HealthService, sessionContext } from './health.service';
import { unavailable, type HealthPayload } from './health.types';
import { HealthDetailService, type HealthDetailPayload } from './health-detail.service';
import { ClientFeedReportDto } from './dto/client-feed-report.dto';

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
   * Dyno-warmth ping. Touches NOTHING — no database, no collector, no feed.
   *
   * Split from `GET /healthz` for one reason: cost. /healthz runs a `SELECT 1`
   * as a deliberate side effect, to wake the autosuspended Neon compute so the
   * first login does not pay the DB wake-up. Pinging that every 10 minutes for
   * 14 hours a day means Neon can never suspend, which burned roughly 420
   * compute-hours a month against a free allowance near 192.
   *
   * The two kinds of warmth are separable, and only one of them is expensive.
   * Render's cold start is 30-90s of Node boot; Neon's wake is about a second.
   * So the pinger keeps the dyno up by hitting this route, and the database is
   * allowed to sleep until somebody actually needs it. The first request after
   * an idle period pays ~1s of Neon wake, which is why the client timeout was
   * raised — see {@link HealthController.check} for the cold-start history.
   *
   * Synchronous and allocation-light on purpose: this is the cheapest possible
   * 200 the service can produce.
   */
  @Get('live')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness only — no database, for keep-warm pings' })
  live(): { status: 'ok'; uptimeSec: number } {
    return { status: 'ok', uptimeSec: Math.round(process.uptime()) };
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

  /**
   * Ingest a browser stall report.
   *
   * Authenticated but role-free -- any signed-in user. A JWT is required so
   * reports carry a user id and cannot be spammed anonymously; ADMIN is not,
   * because the users who SEE stalls are ordinary users.
   *
   * Returns 202 and never fails the caller: a rejected diagnostic must not
   * surface as an error in a UI that is already degraded.
   */
  @Post('client-report')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Record a client-observed feed stall' })
  async clientReport(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: ClientFeedReportDto,
  ): Promise<{ accepted: boolean }> {
    // `userId`, not `id` -- that is the field JwtStrategy.validate attaches.
    // Reading `.id` here type-checks against a loose annotation and silently
    // files every report as anonymous.
    return this.healthDetail.recordClientReport(user?.userId ?? null, body);
  }
}
