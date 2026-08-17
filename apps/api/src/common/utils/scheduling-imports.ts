import { ScheduleModule } from '@nestjs/schedule';
import { bootJobsEnabled } from './boot-jobs';

/**
 * `ScheduleModule.forRoot()`, or nothing when `BOOT_JOBS=false`.
 *
 * WHY THE WHOLE MODULE, rather than a `bootJobsEnabled()` guard inside each
 * `@Cron` method. `@Cron` schedules nothing unless this module is registered —
 * so leaving it out makes every cron in the application inert, today and for
 * every cron anyone adds later. A per-method guard is a rule someone has to
 * remember; this is a fact about the process.
 *
 * That distinction was not academic. A one-shot script booted the full
 * application against the PRODUCTION database, and although `BOOT_JOBS=false`
 * suppressed the `onModuleInit` work, the trade-tracker's `@Cron` kept firing —
 * reconciling live positions from a laptop, over a broker session that was
 * failing to authenticate. It closed tracker rows for positions still held,
 * orphaning the agent's verdicts and resetting each position's high-water marks.
 *
 * Lives here rather than in `app.module.ts` so it can be tested without pulling
 * the entire module graph into the test runner.
 */
export function schedulingImports() {
  return bootJobsEnabled() ? [ScheduleModule.forRoot()] : [];
}
