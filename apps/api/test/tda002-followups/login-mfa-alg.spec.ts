/**
 * Roadmap §8 (TDA-002 follow-up), Task 3 — pin `algorithms: ['HS256']` on the
 * loginMfa JWT verification.
 *
 * The MFA-challenge token is HS256-signed with the same JWT_SECRET as the access
 * token; verifying it WITHOUT an explicit algorithm allowlist widens the attack
 * surface (algorithm-substitution). This unit test drives AuthService.loginMfa
 * with a mocked JwtService and asserts the verify call pins HS256 (and keeps the
 * td-mfa audience). No DB / env required — jwt is fully mocked.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-followups';

import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../../src/modules/auth/services/auth.service';

describe('loginMfa JWT verification hardening (Task 3)', () => {
  const makeAuth = (jwt: unknown): AuthService =>
    new AuthService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      jwt as never,
      {} as never,
    );

  it('verifies the MFA token with an explicit HS256 algorithm allowlist', async () => {
    const verify = jest.fn(() => {
      throw new Error('invalid signature');
    });
    const auth = makeAuth({ verify });

    await expect(auth.loginMfa('some.mfa.token', '123456', {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(verify).toHaveBeenCalledTimes(1);
    const options = verify.mock.calls[0][1] as {
      algorithms?: string[];
      audience?: string;
    };
    expect(options.algorithms).toEqual(['HS256']);
    expect(options.audience).toBe('td-mfa');
  });
});
