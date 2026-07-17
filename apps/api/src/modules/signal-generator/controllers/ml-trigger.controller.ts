import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Post,
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Public } from '../../../common/decorators';
import { PatternBackfillService, type BackfillTarget } from '../ml/pattern-backfill.service';
import { PatternCaptureService } from '../ml/pattern-capture.service';
import { PatternScanService } from '../ml/pattern-scan.service';

/** Header carrying the shared secret. Configure it on the external heartbeat. */
export const ML_TRIGGER_SECRET_HEADER = 'x-ml-trigger-secret';

/**
 * External machine-to-machine ops triggers for the ML pattern-quality pipeline.
 *
 * These are driven by an external heartbeat (cron-job.org / UptimeRobot) rather
 * than an in-process @Cron: the free tier spins the service down when idle, so a
 * fixed-time in-process scheduler would simply never fire.
 *
 * A heartbeat cannot present a Bearer JWT, and parking a long-lived ADMIN JWT in
 * a third-party cron console is a credential-handling problem. So these live on
 * their own @Public() controller behind a scoped shared secret (ML_TRIGGER_SECRET)
 * checked in constant time. They are deliberately NOT on SignalGeneratorController,
 * whose class-level @AdminOnly() protects many admin/user routes.
 *
 * The secret arrives in the {@link ML_TRIGGER_SECRET_HEADER} header and NEVER in
 * the URL. A path secret (`/webhooks/ml/backfill/<secret>`) is logged verbatim by
 * anything that records request paths — the global LoggingInterceptor on success,
 * the global HttpExceptionFilter on every 401, and the platform's own access logs
 * beyond this process entirely. Since those logs ship to a third party and this
 * secret IS the whole auth boundary, the URL is the one place it must not go.
 * Mirrors RazorpayWebhookController, which authenticates on a header for the same
 * reason.
 *
 * Fails CLOSED: when ML_TRIGGER_SECRET is unset, every request is rejected.
 */
@Public()
@Controller('webhooks/ml')
export class MlTriggerController {
  private readonly logger = new Logger(MlTriggerController.name);

  constructor(
    private readonly config: ConfigService,
    // Optional so test wirings / non-ML containers still construct cleanly;
    // the triggers 503 when unwired.
    @Optional() private readonly patternBackfill?: PatternBackfillService,
    @Optional() private readonly patternCapture?: PatternCaptureService,
    @Optional() private readonly patternScan?: PatternScanService,
  ) {}

  /**
   * Reject unless `providedSecret` matches ML_TRIGGER_SECRET in constant time.
   * Fails closed when the env var is not configured. Never logs either secret —
   * only the provided length, which is not sensitive on its own.
   *
   * Takes `undefined` because a header, unlike the path param this replaced, can
   * simply be absent. Normalised to '' so an unauthenticated caller gets a clean
   * 401 instead of a 500 with a stack trace.
   */
  private assertAuthorized(providedSecret: string | undefined | null): void {
    const expected = this.config.get<string>('ML_TRIGGER_SECRET');
    if (!expected) {
      this.logger.warn('ML_TRIGGER_SECRET is not configured — rejecting all ML triggers');
      throw new UnauthorizedException();
    }
    const provided = providedSecret ?? '';
    if (!this.constantTimeEqual(provided, expected)) {
      this.logger.warn(`ML trigger auth failed (provided length=${provided.length})`);
      throw new UnauthorizedException();
    }
  }

