/**
 * TDA-002 Task 4 — auth core integration tests (real td_saas_test DB).
 *
 * Bootstraps a MINIMAL Nest application that imports only `AuthModule` (which
 * registers `JwtAuthGuard` as a global `APP_GUARD`). The full `AppModule` pulls
 * in Redis/Bull, websockets and every trading module, so a focused module keeps
 * the test fast while still exercising the real global-guard wiring.
 *
 * Test-only seam: `POST /auth/signup` echoes the raw email-verification token in
 * its response body ONLY when `process.env.NODE_ENV === 'test'` (Jest sets this).
 * Production never returns it — the token is delivered solely by email. Without
 * the seam the raw token is unrecoverable (only its sha256 is persisted).
 */

// Point the Nest app's PrismaService at the throw-away test DB BEFORE the app
// (and its PrismaClient) is constructed.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda002';
process.env.EMAIL_TRANSPORT = 'console';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { PasswordService } from '../../src/modules/auth/services/password.service';
import { db } from './test-prisma';

interface HttpResult {
  status: number;
  body: any;
}

describe('Auth core (integration, td_saas_test)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let passwords: PasswordService;
  const email = `tda002-auth-${Date.now()}@example.com`;
  const password = 'Sup3r-Str0ng-Pass!';

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
    passwords = moduleRef.get(PasswordService);
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
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

  let verificationToken: string;

  it('signup creates a PENDING_VERIFICATION user and returns a generic message', async () => {
    const res = await call('POST', '/auth/signup', {
      body: { email, password },
    });
    expect(res.status).toBe(201);
    expect(typeof res.body.message).toBe('string');
    // test-only seam
    expect(typeof res.body.verificationToken).toBe('string');
    verificationToken = res.body.verificationToken;

    const user = await db.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user!.status).toBe('PENDING_VERIFICATION');
    expect(user!.emailVerifiedAt).toBeNull();
    expect(user!.passwordHash).not.toBe(password);

    const audit = await db.auditLog.findFirst({
      where: { userId: user!.id, action: 'AUTH_SIGNUP' },
    });
    expect(audit).not.toBeNull();
  });

  it('cannot login until the email is verified', async () => {
    const res = await call('POST', '/auth/login', { body: { email, password } });
    expect(res.status).toBe(401);
  });

  it('verify-email activates the account', async () => {
    const res = await call('POST', '/auth/verify-email', {
      body: { token: verificationToken },
    });
    expect(res.status).toBe(200);
    const user = await db.user.findUnique({ where: { email } });
    expect(user!.status).toBe('ACTIVE');
    expect(user!.emailVerifiedAt).not.toBeNull();
  });

  let accessToken: string;
  let refreshToken: string;

  it('login returns an access + refresh pair once verified', async () => {
    const res = await call('POST', '/auth/login', { body: { email, password } });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    accessToken = res.body.accessToken;
    refreshToken = res.body.refreshToken;

    const user = await db.user.findUnique({ where: { email } });
    expect(user!.lastLoginAt).not.toBeNull();
    const audit = await db.auditLog.findFirst({
      where: { userId: user!.id, action: 'AUTH_LOGIN' },
    });
    expect(audit).not.toBeNull();
  });

  it('login with a wrong password is rejected generically', async () => {
    const res = await call('POST', '/auth/login', {
      body: { email, password: 'wrong-password-123' },
    });
    expect(res.status).toBe(401);
  });

  it('login with an UNKNOWN email still runs argon2 (timing-safe, no enumeration)', async () => {
    // Proves the absent-user branch spends the same argon2 cost as a real
    // wrong-password attempt: PasswordService.verify must be invoked (against
    // the dummy hash) rather than short-circuited.
    const spy = jest.spyOn(passwords, 'verify');
    const res = await call('POST', '/auth/login', {
      body: { email: `nobody-${Date.now()}@example.com`, password: 'whatever1' },
    });
    expect(res.status).toBe(401);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('GET /auth/me is 401 without a token (global guard active)', async () => {
    const res = await call('GET', '/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns the profile with a valid access token', async () => {
    const res = await call('GET', '/auth/me', { token: accessToken });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
    expect(res.body.role).toBe('USER');
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.mfaEnabled).toBe(false);
    expect(res.body.id).toBeTruthy();
  });

  it('refresh rotates the pair; reusing the old refresh token is rejected (family revoked)', async () => {
    const rotated = await call('POST', '/auth/refresh', {
      body: { refreshToken },
    });
    expect(rotated.status).toBe(200);
    expect(typeof rotated.body.accessToken).toBe('string');
    expect(rotated.body.refreshToken).not.toBe(refreshToken);

    // reuse of the now-rotated (revoked) token => 401 + reuse audit
    const reuse = await call('POST', '/auth/refresh', { body: { refreshToken } });
    expect(reuse.status).toBe(401);

    // the descendant minted in the reuse window is also dead now
    const dead = await call('POST', '/auth/refresh', {
      body: { refreshToken: rotated.body.refreshToken },
    });
    expect(dead.status).toBe(401);

    const user = await db.user.findUnique({ where: { email } });
    const reuseAudit = await db.auditLog.findFirst({
      where: { userId: user!.id, action: 'AUTH_REFRESH_REUSE' },
    });
    expect(reuseAudit).not.toBeNull();
  });

  it('logout revokes the caller refresh tokens', async () => {
    const login = await call('POST', '/auth/login', {
      body: { email, password },
    });
    const freshAccess = login.body.accessToken as string;
    const freshRefresh = login.body.refreshToken as string;

    const out = await call('POST', '/auth/logout', { token: freshAccess });
    expect(out.status).toBe(200);

    const afterLogout = await call('POST', '/auth/refresh', {
      body: { refreshToken: freshRefresh },
    });
    expect(afterLogout.status).toBe(401);
  });
});
