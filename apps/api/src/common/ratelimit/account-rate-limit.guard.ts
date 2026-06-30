import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
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
    const { count } = await this.store.hit(`acct:${route}:${email}`, opts.ttl);
    if (count > opts.limit) {
      throw new HttpException(
        'Too many attempts for this account. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