  private constantTimeEqual(a: string, b: string): boolean {
    if (typeof a !== 'string' || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  /**
   * POST /webhooks/ml/backfill   (secret in the X-ML-Trigger-Secret header)
   *
   * Replay history for the given instruments, detect patterns, and persist the
   * labeled observations that train the ML pattern-quality scorer.
   *
   * ASYNCHRONOUS: returns 202 immediately and runs the pass detached. One pass
   * is ~527 serialized broker calls behind a 350ms gate (~5-7 min) because
   * sub-hour timeframes auto-chunk at 1 day each — far past the ~30-60s timeout
   * of the external heartbeats that drive this. Awaiting it meant the caller
   * ALWAYS timed out while the work continued server-side, and the next
   * heartbeat piled another run on top. Per-(target × timeframe) results go to
   * the logger, so a detached run stays observable.
   *
   * If a pass is already in flight this returns {accepted:false} rather than
   * starting or queueing a second one (the guard itself lives in the service).
   *
   * Body:
   *   { targets: [{token, exchange, symbol}], timeframes?: string[], lookbackDays?: number }
   *
   *   targets:     required, non-empty. Explicit by design — there is no
   *                instrument-universe lookup here.
   *   timeframes:  restrict the replay (e.g. ["15m"]). Default: all of
   *                BACKFILL_TIMEFRAMES.
   *   lookbackDays: override the per-timeframe default window.
   */
  @Post('backfill')
  @HttpCode(HttpStatus.ACCEPTED)
  // Deliberately `async` while never awaiting `run()`: the handler still
  // returns on its first tick (that IS the fix), but the validation throws
  // above surface as rejections rather than synchronous throws.
  async triggerPatternBackfill(
    @Headers(ML_TRIGGER_SECRET_HEADER) providedSecret: string | undefined,
    @Body() body: { targets?: BackfillTarget[]; timeframes?: string[]; lookbackDays?: number } = {},
  ) {
    this.assertAuthorized(providedSecret);
    if (!this.patternBackfill) {
      throw new ServiceUnavailableException('pattern backfill is not wired');
    }
    const targets = body.targets ?? [];
    if (targets.length === 0) {
      throw new BadRequestException('targets is required and must be non-empty');
    }
    for (const t of targets) {
      if (!t?.token || !t?.exchange || !t?.symbol) {
        throw new BadRequestException('each target needs token, exchange and symbol');
      }
    }
    // Report the refusal rather than silently no-op'ing. Checked before the
    // call (not from run()'s return) because the run is detached — its result
    // is never seen here. Race-free: run() flips the flag synchronously.
    if (this.patternBackfill.isRunning) {
      return {
        accepted: false,
        reason: 'a pattern backfill run is already in progress',
      };
    }
    // Fire-and-forget. The .catch() is REQUIRED: an unhandled rejection from a
    // detached promise can take the Node process down.
    void this.patternBackfill
      .run(targets, { timeframes: body.timeframes, lookbackDays: body.lookbackDays })
      .catch((err) =>
        this.logger.error(
          `pattern backfill run failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
    return { accepted: true, targets: targets.length };
  }

  /**
   * POST /webhooks/ml/resolve-pending   (secret in the X-ML-Trigger-Secret header)
   *
   * Finalize observations whose follow-through horizon has since completed:
   * re-fetches their bars, recomputes the outcome, and stamps WIN/LOSS/TIMEOUT.
   * Rows still inside their horizon are left PENDING for a later run.
   *
   * Synchronous and bounded — safe to await within a heartbeat's timeout.
   *
   * Body (all optional):
   *   { limit?: number }  — max PENDING rows to attempt. Default 200.
   */
  @Post('resolve-pending')
  @HttpCode(HttpStatus.OK)
  async triggerResolvePending(
    @Headers(ML_TRIGGER_SECRET_HEADER) providedSecret: string | undefined,
    @Body() body: { limit?: number } = {},
  ) {
    this.assertAuthorized(providedSecret);
    if (!this.patternCapture) {
      throw new ServiceUnavailableException('pattern capture is not wired');
    }
    const resolved = await this.patternCapture.resolvePending(body.limit);
    return { ok: true, resolved };
  }

  /**
   * POST /webhooks/ml/scan   (secret in the X-ML-Trigger-Secret header)
   *
   * Detect patterns at the LIVE EDGE for the given instruments and persist them
   * with full external context (MTF / S/R / sector). This is the only path that
   * produces richly-featured observations: the context services are as-of-now
   * only, so a pattern can be enriched without lookahead ONLY when its decision
   * bar is the latest bar — which is exactly what this scan keeps.
   *
   * Meant to run each bar-close from the external heartbeat. Synchronous and
   * bounded (one latest-bar pass over a modest watchlist), like resolve-pending —
   * keep the target list small enough to finish within the heartbeat's timeout.
   *
   * Body:
   *   { targets: [{token, exchange, symbol}], timeframes?: string[], lookbackDays?: number }
   */
  @Post('scan')
  @HttpCode(HttpStatus.OK)
  async triggerScan(
    @Headers(ML_TRIGGER_SECRET_HEADER) providedSecret: string | undefined,
    @Body() body: { targets?: BackfillTarget[]; timeframes?: string[]; lookbackDays?: number } = {},
  ) {
    this.assertAuthorized(providedSecret);
    if (!this.patternScan) {
      throw new ServiceUnavailableException('pattern scan is not wired');
    }
    const targets = body.targets ?? [];
    if (targets.length === 0) {
      throw new BadRequestException('targets is required and must be non-empty');
    }
    for (const t of targets) {
      if (!t?.token || !t?.exchange || !t?.symbol) {
        throw new BadRequestException('each target needs token, exchange and symbol');
      }
    }
    const results = await this.patternScan.scan(targets, {
      timeframes: body.timeframes,
      lookbackDays: body.lookbackDays,
    });
    return { ok: true, results };
  }
}
