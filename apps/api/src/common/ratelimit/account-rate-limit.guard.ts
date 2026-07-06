import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ACCOUNT_RATE_LIMIT,
  AccountRateLimitOpts,
} from './account-rate-limit.decorator';
import { RATE_LIMIT_STORE, RateLimitStore } from './rate-limit-store.interface';

/**
 * Per-ACCOUNT brute-force guard (TDA-004 Task 7).
 *
 * Reads the {@link AccountRateLimit} metadata on the handler and counts hits in
 * a fixed window keyed on `acct:<route>:<normalised-email>` via the shared
 * {@link RateLimitStore} (Task 6) — so the limit holds across replicas when the
 * store is Redis-backed. The (limit+1)th hit for an account yields HTTP 429.
 *
 * No-enumeration: the 429 is IDENTICAL whether or not the email maps to a real
 * account (the count is incremented before any account lookup ever happens). An
 * empty/missing email passes through untouched — the body-validation pipe owns
 * the resulting 400, and there is nothing to key a per-account window on.
 */
@Injectable()
export class AccountRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(AccountRateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.get<AccountRateLimitOpts>(
      ACCOUNT_RATE_LIMIT,
      ctx.getHandler(),
    );
    if (!opts) return true;

    const req = ctx.switchToHttp().getRequest();
    const email = String(req.body?.email ?? '')
      .trim()
      .toLowerCase();
    if (!email) return true; // body validation will 400; nothing to key on

    const route = req.route?.path ?? req.url;

    // FAIL OPEN: a rate-limiter is a protective control, so if the store itself
    // is unavailable (e.g. Redis unreachable) we must NOT take auth down with it.
    // The Redis-backed store's ioredis calls reject when Redis is down; swallow
    // that and allow the request (brute-force protection is degraded until the
    // store recovers). MemoryRateLimitStore never throws, so this only trips for
    // the Redis path.
    let count: number;
    try {
      ({ count } = await this.store.hit(`acct:${route}:${email}`, opts.ttl));
    } catch (err) {
      this.logger.warn(
        `Rate-limit store unavailable — failing open for ${route}: ` +
        `${err instanceof Error ? err.message : err}`,
      );
      return true;
    }

    if (count > opts.limit) {
      throw new HttpException(
        'Too many attempts for this account. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
