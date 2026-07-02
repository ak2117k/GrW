import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, PrismaClient, RefreshToken } from '@prisma/client';
import { randomBytes } from 'crypto';
import { sha256Hex } from '../../../common/crypto/token-hash';

/** Access token TTL (short-lived, carried in memory by clients). */
const ACCESS_TTL = '15m';
/** Refresh token signing/verification algorithm (symmetric HMAC). */
const JWT_ALGORITHM = 'HS256';
/**
 * Audience claim scoping a token to the session/access path. Because access
 * tokens and the short-lived MFA-challenge token are both HS256-signed with the
 * same `JWT_SECRET`, they MUST be distinguished by audience: the global guard's
 * passport-jwt strategy requires `td-access`, so an `td-mfa` challenge token can
 * never be replayed as a Bearer access token (and vice-versa).
 */
export const ACCESS_TOKEN_AUDIENCE = 'td-access';
/** Refresh token TTL: 30 days. */
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Internal sentinel: the guarded compare-and-set in `rotate` lost the race
 * (the presented token was concurrently rotated or already revoked). Carries
 * the familyId so the catch handler can revoke the whole lineage and roll the
 * just-created successor back.
 */
class RotationConflictError extends Error {
  constructor(readonly familyId: string) {
    super('Refresh token rotation conflict');
  }
}

/**
 * Thrown when a presented refresh token was already rotated/revoked — i.e. token
 * reuse, treated as theft (the whole family is revoked before this throws).
 * Extends `UnauthorizedException` so it still maps to HTTP 401, while letting
 * callers (e.g. `AuthService.refresh`) detect reuse by type rather than by
 * matching the error message.
 */
export class RefreshReuseError extends UnauthorizedException {
  constructor() {
    super('Refresh token reuse detected');
  }
}

export interface AccessTokenPayload {
  sub: string;
  role: string;
  email: string;
}

/** Minimal user shape needed to mint tokens. */
export interface AuthUser {
  id: string;
  role: string;
  email: string;
}

/** Request context persisted on the refresh token row for auditing/forensics. */
export interface TokenContext {
  userAgent?: string;
  ip?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Issues stateless access JWTs and rotating, hashed refresh tokens with
 * family-based reuse detection.
 *
 * Refresh tokens are opaque random strings; only their sha256 hash is stored.
 * Each lineage shares a `familyId`; rotating consumes the presented token and
 * mints a successor in the same family. Presenting an already-revoked token is
 * treated as theft and revokes the entire family.
 *
 * Constructor takes a PrismaClient and a JwtService so the service is directly
 * instantiable in unit/integration tests; the NestJS module wiring (global
 * guard, JwtModule) is added in a later task.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly jwt: JwtService,
  ) {}

  private signAccess(user: AuthUser): string {
    const payload: AccessTokenPayload = {
      sub: user.id,
      role: user.role,
      email: user.email,
    };
    return this.jwt.sign(payload, {
      secret: process.env.JWT_SECRET,
      expiresIn: ACCESS_TTL,
      algorithm: JWT_ALGORITHM,
      audience: ACCESS_TOKEN_AUDIENCE,
    });
  }

  /** Verify and decode an access token. Throws if invalid/expired/wrong aud. */
  verifyAccess(token: string): AccessTokenPayload {
    return this.jwt.verify<AccessTokenPayload>(token, {
      secret: process.env.JWT_SECRET,
      algorithms: [JWT_ALGORITHM],
      audience: ACCESS_TOKEN_AUDIENCE,
    });
  }

  /**
   * Create + persist a new refresh token row, returning the opaque token.
   *
   * Accepts a Prisma client/transaction client so it can participate in the
   * `rotate` transaction (PrismaClient is assignable to TransactionClient).
   */
  private async createRefresh(
    client: Prisma.TransactionClient,
    userId: string,
    familyId: string,
    ctx: TokenContext,
  ): Promise<{ opaque: string; row: RefreshToken }> {
    const opaque = randomBytes(32).toString('base64url');
    const row = await client.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256Hex(opaque),
        familyId,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        userAgent: ctx.userAgent ?? null,
        ip: ctx.ip ?? null,
      },
    });
    return { opaque, row };
  }

  /**
   * Issue a fresh access + refresh pair, starting a NEW refresh-token family.
   * The caller receives the opaque refresh token; only its hash is stored.
   */
  async issuePair(user: AuthUser, ctx: TokenContext = {}): Promise<TokenPair> {
    const familyId = randomBytes(16).toString('hex');
    const { opaque } = await this.createRefresh(
      this.prisma,
      user.id,
      familyId,
      ctx,
    );
    return { accessToken: this.signAccess(user), refreshToken: opaque };
  }

  /**
   * Rotate a presented refresh token.
   *
   * - unknown token            -> reject
   * - already revoked (reuse)  -> revoke the whole family, then reject (theft)
   * - expired                  -> reject
   * - otherwise                -> mint a successor in the SAME family, mark the
   *                               presented token revoked + replacedById, return
   *                               the new pair.
   *
   * The mint-successor + revoke-old pair runs inside a single `$transaction`
   * with a guarded compare-and-set: the revoke is an `updateMany` scoped to
   * `revokedAt: null`. If it matches 0 rows a concurrent rotation already
   * consumed the token, so the transaction throws (rolling the just-created
   * successor back) and the family is revoked — closing both the crash window
   * and the concurrent double-rotate race that a bare `$transaction` (Read
   * Committed) would leave open.
   */
  async rotate(refreshToken: string, ctx: TokenContext = {}): Promise<TokenPair> {
    const tokenHash = sha256Hex(refreshToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.revokedAt) {
      // Reuse of a rotated token => assume the lineage is compromised.
      await this.revokeFamily(existing.familyId);
      throw new RefreshReuseError();
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: existing.userId },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    let opaque: string;
    try {
      opaque = await this.prisma.$transaction(async (tx) => {
        const created = await this.createRefresh(
          tx,
          user.id,
          existing.familyId,
          ctx,
        );
        // Guarded compare-and-set: only revoke if still live. Concurrent
        // rotations / reuse race here; exactly one updateMany matches the row.
        const revoked = await tx.refreshToken.updateMany({
          where: { id: existing.id, revokedAt: null },
          data: { revokedAt: new Date(), replacedById: created.row.id },
        });
        if (revoked.count !== 1) {
          // Lost the race -> throw to roll back the successor we just created.
          throw new RotationConflictError(existing.familyId);
        }
        return created.opaque;
      });
    } catch (err) {
      if (err instanceof RotationConflictError) {
        // Treat the concurrent rotation as a compromised lineage.
        await this.revokeFamily(err.familyId);
        throw new RefreshReuseError();
      }
      throw err;
    }

    return {
      accessToken: this.signAccess({
        id: user.id,
        role: user.role,
        email: user.email,
      }),
      refreshToken: opaque,
    };
  }

  /** Revoke every still-live refresh token in a family (logout / reuse). */
  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
