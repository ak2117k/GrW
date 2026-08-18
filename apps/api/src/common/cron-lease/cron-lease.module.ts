import { Global, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { CRON_LEASE_REDIS, createCronLeaseRedis, cronLeaseEnabled } from './cron-lease.redis';
import { CronLeaseService } from './cron-lease.service';

/**
 * Provides {@link CronLeaseService} to every module that owns scheduled work.
 *
 * `@Global` because the ~47 `@Cron`/`@Interval` jobs are spread across most of
 * the feature modules; requiring each of them to import this module is the kind
 * of friction that ends with someone shipping an unleased job.
 *
 * ONE client for all leases. The factory is a singleton provider, so every job
 * shares a single connection rather than opening a pool per module — Redis
 * connection count is a real limit on the managed/free tiers this runs on, and
 * a lease is a handful of tiny commands per minute, nowhere near needing more.
 */
@Global()
@Module({
  providers: [
    { provide: CRON_LEASE_REDIS, useFactory: createCronLeaseRedis },
    CronLeaseService,
  ],
  exports: [CronLeaseService],
})
export class CronLeaseModule implements OnModuleInit {
  private readonly logger = new Logger(CronLeaseModule.name);

  /**
   * SAY SO, LOUDLY, WHEN LEASING IS INERT IN PRODUCTION.
   *
   * Default-off is the right call for dev and CI — see `cronLeaseEnabled` — but
   * a safety mechanism that is built, tested, merged and then silently does
   * nothing is the exact failure this project has already paid for twice: the
   * trade sentinel sat behind an unset flag and never ran once in production
   * while two days went into improving it, and five services' `onModuleDestroy`
   * hooks were written, unit-tested and never invoked because nobody called
   * `enableShutdownHooks()`. In both cases the code was correct and the system
   * was quiet, which is the worst combination there is.
   *
   * So the flag stays off by default and production is told, every boot, that it
   * is off. An operator who meant it can ignore one line; an operator who forgot
   * gets the only warning that would ever have reached them.
   */
  onModuleInit(): void {
    if (cronLeaseEnabled()) return;
    const message =
      'cron leasing is DISABLED (CRON_LEASE_ENABLED is not "true"), so every scheduled job ' +
      'runs unleased. On a single instance that is harmless. With two — a scale-up, or the ' +
      'ordinary overlapping-container deploy where the old and new containers run together ' +
      'for a minute — every job double-runs: two broker reconciles, two instrument-master ' +
      'refreshes, two sentinel cycles per user, and double spend against both the broker rate ' +
      'limit and a metered LLM API.';
    if (process.env.NODE_ENV === 'production') {
      // Error level in production specifically: this is the one environment
      // where a second container is not hypothetical.
      this.logger.error(message);
      return;
    }
    this.logger.log(message);
  }
}
