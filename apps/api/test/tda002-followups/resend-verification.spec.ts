/**
 * Roadmap §8 (TDA-002 follow-up), Task 1 — POST /auth/resend-verification.
 *
 * Public, throttled, non-enumerating endpoint that re-mints an EMAIL_VERIFY
 * token for a PENDING_VERIFICATION user and re-sends the link. Proven here:
 *   - a pending user gets a fresh, usable verification token (200 + generic body);
 *   - that token verifies the account (ACTIVE);
 *   - resending for an already-verified account is a silent no-op (200 generic,
 *     no token echoed, no new EMAIL_VERIFY row);
 *   - an unknown email returns the identical response and creates no user;
 *   - an AUTH_EMAIL_VERIFY_RESENT audit row is written for the real resend.
 *
 * Setup mirrors test/tda008/auth-audit.spec.ts (Cls + Tenant + Audit + Auth) so
 * PrismaService (TDA-003) can resolve its TenantContextService dependency.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-followups';
process.env.EMAIL_TRANSPORT = 'console';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { ClsModule } from 'nestjs-cls';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { TenantModule } from '../../src/common/tenant/tenant.module';
import { AuditModule } from '../../src/common/audit/audit.module';
import { db } from './test-prisma';

interface HttpResult {
  status: number;
  body: any;
}

describe('POST /auth/resend-verification (integration, Task 1)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const email = `tda002fu-resend-${Date.now()}@example.com`;
  const unknownEmail = `tda002fu-ghost-${Date.now()}@example.com`;
  const password = 'Sup3r-Str0ng-Pass!';

  const call = async (
    method: string,
    path: string,
    opts: { body?: unknown } = {},
  ): Promise<HttpResult> => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        TenantModule,
        AuditModule,
        AuthModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    // Seed a freshly-signed-up, still-PENDING user via the real endpoint.
    await call('POST', '/auth/signup', { body: { email, password } });
  });

  afterAll(async () => {
    const user = await db.user.findUnique({ where: { email } });
    if (user) {
      await db.refreshToken.deleteMany({ where: { userId: user.id } });
      await db.verificationToken.deleteMany({ where: { userId: user.id } });
      await db.auditLog.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
    if (app) await app.close();
    await db.$disconnect();
  });

  it('re-sends a usable EMAIL_VERIFY token for a PENDING user (200, generic)', async () => {
    const res = await call('POST', '/auth/resend-verification', {
      body: { email },
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.message).toBe('string');
    // test-only seam echoes the raw token for a real, pending user
    expect(typeof res.body.verificationToken).toBe('string');

    // the freshly minted token actually verifies the account
    const verify = await call('POST', '/auth/verify-email', {
      body: { token: res.body.verificationToken },
    });
    expect(verify.status).toBe(200);
    const user = await db.user.findUnique({ where: { email } });
    expect(user!.status).toBe('ACTIVE');

    const audit = await db.auditLog.findFirst({
      where: { userId: user!.id, action: 'AUTH_EMAIL_VERIFY_RESENT' },
    });
    expect(audit).not.toBeNull();
  });

  it('is a silent no-op once the account is already verified', async () => {
    const before = await db.user.findUnique({ where: { email } });
    const tokensBefore = await db.verificationToken.count({
      where: { userId: before!.id, type: 'EMAIL_VERIFY' },
    });

    const res = await call('POST', '/auth/resend-verification', {
      body: { email },
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.message).toBe('string');
    // no token is minted/echoed for an already-verified account
    expect(res.body.verificationToken).toBeUndefined();

    const tokensAfter = await db.verificationToken.count({
      where: { userId: before!.id, type: 'EMAIL_VERIFY' },
    });
    expect(tokensAfter).toBe(tokensBefore);
  });

  it('returns the same generic response for an unknown email (no enumeration)', async () => {
    const known = await call('POST', '/auth/resend-verification', {
      body: { email },
    });
    const unknown = await call('POST', '/auth/resend-verification', {
      body: { email: unknownEmail },
    });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body.message).toBe(known.body.message);
    expect(unknown.body.verificationToken).toBeUndefined();

    const ghost = await db.user.findUnique({ where: { email: unknownEmail } });
    expect(ghost).toBeNull();
  });

  it('rejects a malformed email at the validation boundary (400)', async () => {
    const res = await call('POST', '/auth/resend-verification', {
      body: { email: 'not-an-email' },
    });
    expect(res.status).toBe(400);
  });
});
