import { Logger } from '@nestjs/common';

/**
 * DI token for the lease's Redis handle. Nullable on purpose — see
 * {@link cronLeaseEnabled}.
 */
export const CRON_LEASE_REDIS = 'CRON_LEASE_REDIS';

/**
 * The two commands a lease needs, and nothing else.
 *
 * Narrow on purpose: the service is trivially mockable in tests without pulling
 * a real ioredis (or a live server) into the unit-test path, and an ioredis
 * client satisfies it structurally, so the production wiring passes the real
 * client straight in.
 */
export interface LeaseRedis {
  set(
    key: string,
    value: string,
    px: 'PX',
    ttlMs: number,
    nx: 'NX',
  ): Promise<'OK' | null>;
  eval(
    script: string,
    numKeys: number,
    key: string,
    token: string,
  ): Promise<unknown>;
}

/**
 * Whether cron leasing is active. OFF unless explicitly switched on, mirroring
 * `REDIS_THROTTLER` in common/ratelimit/redis.provider.ts.
 *
 * Default-off is the safe default HERE specifically because a lease that cannot
 * reach Redis on a laptop would otherwise make every fail-closed job silently
 * stop running in dev and CI — a developer would see scheduled work vanish with
 * no error, which is a far more expensive failure than the one leasing prevents
 * on a single-instance box (there is no second instance to collide with).
 *
 * PRODUCTION MUST SET `CRON_LEASE_ENABLED=true`. Without it, a scale-up to two
 * Render instances — or the ordinary overlapping-container deploy, where the old
 * and new containers run at the same time for a minute or two — double-runs
 * every scheduled job: two broker reconciles, two instrument-master refreshes,
 * two sentinel cycles per user, double spend against Angel One's 10 req/sec
 * budget and double spend against a metered LLM API.
 */
export function cronLeaseEnabled(): boolean {
  return process.env.CRON_LEASE_ENABLED === 'true';
}

/**
 * Builds the lease's Redis handle, or `null` when leasing is switched off.
 *
 * Connection options are deliberately IDENTICAL to the rate-limit store's
 * factory in auth.module.ts and to `redis.*` in config/configuration.ts — this
 * deployment reaches Redis by REDIS_HOST/REDIS_PORT/REDIS_PASSWORD (there is no
 * REDIS_URL), with `REDIS_TLS=false` on Render's private network. Anything that
 * connects differently works locally and then fails only in production.
 *
 * `enableOfflineQueue: false` + `maxRetriesPerRequest: 1` matter more here than
 * anywhere else: an offline queue would make an unreachable Redis HANG the
 * acquire for tens of seconds instead of rejecting, so the job would neither run
 * nor skip — it would just sit there, and every subsequent tick would pile up
 * behind it. We want a fast rejection so the caller's declared failure mode
 * (run-anyway / skip) actually takes effect at the scheduled instant.
 */
export function createCronLeaseRedis(): LeaseRedis | null {
  if (!cronLeaseEnabled()) return null;

  // Lazy require keeps ioredis entirely out of the dev/test path, matching the
  // rate-limit factory. A top-level import would load the driver in every unit
  // test that touches this module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Redis = require('ioredis');
  const client = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    family: process.env.REDIS_FAMILY ? parseInt(process.env.REDIS_FAMILY, 10) : undefined,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
  });

  // Without a handler, ioredis re-emits a transient connection blip as an
  // unhandled 'error' event, which takes the whole process down — i.e. a Redis
  // hiccup would kill the API rather than degrade one lease.
  client.on('error', (err: Error) =>
    new Logger('CronLeaseRedis').warn(`Redis error: ${err.message}`),
  );

  return client as LeaseRedis;
}
