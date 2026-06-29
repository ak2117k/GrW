import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { TokenService } from '../../src/modules/auth/services/token.service';
import { db } from './test-prisma';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('TokenService (integration, td_saas_test)', () => {
  const JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda002';
  const jwt = new JwtService({ secret: JWT_SECRET });
  const svc = new TokenService(db, jwt);

  const ctx = { userAgent: 'jest-agent', ip: '10.0.0.7' };
  let user: { id: string; email: string; role: 'USER' | 'ADMIN' };

  beforeAll(async () => {
    const created = await db.user.create({
      data: {
        email: `tda002-token-${Date.now()}@example.com`,
        passwordHash: 'x',
        role: 'USER',
        status: 'ACTIVE',
      },
    });
    user = { id: created.id, email: created.email, role: 'USER' };
  });

  afterAll(async () => {
    await db.refreshToken.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await db.$disconnect();
  });

  it('issuePair returns a verifiable access JWT and a stored, hashed refresh token', async () => {
    const { accessToken, refreshToken } = await svc.issuePair(user, ctx);

    const payload = svc.verifyAccess(accessToken);
    expect(payload.sub).toBe(user.id);
    expect(payload.role).toBe(user.role);
    expect(payload.email).toBe(user.email);

    const row = await db.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
    });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(user.id);
    expect(row!.revokedAt).toBeNull();
    expect(row!.userAgent).toBe(ctx.userAgent);
    expect(row!.ip).toBe(ctx.ip);
    // raw token must never be stored
    const rawStored = await db.refreshToken.findFirst({
      where: { tokenHash: refreshToken },
    });
    expect(rawStored).toBeNull();
  });

  it('rotate issues a new pair, revokes the old token, and links replacedById', async () => {
    const first = await svc.issuePair(user, ctx);
    const oldHash = sha256(first.refreshToken);

    const rotated = await svc.rotate(first.refreshToken, ctx);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    const oldRow = await db.refreshToken.findUnique({ where: { tokenHash: oldHash } });
    const newRow = await db.refreshToken.findUnique({
      where: { tokenHash: sha256(rotated.refreshToken) },
    });
    expect(oldRow!.revokedAt).not.toBeNull();
    expect(newRow).not.toBeNull();
    expect(oldRow!.replacedById).toBe(newRow!.id);
    // same family lineage preserved
    expect(newRow!.familyId).toBe(oldRow!.familyId);

    // the new token still works
    const again = await svc.rotate(rotated.refreshToken, ctx);
    expect(again.accessToken).toBeTruthy();
  });

  it('reusing a rotated refresh token revokes the entire family', async () => {
    const { refreshToken } = await svc.issuePair(user, ctx);
    const familyId = (await db.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
    }))!.familyId;

    const rotated = await svc.rotate(refreshToken, ctx); // refreshToken now revoked

    // reuse of the already-rotated (revoked) token => throws + nukes family
    await expect(svc.rotate(refreshToken, ctx)).rejects.toThrow();

    // the most recent (still-valid) descendant is now revoked too
    await expect(svc.rotate(rotated.refreshToken, ctx)).rejects.toThrow();

    const familyRows = await db.refreshToken.findMany({ where: { familyId } });
    expect(familyRows.length).toBeGreaterThan(0);
    expect(familyRows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('rejects an unknown refresh token', async () => {
    await expect(svc.rotate('totally-unknown-token', ctx)).rejects.toThrow();
  });

  it('rejects an expired refresh token', async () => {
    const { refreshToken } = await svc.issuePair(user, ctx);
    await db.refreshToken.update({
      where: { tokenHash: sha256(refreshToken) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(svc.rotate(refreshToken, ctx)).rejects.toThrow();
  });

  it('revokeFamily revokes every live token in the family', async () => {
    const { refreshToken } = await svc.issuePair(user, ctx);
    const row = (await db.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
    }))!;

    await svc.revokeFamily(row.familyId);

    const rows = await db.refreshToken.findMany({ where: { familyId: row.familyId } });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    await expect(svc.rotate(refreshToken, ctx)).rejects.toThrow();
  });

  it('verifyAccess throws on a tampered/invalid access token', () => {
    expect(() => svc.verifyAccess('not.a.jwt')).toThrow();
  });

  it('verifyAccess rejects a token signed with a different secret', () => {
    const foreign = new JwtService({ secret: `${JWT_SECRET}-WRONG` });
    const forged = foreign.sign(
      { sub: user.id, role: user.role, email: user.email },
      { algorithm: 'HS256', expiresIn: '15m' },
    );
    expect(() => svc.verifyAccess(forged)).toThrow();
  });

  it('concurrent double-rotate: exactly one succeeds and the family is fully revoked', async () => {
    const { refreshToken } = await svc.issuePair(user, ctx);
    const familyId = (await db.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
    }))!.familyId;

    // Fire two rotations of the SAME token concurrently.
    const results = await Promise.allSettled([
      svc.rotate(refreshToken, ctx),
      svc.rotate(refreshToken, ctx),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // The loser's reuse handling revokes the whole lineage; the rolled-back
    // successor must not have leaked a live row either.
    const familyRows = await db.refreshToken.findMany({ where: { familyId } });
    expect(familyRows.every((r) => r.revokedAt !== null)).toBe(true);

    // And the winner's freshly minted token is now revoked too -> cannot rotate.
    const winner = fulfilled[0] as PromiseFulfilledResult<{ refreshToken: string }>;
    await expect(svc.rotate(winner.value.refreshToken, ctx)).rejects.toThrow();
  });
});
