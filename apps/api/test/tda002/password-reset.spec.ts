/**
 * TDA-002 Task 6 — password reset + rate limiting integration tests
 * (real td_saas_test DB).
 *
 * Bootstraps the same focused Nest app as the other TDA-002 specs (AuthModule
 * only, with the global JwtAuthGuard + the ThrottlerModule/ThrottlerGuard wired
 * for the sensitive auth routes) and exercises:
 *   - forgot-password is non-enumerating (200 + identical body for a known and
 *     an unknown email),
 *   - reset-password sets a new hash and revokes ALL existing refresh tokens
 *     (an old refresh token is 401 afterwards; the old password no longer logs
 *     in; the new one does),
 *   - the login route returns 429 once the per-window burst is exceeded.
 *
 * Test-only seam: `POST /auth/password/forgot` echoes the raw PASSWORD_RESET
 * token in its response body ONLY when `process.env.NODE_ENV === 'test'` AND the
 * email belongs to a real user — mirroring the signup seam. Production never
 * returns it (delivered solely by email; only its sha256 is persisted).
 */

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda002';
process.env.EMAIL_TRANSPORT = 'console';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { db } from './test-prisma';

interface HttpResult {
  status: number;
  body: any;
}

describe('Password reset + rate limiting (integration, td_saas_test)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const email = `tda002-reset-${Date.now()}@example.com`;
  const unknownEmail = `tda002-nobody-${Date.now()}@example.com`;
  const oldPassword = 'Old-Str0ng-Pass!';
  const newPassword = 'New-Str0nger-Pass!';
  let oldRefreshToken: string;

  const call = async (
    method: string,
    path: string,
    opts: { body?: unknown; token?: string } = {},
  ): Promise<HttpResult> => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Seed a verified, ACTIVE user via the real endpoints.
    const signup = await call('POST', '/auth/signup', {
      body: { email, password: oldPassword },
    });
    await call('POST', '/auth/verify-email', {
      body: { token: signup.body.verificationToken },
    });
    const login = await call('POST', '/auth/login', {
      body: { email, password: oldPassword },
    });
    oldRefreshToken = login.body.refreshToken;
  });

  afterAll(async () => {
    const user = await db.user.findUnique({ where: { email } });
    if (user) {
      await db.refreshToken.deleteMany({ where: { userId: user.id } });
      await db.verificationToken.deleteMany({ where: { userId: user.id } });
      await db.auditLog.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    }
    await db.auditLog
      .deleteMany({ where: { action: 'AUTH_LOGIN_FAILED', target: email } })
      .catch(() => undefined);
    if (app) await app.close();
    await db.$disconnect();
  });

  let resetToken: string;

  it('forgot-password returns 200 + a generic body for a KNOWN email', async () => {
    const res = await call('POST', '/auth/password/forgot', { body: { email } });
    expect(res.status).toBe(200);
    expect(typeof res.body.message).toBe('string');
    // test-only seam exposes the raw token for a real user
    expect(typeof res.body.resetToken).toBe('string');
    resetToken = res.body.resetToken;

    const user = await db.user.findUnique({ where: { email } });
    const token = await db.verificationToken.findFirst({
      where: { userId: user!.id, type: 'PASSWORD_RESET' },
    });
    expect(token).not.toBeNull();
  });

  it('forgot-password returns 200 + the SAME body for an UNKNOWN email (no enumeration)', async () => {
    const known = await call('POST', '/auth/password/forgot', { body: { email } });
    const unknown = await call('POST', '/auth/password/forgot', {
      body: { email: unknownEmail },
    });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body.message).toBe(known.body.message);
    // The unknown email must NOT leak a token (would reveal non-existence).
    expect(unknown.body.resetToken).toBeUndefined();
    // and creates no user/token rows
    const ghost = await db.user.findUnique({ where: { email: unknownEmail } });
    expect(ghost).toBeNull();
  });

  it('reset-password sets a new hash, revokes all refresh tokens, and audits', async () => {
    const res = await call('POST', '/auth/password/reset', {
      body: { token: resetToken, password: newPassword },
    });
    expect(res.status).toBe(200);

    // old refresh token is now dead (all sessions revoked)
    const reuse = await call('POST', '/auth/refresh', {
      body: { refreshToken: oldRefreshToken },
    });
    expect(reuse.status).toBe(401);

    // old password no longer works
    const oldLogin = await call('POST', '/auth/login', {
      body: { email, password: oldPassword },
    });
    expect(oldLogin.status).toBe(401);

    // new password works
    const newLogin = await call('POST', '/auth/login', {
      body: { email, password: newPassword },
    });
    expect(newLogin.status).toBe(200);
    expect(typeof newLogin.body.accessToken).toBe('string');

    const user = await db.user.findUnique({ where: { email } });
    const audit = await db.auditLog.findFirst({
      where: { userId: user!.id, action: 'AUTH_PASSWORD_RESET' },
    });
    expect(audit).not.toBeNull();
  });

  it('a used reset token cannot be replayed', async () => {
    const res = await call('POST', '/auth/password/reset', {
      body: { token: resetToken, password: 'Another-Pass-99!' },
    });
    expect(res.status).toBe(401);
  });

  it('login returns 429 once the per-window burst is exceeded (throttler)', async () => {
    // Limit is 10/60s; fire enough wrong-password attempts to trip the limiter.
    // (Earlier tests already consumed part of the window for this app instance,
    // so the burst trips no later than the configured limit.)
    let saw429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await call('POST', '/auth/login', {
        body: { email, password: 'definitely-wrong' },
      });
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});
