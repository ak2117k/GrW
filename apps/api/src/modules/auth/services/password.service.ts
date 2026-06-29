import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * argon2id password hashing for user credentials.
 *
 * Params follow the TDA-002 security constraints (OWASP argon2id baseline,
 * tuned to ~50-100ms): memoryCost 19456 KiB, timeCost 2, parallelism 1.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordService {
  /** Hash a plaintext password into an argon2id PHC string. */
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON2_OPTIONS);
  }

  /**
   * Verify a plaintext password against a stored argon2id hash.
   *
   * Returns false (rather than throwing) on a malformed/unrecognised hash so
   * callers get a uniform, timing-safe boolean result and never leak which
   * branch failed.
   */
  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
