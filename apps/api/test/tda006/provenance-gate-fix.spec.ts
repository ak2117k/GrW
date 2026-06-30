/**
 * TDA-006 final-review fixes — three USER-reachable provenance paths that the
 * earlier tasks missed must now be ADMIN-gated:
 *
 *   Fix #1  GET /api/watch                  (class-level @AdminOnly)
 *   Fix #3  GET /api/anand/reinvest/lots    (handler-level @AdminOnly)
 *   Fix #3  GET /api/anand/reinvest/pool    (handler-level @AdminOnly)
 *
 * Style-A harness (as in provenance-routes.spec.ts): boot a focused Nest HTTP
 * app under the REAL JwtAuthGuard → RolesGuard stack with the controller's deps
 * stubbed, then assert USER → 403 and ADMIN → not-403 (200 with the stubs).
 *
 * The USER-product endpoints on the SAME anand controller (intraday/entries,
 * swing/entries) MUST stay un-gated — asserted as a regression guard.
 *
 * Run from apps/api:
 *   npx jest --config test/tda006/jest.config.js provenance-gate-fix --verbose
 */

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda006';

import { INestApplication, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/modules/auth/guards/roles.guard';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { ROLES_KEY } from '../../src/common/decorators';
import { WatchController } from '../../src/modules/watch-monitor/controllers/watch.controller';
import { WatchRepository } from '../../src/modules/watch-monitor/repositories/watch.repository';
import { WatchService } from '../../src/modules/watch-monitor/services/watch.service';
import { RiskGuardService } from '../../src/modules/watch-monitor/services/risk-guard.service';
import { AnandDualTrackController } from '../../src/modules/anand-dual-track/controllers/anand-dual-track.controller';
import { AnandDualTrackRepository } from '../../src/modules/anand-dual-track/repositories/anand-dual-track.repository';
import { AngelOneAdapterService } from '../../src/modules/market-data/services/angel-one-adapter.service';
import { ChartinkRepository } from '../../src/modules/chartink/repositories/chartink.repository';

const jwt = new JwtService();
const tokenFor = (role: 'USER' | 'ADMIN') =>
  jwt.sign(
    { sub: `user-${role}`, role, email: `${role.toLowerCase()}@test.local` },
    { secret: process.env.JWT_SECRET, algorithm: 'HS256', audience: 'td-access', expiresIn: '15m' },
  );

async function boot(moduleClass: unknown): Promise<{ app: INestApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({ imports: [moduleClass as never] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

const getStatus =
  (baseUrl: string) =>
  async (path: string, token?: string): Promise<number> =>
    (
      await fetch(
        `${baseUrl}${path}`,
        token ? { headers: { authorization: `Bearer ${token}` } } : {},
      )
    ).status;

// --- Stubs: the guard rejects USER before the handler runs, so for ADMIN the
// handler executes against these and must produce a clean 200 (no DB).
const watchServiceStub = { list: async () => [] };
const anandRepoStub = {
  getPool: async () => ({ id: 'pool', capital: 0 }),
  listReinvestmentLots: async () => [],
  resolveTokens: async () => new Map<string, string>(),
};
const angelStub = { getLtpsBatch: async () => new Map<string, number>() };

@Module({
  imports: [PassportModule],
  controllers: [WatchController],
  providers: [
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: WatchService, useValue: watchServiceStub },
    { provide: WatchRepository, useValue: {} },
    { provide: RiskGuardService, useValue: {} },
  ],
})
class WatchGateTestModule {}

@Module({
  imports: [PassportModule],
  controllers: [AnandDualTrackController],
  providers: [
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: AnandDualTrackRepository, useValue: anandRepoStub },
    { provide: AngelOneAdapterService, useValue: angelStub },
    { provide: ChartinkRepository, useValue: {} },
  ],
})
class AnandReinvestGateTestModule {}

describe('TDA-006 fix — ADMIN gate metadata (watch + reinvest)', () => {
  const reflector = new Reflector();
  const rolesOf = (target: unknown) => reflector.get<string[]>(ROLES_KEY, target as never);

  it('WatchController carries class-level roles ["ADMIN"]', () => {
    expect(rolesOf(WatchController)).toEqual(['ADMIN']);
  });

  it('reinvestPool handler carries roles ["ADMIN"]', () => {
    expect(rolesOf(AnandDualTrackController.prototype.reinvestPool)).toEqual(['ADMIN']);
  });

  it('reinvestLots handler carries roles ["ADMIN"]', () => {
    expect(rolesOf(AnandDualTrackController.prototype.reinvestLots)).toEqual(['ADMIN']);
  });

  it('AnandDualTrackController class is NOT ADMIN-gated (user product surface)', () => {
    expect(rolesOf(AnandDualTrackController)).not.toEqual(['ADMIN']);
  });

  it('USER-product handlers (listIntraday/listSwing) are NOT gated', () => {
    expect(rolesOf(AnandDualTrackController.prototype.listIntraday)).toBeUndefined();
    expect(rolesOf(AnandDualTrackController.prototype.listSwing)).toBeUndefined();
  });
});

describe('TDA-006 fix #1 — GET /api/watch enforced over real guard stack', () => {
  let app: INestApplication;
  let get: ReturnType<typeof getStatus>;

  beforeAll(async () => {
    const booted = await boot(WatchGateTestModule);
    app = booted.app;
    get = getStatus(booted.baseUrl);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('USER token is forbidden (403) on GET /api/watch', async () => {
    expect(await get('/api/watch', tokenFor('USER'))).toBe(403);
  });
  it('ADMIN token is accepted (not 403) on GET /api/watch', async () => {
    expect(await get('/api/watch', tokenFor('ADMIN'))).not.toBe(403);
  });
});

describe('TDA-006 fix #3 — reinvest/* enforced over real guard stack', () => {
  let app: INestApplication;
  let get: ReturnType<typeof getStatus>;

  beforeAll(async () => {
    const booted = await boot(AnandReinvestGateTestModule);
    app = booted.app;
    get = getStatus(booted.baseUrl);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('USER token is forbidden (403) on GET /api/anand/reinvest/lots', async () => {
    expect(await get('/api/anand/reinvest/lots', tokenFor('USER'))).toBe(403);
  });
  it('USER token is forbidden (403) on GET /api/anand/reinvest/pool', async () => {
    expect(await get('/api/anand/reinvest/pool', tokenFor('USER'))).toBe(403);
  });
  it('ADMIN token is accepted (not 403) on GET /api/anand/reinvest/lots', async () => {
    expect(await get('/api/anand/reinvest/lots', tokenFor('ADMIN'))).not.toBe(403);
  });
  it('ADMIN token is accepted (not 403) on GET /api/anand/reinvest/pool', async () => {
    expect(await get('/api/anand/reinvest/pool', tokenFor('ADMIN'))).not.toBe(403);
  });
});
