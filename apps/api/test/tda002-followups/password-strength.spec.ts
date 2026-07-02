/**
 * Roadmap §8 (TDA-002 follow-up), Task 2 — password strength enforced at the
 * HTTP boundary.
 *
 * Drives real /auth/signup through the AuthModule seam and proves a weak
 * password is rejected (400) BEFORE any user row is created, while a strong
 * password still succeeds (201). Unit coverage of the rule itself lives in
 * src/modules/auth/services/password.service.spec.ts; this spec pins the wiring.
 *
 * Setup mirrors test/tda008/auth-audit.spec.ts: PrismaService (TDA-003) injects
 * TenantContextService, so the full Cls + Tenant + Audit infra must be present
 * for AuthModule to boot; DATABASE_URL is pointed at the throw-away scratch DB
 * BEFORE PrismaService is constructed.
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

describe('Password strength at signup (integration, Task 2)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const weakEmail = `tda002fu-weak-${Date.now()}@example.com`;
  const strongEmail = `tda002fu-strong-${Date.now()}@example.com`;
  const strongPassword = 'Sup3r-Str0ng-Pass!';

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
  });

  afterAll(async () => {
    for (const email of [weakEmail, strongEmail]) {
      const user = await db.user.findUnique({ where: { email } });
      if (user) {
        await db.refreshToken.deleteMany({ where: { userId: user.id } });
        await db.verificationToken.deleteMany({ where: { userId: user.id } });
        await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
      }
    }
    if (app) await app.close();
    await db.$disconnect();
  });

  it('rejects a signup with a weak password (400) and creates no user', async () => {
    // 8+ chars (passes the DTO MinLength) but only two character classes, so the
    // service-level strength rule is what rejects it.
    const res = await call('POST', '/auth/signup', {
      body: { email: weakEmail, password: 'abcdefgh12' },
    });
    expect(res.status).toBe(400);
    const user = await db.user.findUnique({ where: { email: weakEmail } });
    expect(user).toBeNull();
  });

  it('accepts a signup with a strong password (201)', async () => {
    const res = await call('POST', '/auth/signup', {
      body: { email: strongEmail, password: strongPassword },
    });
    expect(res.status).toBe(201);
    const user = await db.user.findUnique({ where: { email: strongEmail } });
    expect(user).not.toBeNull();
  });
});
