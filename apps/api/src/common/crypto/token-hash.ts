import { createHash } from 'crypto';

/**
 * SHA-256 hex digest of a string (lowercase, 64 chars).
 *
 * The single helper for hashing opaque bearer secrets — refresh tokens and
 * email-verification / password-reset tokens — so only the digest is ever
 * persisted, never the raw token. AuthService and TokenService both use this
 * instead of rolling their own `createHash` call.
 *
 * NOTE: this is deliberately SEPARATE from `common/audit/canonicalize.ts`'s
 * `sha256`, which is scoped to the tamper-evident audit hash-chain and must not
 * be repurposed for token hashing.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
