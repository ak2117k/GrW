/**
 * TDA-007 Task 2 — /api/me/subscriptions + /api/admin/subscriptions endpoints.
 *
 * Style-A HTTP harness (mirrors test/tda003/rbac.spec): boots a focused Nest app
 * over real HTTP and drives it with minted JWTs. The root module wires the
 * globally-scoped infrastructure AppModule provides (CLS store + TenantModule)
 * plus the production AuthModule (which owns the global JwtAuthGuard +
 * RolesGuard) and the SubscriptionModule under test (which registers both
 * controllers).
 *
 * A USER is seeded via a raw PrismaClient into td_saas_test and its token is
 * minted with `sub` = the seeded id, so `/api/me/subscriptions` resolves to that
 * real user. `Subscription` is a TENANT_MODEL (TDA-003); the service runs every
 * query via `runWithoutTenant`, so the ClsMiddleware-provided request scope is
 * all the controllers need.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda007/jest.config.js admin-grant --verbose
 */

// JwtStrategy + token signing both read JWT_SECRET from the environment; set it
// before any strategy/module is imported/instantiated.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda007';

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  throw new Error(
    'DATABASE_URL_TEST must be set to the td_saas_test connection string ' +
      '(e.g. postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test)',
  );
}
// PrismaService (pulled in by SubscriptionModule + AuthModule) resolves its
// connection from DATABASE_URL — point it at the test DB so a stray run can
// NEVER touch the real td_saas database.
process.env.DATABASE_URL = url;

import { INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AddressInfo } from 'net';
import { ClsModule } from 'nestjs-cls';
import { TenantModule } from '../../src/common/tenant/tenant.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { SubscriptionModule } from '../../src/modules/subscription/subscription.module';

// Mint an access token with exactly the claims JwtStrategy requires:
// audience 'td-access' + { sub, role, email }.
const jwt = new JwtService();
const tokenFor = (sub: string, role: 'USER' | 'ADMIN') =>
  jwt.sign(
    { sub, role, email: `${role.toLowerCase()}@test.local` },
    {
      secret: process.env.JWT_SECRET,
      algorithm: 'HS256',
      audience: 'td-access',
      expiresIn: '15m',
    },
  );

/** Boot a focused Nest HTTP app from a module and return it + its base URL. */
async function boot(moduleClass: unknown): Promise<{
  app: INestApplication;
  baseUrl: string;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [moduleClass as never],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

/** GET helper bound to a base URL; returns the HTTP status + parsed JSON body. */
const getJsonFor =
  (baseUrl: string) =>
  async (
    path: string,
    token?: string,
  ): Promise<{ status: number; body: unknown }> => {
    const headers: Record<string, string> = {};
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { headers });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  };

/** POST helper: JSON body + content-type; returns the HTTP status + JSON body. */
const postJsonFor =
  (baseUrl: string) =>
  async (
    path: string,
    payload: unknown,
    token?: string,
  ): Promise<{ status: number; body: unknown }> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  };

// Root module that plays AppModule's role: CLS store + TenantModule provide the
// request scope and tenant context the SubscriptionService relies on; AuthModule
// owns the global JwtAuthGuard + RolesGuard; SubscriptionModule registers the
// two controllers under test.
@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    TenantModule,
    AuthModule,
    SubscriptionModule,
  ],
})
class SubscriptionTestRootModule {}

const raw = new PrismaClient({ datasources: { db: { url } } });
const E = 'tda007-admin-grant@test.local';
let userId: string;
let userToken: string;
let adminToken: string;

let app: INestApplication;
let getJson: ReturnType<typeof getJsonFor>;
let postJson: ReturnType<typeof postJsonFor>;

beforeAll(async () => {
  await raw.subscription.deleteMany({ where: { user: { email: E } } });
  await raw.user.deleteMany({ where: { email: E } });
  const u = await raw.user.create({
    data: { email: E, passwordHash: 'x', role: 'USER' },
  });
  userId = u.id;
  userToken = tokenFor(userId, 'USER');
  adminToken = tokenFor('admin-tda007', 'ADMIN');

  const booted = await boot(SubscriptionTestRootModule);
  app = booted.app;
  getJson = getJsonFor(booted.baseUrl);
  postJson = postJsonFor(booted.baseUrl);
});

afterAll(async () => {
  await app?.close();
  await raw.subscription.deleteMany({ where: { userId } });
  await raw.user.deleteMany({ where: { email: E } });
  await raw.$disconnect();
});

describe('TDA-007 Task 2 — me + admin subscription endpoints', () => {
  it('USER /api/me/subscriptions returns both-false before grant', async () => {
    const { status, body } = await getJson('/api/me/subscriptions', userToken);
    expect(status).toBe(200);
    expect(body).toEqual({ INTRADAY: false, SWING: false });
  });

  it('USER cannot POST /api/admin/subscriptions (403)', async () => {
    const { status } = await postJson(
      '/api/admin/subscriptions',
      { userId, segment: 'SWING' },
      userToken,
    );
    expect(status).toBe(403);
  });

  it('ADMIN grant then USER sees SWING true', async () => {
    const grant = await postJson(
      '/api/admin/subscriptions',
      { userId, segment: 'SWING' },
      adminToken,
    );
    expect(grant.status).toBe(201);

    const { body } = await getJson('/api/me/subscriptions', userToken);
    expect(body).toEqual({ INTRADAY: false, SWING: true });
  });
});
