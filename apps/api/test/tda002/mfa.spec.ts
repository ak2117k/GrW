/**
 * TDA-002 Task 5 — TOTP MFA integration tests (real td_saas_test DB).
 *
 * Bootstraps the same focused Nest app as auth-core.spec (AuthModule only, with
 * the global JwtAuthGuard) and exercises the full enroll → activate → MFA login
 * challenge → disable lifecycle against the throw-away test DB.
 *
 * NOTE: otplib here is v13 (functional API): `generateSecret`, `generateURI`,
 * `generate({ secret })`, `verify({ secret, token })` — all async for codes.
 * Valid login codes are produced in-test with `generate({ secret })` using the
 * base32 secret returned ONCE by `/auth/mfa/enroll`.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda002';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? 'test-encryption-key-32-bytes-aaaa';
process.env.EMAIL_TRANSPORT = 'console';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { generate } from 'otplib';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { db } from './test-prisma';

interface HttpResult {
  status: number;
  body: any;
}

describe('MFA (integration, td_saas_test)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const email = `tda002-mfa-${Date.now()}@example.com`;
  const password = 'Sup3r-Str0ng-Pass!';
  let accessToken: string;
  let secret: string;

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

    // Provision an ACTIVE, verified user via the public flow (test-only seam).
    const signup = await call('POST', '/auth/signup', { body: { email, password } });
    await call('POST', '/auth/verify-email', {
      body: { token: signup.body.verificationToken },
    });
    const login = await call('POST', '/auth/login', { body: { email, password } });
    accessToken = login.body.accessToken;
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

  it('enroll returns an otpauth URI + base32 secret but does NOT enable MFA yet', async () => {
    const res = await call('POST', '/auth/mfa/enroll', { token: accessToken });
    expect(res.status).toBe(200);
    expect(typeof res.body.otpauthUri).toBe('string');
    expect(res.body.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    expect(typeof res.body.secret).toBe('string');
    secret = res.body.secret;

    const user = await db.user.findUnique({ where: { email } });
    expect(user!.mfaEnabled).toBe(false);
    // Secret persisted only ENCRYPTED (never the raw base32).
    expect(user!.mfaSecretEnc).toBeTruthy();
    expect(user!.mfaSecretEnc).not.toContain(secret);

    const audit = await db.auditLog.findFirst({
      where: { userId: user!.id, action: 'AUTH_MFA_ENROLL' },
    });
    expect(audit).not.toBeNull();
  });

  it('activate with a valid code flips mfaEnabled=true', async () => {
    const code = await generate({ secret });
    const res = await call('POST', '/auth/mfa/activate', {
      token: accessToken,
      body: { code },
    });
    expect(res.status).toBe(200);
    const user = await db.user.findUnique({ where: { email } });
    expect(user!.mfaEnabled).toBe(true);
    const audit = await db.auditLog.findFirst({
      where: { userId: user!.id, action: 'AUTH_MFA_ACTIVATE' },
    });
    expect(audit).not.toBeNull();
  });

  it('activate with an invalid code is rejected', async () => {
    // (re-enroll-free) a wrong code against the now-active secret
    const res = await call('POST', '/auth/mfa/activate', {
      token: accessToken,
      body: { code: '000000' },
    });
    expect(res.status).toBe(401);
  });

  it('enroll on an already-MFA-enabled account is rejected and changes nothing', async () => {
    const before = await db.user.findUnique({ where: { email } });
    const res = await call('POST', '/auth/mfa/enroll', { token: accessToken });
    expect(res.status).toBe(409);
    const after = await db.user.findUnique({ where: { email } });
    // The active second factor must be untouched (no silent disable).
    expect(after!.mfaEnabled).toBe(true);
    expect(after!.mfaSecretEnc).toBe(before!.mfaSecretEnc);
  });

  it('login for an MFA user returns { mfaRequired, mfaToken } — NOT session tokens', async () => {
    const res = await call('POST', '/auth/login', { body: { email, password } });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(typeof res.body.mfaToken).toBe('string');
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();

    const user = await db.user.findUnique({ where: { email } });
    const audit = await db.auditLog.findFirst({
      where: { userId: user!.id, action: 'AUTH_MFA_CHALLENGE' },
    });
    expect(audit).not.toBeNull();
  });

  it('the mfaToken is REJECTED as a Bearer access token on protected routes', async () => {
    // Second-factor bypass guard: the mfaToken is HS256-signed with the same
    // JWT_SECRET as access tokens, so without an audience/role check it would
    // sail through the global guard. It must be rejected (different audience,
    // and it carries no role/email).
    const login = await call('POST', '/auth/login', { body: { email, password } });
    const mfaToken = login.body.mfaToken as string;
    expect(typeof mfaToken).toBe('string');

    const res = await call('GET', '/auth/me', { token: mfaToken });
    expect(res.status).toBe(401);
  });

  it('/auth/login/mfa with an invalid code is rejected', async () => {
    const login = await call('POST', '/auth/login', { body: { email, password } });
    const res = await call('POST', '/auth/login/mfa', {
      body: { mfaToken: login.body.mfaToken, code: '000000' },
    });
    expect(res.status).toBe(401);
  });

  it('/auth/login/mfa with a valid code issues session tokens', async () => {
    const login = await call('POST', '/auth/login', { body: { email, password } });
    const code = await generate({ secret });
    const res = await call('POST', '/auth/login/mfa', {
      body: { mfaToken: login.body.mfaToken, code },
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });

  it('disable with a valid code but wrong/missing password is rejected', async () => {
    const code = await generate({ secret });
    // Wrong password (valid code) -> rejected.
    const wrong = await call('POST', '/auth/mfa/disable', {
      token: accessToken,
      body: { password: 'not-the-password', code },
    });
    expect(wrong.status).toBe(401);
    // Missing password fails DTO validation -> 400.
    const missing = await call('POST', '/auth/mfa/disable', {
      token: accessToken,
      body: { code },
    });
    expect(missing.status).toBe(400);
    // MFA must still be on.
    const user = await db.user.findUnique({ where: { email } });
    expect(user!.mfaEnabled).toBe(true);
  });

  it('disable with password + valid code turns MFA off; login then returns tokens directly', async () => {
    const code = await generate({ secret });
    const res = await call('POST', '/auth/mfa/disable', {
      token: accessToken,
      body: { password, code },
    });
    expect(res.status).toBe(200);

    const user = await db.user.findUnique({ where: { email } });
    expect(user!.mfaEnabled).toBe(false);
    expect(user!.mfaSecretEnc).toBeNull();
    const audit = await db.auditLog.findFirst({
      where: { userId: user!.id, action: 'AUTH_MFA_DISABLE' },
    });
    expect(audit).not.toBeNull();

    const login = await call('POST', '/auth/login', { body: { email, password } });
    expect(login.status).toBe(200);
    expect(typeof login.body.accessToken).toBe('string');
    expect(typeof login.body.refreshToken).toBe('string');
  });
});
