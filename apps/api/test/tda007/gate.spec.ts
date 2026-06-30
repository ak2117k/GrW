/**
 * TDA-007 Task 3 — subscription gate on the anand segment endpoints.
 *
 * A non-ADMIN USER may only reach a segment they hold an ACTIVE subscription
 * for; ADMIN bypasses the gate entirely.
 *
 * Style-A focused-module harness (mirrors test/tda006/provenance-routes.spec):
 * booting the REAL AnandDualTrackModule is impractical (MarketDataModule pulls
 * Bull/Redis queues, websockets, crons; the @Global ChartinkModule is circular
 * and equally heavy). So we mount the REAL AnandDualTrackController + REAL
 * AnandDualTrackRepository against td_saas_test, stub only the external broker
 * adapter (AngelOneAdapterService) and ChartinkRepository, and import the REAL
 * SubscriptionModule (provides SubscriptionService) + real Tenant/Prisma/CLS so
 * the gate's `hasActive` runs the production code path.
 *
 * A USER is seeded via a raw PrismaClient into td_saas_test and its token is
 * minted with `sub` = the seeded id, so the gate resolves to that real user.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda007/jest.config.js gate --verbose
 */

// JwtStrategy reads JWT_SECRET at construction; set it before any import.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda007';

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  throw new Error(
    'DATABASE_URL_TEST must be set to the td_saas_test connection string ' +
      '(e.g. postgresql://postgres:postgres@127.0.0.1:5432/td_saas_test)',
  );
}
// PrismaService resolves its connection from DATABASE_URL — point it (and the
// raw seed client below) at td_saas_test so a stray run can NEVER touch the
// real td_saas database.
process.env.DATABASE_URL = url;

import { INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AddressInfo } from 'net';
import { ClsModule } from 'nestjs-cls';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { TenantModule } from '../../src/common/tenant/tenant.module';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { AnandDualTrackController } from '../../src/modules/anand-dual-track/controllers/anand-dual-track.controller';
import { AnandDualTrackRepository } from '../../src/modules/anand-dual-track/repositories/anand-dual-track.repository';
import { AngelOneAdapterService } from '../../src/modules/market-data/services/angel-one-adapter.service';
import { ChartinkRepository } from '../../src/modules/chartink/repositories/chartink.repository';
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

/** Broker adapter is external — stub it so no row triggers a live-price fetch. */
const adapterStub = { getLtpsBatch: async () => new Map<string, number>() };

@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    TenantModule,
    PrismaModule,
    PassportModule,
    SubscriptionModule,
  ],
  controllers: [AnandDualTrackController],
  providers: [
    AnandDualTrackRepository,
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: AngelOneAdapterService, useValue: adapterStub },
    { provide: ChartinkRepository, useValue: {} },
  ],
})
class AnandGateTestModule {}

/** Boot a focused Nest HTTP app and return it + its base URL. */
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
  ): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {};
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { headers });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  };

const raw = new PrismaClient({ datasources: { db: { url } } });
const E = 'tda007-gate@test.local';
let userId: string;
let userToken: string;
let adminToken: string;

let app: INestApplication;
let getJson: ReturnType<typeof getJsonFor>;

beforeAll(async () => {
  await raw.subscription.deleteMany({ where: { user: { email: E } } });
  await raw.user.deleteMany({ where: { email: E } });
  const u = await raw.user.create({
    data: { email: E, passwordHash: 'x', role: 'USER' },
  });
  userId = u.id;
  userToken = tokenFor(userId, 'USER');
  adminToken = tokenFor('admin-tda007-gate', 'ADMIN');

  const booted = await boot(AnandGateTestModule);
  app = booted.app;
  getJson = getJsonFor(booted.baseUrl);
});

afterAll(async () => {
  await app?.close();
  await raw.subscription.deleteMany({ where: { userId } });
  await raw.user.deleteMany({ where: { email: E } });
  await raw.$disconnect();
});

describe('TDA-007 Task 3 — subscription gate on anand segment endpoints', () => {
  it('USER without sub → 403 NOT_SUBSCRIBED on intraday entries', async () => {
    const { status, body } = await getJson(
      '/api/anand/intraday/entries',
      userToken,
    );
    expect(status).toBe(403);
    expect(body?.code).toBe('NOT_SUBSCRIBED');
    expect(body?.segment).toBe('INTRADAY');
  });

  it('USER with ACTIVE INTRADAY sub → 200', async () => {
    await raw.subscription.upsert({
      where: { userId_segment: { userId, segment: 'INTRADAY' } },
      update: { status: 'ACTIVE' },
      create: { userId, segment: 'INTRADAY', status: 'ACTIVE' },
    });
    const { status } = await getJson('/api/anand/intraday/entries', userToken);
    expect(status).toBe(200);
  });

  it('ADMIN bypasses the gate → 200', async () => {
    const { status } = await getJson('/api/anand/intraday/entries', adminToken);
    expect(status).toBe(200);
  });
});
