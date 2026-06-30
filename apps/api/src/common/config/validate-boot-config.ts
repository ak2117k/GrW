/**
 * Boot-time configuration assertions (TDA-004).
 *
 * `validateBootConfig` is a PURE function of its `env` argument (defaulting to
 * `process.env`). It aggregates ALL configuration failures and throws a single
 * `BootConfigError` listing every one — it never fails on the first problem,
 * never calls `process.exit`, and never logs. The caller (main.ts, Task 5)
 * decides how to surface the error.
 */
export class BootConfigError extends Error {
  constructor(failures: string[]) {
    super(`Refusing to start — invalid configuration:\n  - ${failures.join('\n  - ')}`);
    this.name = 'BootConfigError';
  }
}

export function validateBootConfig(env: NodeJS.ProcessEnv = process.env): void {
  const fail: string[] = [];
  const need = (k: string) => { if (!env[k]) fail.push(`${k} is required but unset`); };

  need('JWT_SECRET'); need('ENCRYPTION_KEY'); need('DATABASE_URL');
  if (env.ENCRYPTION_KEY === 'td-automation-default-key-change-me')
    fail.push('ENCRYPTION_KEY is the public default sentinel — set a real key');

  if (env.NODE_ENV === 'production') {
    if (env.ENCRYPTION_KEY && env.ENCRYPTION_KEY.length < 32) fail.push('ENCRYPTION_KEY must be >= 32 chars in production');
    if (!env.WEB_ORIGIN) fail.push('WEB_ORIGIN is required in production (no localhost/wildcard CORS fallback)');
    if (env.DATABASE_URL && !/sslmode=(require|verify-full|verify-ca)/.test(env.DATABASE_URL))
      fail.push('DATABASE_URL must enforce TLS (sslmode=require) in production');
    if (!/^https:\/\//.test(env.AI_ENGINE_URL ?? '')) fail.push('AI_ENGINE_URL must be https in production');
    if (env.REDIS_TLS !== 'true') fail.push('REDIS_TLS must be "true" in production (ElastiCache in-transit encryption)');
    if (env.REDIS_THROTTLER !== 'true') fail.push('REDIS_THROTTLER must be "true" in production (durable cross-replica limits)');
  }
  if (fail.length) throw new BootConfigError(fail);
}
