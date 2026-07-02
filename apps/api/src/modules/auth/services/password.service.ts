import { BadRequestException, Injectable } from '@nestjs/common';
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

/** Minimum accepted password length (defense-in-depth alongside the DTO). */
const MIN_PASSWORD_LENGTH = 8;

/** Maximum accepted length — bounds argon2 cost / DoS surface. */
const MAX_PASSWORD_LENGTH = 128;

/**
 * Minimum distinct character classes (of: lowercase, uppercase, digit, symbol)
 * a password must span. Three-of-four is a pragmatic complexity baseline that
 * rejects trivially weak inputs without demanding a specific fixed composition.
 */
const MIN_CHARACTER_CLASSES = 3;

const CHARACTER_CLASSES: RegExp[] = [
  /[a-z]/, // lowercase
  /[A-Z]/, // uppercase
  /[0-9]/, // digit
  /[^A-Za-z0-9]/, // symbol / other
];

@Injectable()
export class PasswordService {
  /** Hash a plaintext password into an argon2id PHC string. */
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON2_OPTIONS);
  }

  /**
   * Reject weak passwords at signup / reset. Enforces a length band plus a
   * minimum character-class spread (see {@link MIN_CHARACTER_CLASSES}). Throws
   * {@link BadRequestException} listing every failed rule; returns void when the
   * password is acceptable.
   *
   * Independent of any account lookup, so callers can invoke it before touching
   * the database without leaking whether an email exists (no enumeration).
   */
  assertStrength(plain: string): void {
    const failures: string[] = [];

    if (plain.length < MIN_PASSWORD_LENGTH) {
      failures.push(`be at least ${MIN_PASSWORD_LENGTH} characters long`);
    }
    if (plain.length > MAX_PASSWORD_LENGTH) {
      failures.push(`be at most ${MAX_PASSWORD_LENGTH} characters long`);
    }

    const classes = CHARACTER_CLASSES.filter((re) => re.test(plain)).length;
    if (classes < MIN_CHARACTER_CLASSES) {
      failures.push(
        `include at least ${MIN_CHARACTER_CLASSES} of: lowercase letters, ` +
          `uppercase letters, digits, and symbols`,
      );
    }

    if (failures.length > 0) {
      throw new BadRequestException(
        `Password is too weak: it must ${failures.join('; ')}.`,
      );
    }
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
