import { SetMetadata } from '@nestjs/common';

/**
 * Per-ACCOUNT rate limiting (TDA-004 Task 7).
 *
 * Marks a handler for the {@link AccountRateLimitGuard}, which keys a fixed
 * window on the normalised `req.body.email` (NOT the source IP) so credential
 * stuffing spread across many IPs against ONE account is still blocked. The
 * guard runs ALONGSIDE the per-IP `ThrottlerGuard`, not instead of it.
 */
export const ACCOUNT_RATE_LIMIT = 'account_rate_limit';

export interface AccountRateLimitOpts {
  /** Max attempts allowed within the window before a 429 is returned. */
  limit: number;
  /** Window length in milliseconds (fixed window, starts on the first hit). */
  ttl: number;
}

export const AccountRateLimit = (opts: AccountRateLimitOpts) =>
  SetMetadata(ACCOUNT_RATE_LIMIT, opts);
