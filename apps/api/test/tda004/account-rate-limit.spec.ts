/**
 * TDA-004 Task 7 — per-ACCOUNT rate limiter on the auth routes.
 *
 * Boots the REAL production AuthModule (Style-A focused HTTP app) pointed at the
 * `td_saas_test` DB, mirroring tda003/rbac.spec's cross-module harness. The new
 * AccountRateLimitGuard keys a fixed window on the normalised `req.body.email`
 * (NOT the source IP), so it must reject the (limit+1)th attempt against ONE
 * account even when every attempt arrives from a DIFFERENT `X-Forwarded-For` IP —
 * exactly the credential-stuffing shape the per-IP ThrottlerGuard cannot catch.
 *
 * REDIS_THROTTLER is forced unset so AuthModule's RATE_LIMIT_STORE factory yields
 * the in-process MemoryRateLimitStore — no Redis needed in CI.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda004/jest.config.js test/tda004/account-rate-limit.spec.ts --verbose
 */

// JwtStrategy + AuthModule wiring read JWT_SECRET at import time.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda004';

// The REAL AuthModule boots PrismaService, which connects from DATABASE_URL via
// super(). Point it at td_saas_test (mirrors isolation/rbac specs).
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

// Force the in-memory rate-limit store (no Redis socket in CI).
delete process.env.REDIS_THROTTLER;

import { INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { ClsModule } from 'nestjs-cls';
import configuration from '../../src/config/configuration';
import { TenantModule } from '../../src/common/tenant/tenant.module';
import { AuthModule } from '../../src/modules/auth/auth.module';

// Root module that plays AppModule's role: globally-scoped infra (config, CLS,
// a permissive central throttler, tenant context) + the REAL AuthModule. The
// throttler limit is huge so the per-IP guard never fires — only the per-account
// guard should produce a 429 in these tests.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 100_000 }],
    }),
    TenantModule,
    AuthModule,
  ],
})
class ProductionLikeRootModule {}

async function boot(): Promise<{ app: INestApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [ProductionLikeRootModule],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

describe('TDA-004 Task 7 — per-account rate limiter on /auth/login', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const booted = await boot();
    app = booted.app;
    baseUrl = booted.baseUrl;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('429s after the per-account limit regardless of source IP', async () => {
    const body = JSON.stringify({ email: 'victim@t.local', password: 'wrong' });
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `10.0.0.${i}`,
        },
        body,
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('a different account is not throttled by the victim’s attempts', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'other@t.local', password: 'wrong' }),
    });
    expect(res.status).not.toBe(429);
  });
});
