import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators';
import {
  ACCESS_TOKEN_AUDIENCE,
  AccessTokenPayload,
} from '../services/token.service';

/**
 * Passport JWT strategy for the stateless access token.
 *
 * Validates `Authorization: Bearer <jwt>` against `JWT_SECRET` (HS256) and maps
 * the verified payload to the principal exposed as `req.user`. Passport itself
 * rejects missing/expired/forged tokens with 401 before `validate` runs.
 *
 * Defense-in-depth against second-factor bypass: the short-lived MFA-challenge
 * token is HS256-signed with the SAME `JWT_SECRET`, so signature+expiry alone
 * would let `Bearer <mfaToken>` pass the global guard. We therefore (1) require
 * the `td-access` audience here (the MFA token carries `td-mfa`), so passport
 * rejects it before `validate`, and (2) belt-and-suspenders, reject any payload
 * lacking `role`/`email` (the MFA token has neither).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET as string,
      algorithms: ['HS256'],
      audience: ACCESS_TOKEN_AUDIENCE,
    });
  }

  validate(payload: AccessTokenPayload): AuthenticatedUser {
    if (!payload.role || !payload.email) {
      throw new UnauthorizedException('Not an access token');
    }
    return { userId: payload.sub, role: payload.role, email: payload.email };
  }
}
