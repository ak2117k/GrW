/**
 * TDA-006 Task 2 — the anand controller's three provenance-returning routes
 * (intraday/entries, swing/entries, swing/exits) must serve PROVENANCE-STRIPPED
 * rows to a non-ADMIN (USER) and the raw enriched rows to an ADMIN.
 *
 * Style-A harness (copied from test/tda003/rbac.spec.ts): boot a focused Nest
 * HTTP app, register JwtAuthGuard as the global guard so `req.user` is populated
 * from the Bearer token, and mint access tokens with the exact claims
 * JwtStrategy requires ({sub,role,email} + audience 'td-access').
 *
 * Booting the REAL AnandDualTrackModule is impractical here: it imports
 * MarketDataModule (Bull/Redis queues, websockets, crons, HttpModule,
 * OptionsChain) and depends on the @Global ChartinkModule (circular, equally
 * heavy). So we wire a focused module that mounts the REAL controller + REAL
 * AnandDualTrackRepository + REAL PrismaService against td_saas_test, and stubs
 * only the external broker adapter (AngelOneAdapterService) and the
 * ChartinkRepository (which the three handlers under test never touch). The code
 * path exercised — handler → enrichWithLivePrice → enrichWithScannerName /
 * enrichWithLeadStat → role branch → toPublicEntry — is the real one.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda006/jest.config.js provenance-routes --verbose
 */

// JwtStrategy reads JWT_SECRET at construction; set it before any import.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda006';

// PrismaService resolves its connection from DATABASE_URL via super(). Point it
// (and the raw seed client below) at td_saas_test.
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

import { Controller, INestApplication, Module } from '@nestjs/common';
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

const PROVENANCE_KEYS = [
  'scannerName',
  'scoreBreakdown',
  'leadCount',
  'leadDates',
  'trailing',
  'exitReason',
];

// Unique marker so the seed/cleanup only touch this spec's rows.
const MARK = 'TDA006';

// Mint an access token with exactly the claims JwtStrategy requires.
const jwt = new JwtService();
const tokenFor = (role: 'USER' | 'ADMIN') =>
  jwt.sign(
    { sub: `user-${role}`, role, email: `${role.toLowerCase()}@test.local` },
    { secret: process.env.JWT_SECRET, algorithm: 'HS256', audience: 'td-access', expiresIn: '15m' },
  );

/** Broker adapter is external — stub it so no row triggers a live-price fetch. */
const adapterStub = { getLtpsBatch: async () => new Map<string, number>() };

@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    TenantModule,
    PrismaModule,
    PassportModule,
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
class AnandProvenanceTestModule {}

/** Boot a focused Nest HTTP app and return it + its base URL. */
async function boot(moduleClass: unknown): Promise<{ app: INestApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({ imports: [moduleClass as never] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

/** GET helper returning { status, parsed-JSON body (or null on non-200) }. */
const getJson =
  (baseUrl: string) =>
  async (path: string, token?: string): Promise<{ status: number; body: any }> => {
    const res = await fetch(
      `${baseUrl}${path}`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    );
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };

describe('TDA-006 Task 2 — anand provenance routes (USER sanitized, ADMIN raw)', () => {
  let app: INestApplication;
  let get: ReturnType<typeof getJson>;
  const raw = new PrismaClient();

  beforeAll(async () => {
    // Clean any leftovers, then seed one real row per route so the
    // no-provenance assertions are not vacuously true on an empty array.
    await raw.intradayEntry.deleteMany({ where: { symbol: { startsWith: MARK } } });
    await raw.swingEntry.deleteMany({ where: { symbol: { startsWith: MARK } } });

    // Intraday: an OPEN row (status TRADED, no exit). token=null → no live-price
    // fetch. trailing/exitReason are provenance sentinels that must be stripped.
    await raw.intradayEntry.create({
      data: {
        symbol: `${MARK}_INTRA`,
        token: null,
        entryPrice: 100,
        targetPct: 5,
        stopPct: 5,
        status: 'TRADED',
        alertId: `${MARK}_alert_i`,
        scoreBreakdown: [{ name: 'leak', points: 3 }],
        trailing: true,
      },
    });

    // Swing OPEN row → surfaces in /swing/entries (status TRADED default filter).
    await raw.swingEntry.create({
      data: {
        symbol: `${MARK}_SWING_OPEN`,
        token: null,
        entryPrice: 200,
        targetPct: 10,
        stopPct: 10,
        status: 'TRADED',
        alertId: `${MARK}_alert_so`,
        scoreBreakdown: [{ name: 'leak', points: 4 }],
      },
    });

    // Swing CLOSED row → surfaces in /swing/exits (terminal status + exitedAt).
    await raw.swingEntry.create({
      data: {
        symbol: `${MARK}_SWING_EXIT`,
        token: null,
        entryPrice: 200,
        targetPct: 10,
        stopPct: 10,
        status: 'TARGET_HIT',
        exitPrice: 220,
        exitedAt: new Date(),
        alertId: `${MARK}_alert_se`,
        scoreBreakdown: [{ name: 'leak', points: 5 }],
      },
    });

    const booted = await boot(AnandProvenanceTestModule);
    app = booted.app;
    get = getJson(booted.baseUrl);
  });

  afterAll(async () => {
    await raw.intradayEntry.deleteMany({ where: { symbol: { startsWith: MARK } } });
    await raw.swingEntry.deleteMany({ where: { symbol: { startsWith: MARK } } });
    await raw.$disconnect();
    await app?.close();
  });

  const assertSanitized = (rows: any[], segment: 'INTRADAY' | 'SWING') => {
    expect(rows.length).toBeGreaterThan(0); // not vacuously true
    for (const row of rows) {
      for (const k of PROVENANCE_KEYS) expect(row).not.toHaveProperty(k);
      expect(row).toHaveProperty('segment', segment);
    }
  };

  describe('GET /api/anand/intraday/entries', () => {
    it('USER rows carry no provenance keys and segment INTRADAY', async () => {
      const { status, body } = await get('/api/anand/intraday/entries', tokenFor('USER'));
      expect(status).toBe(200);
      assertSanitized(body, 'INTRADAY');
    });

    it('ADMIN rows retain raw provenance (scannerName present)', async () => {
      const { status, body } = await get('/api/anand/intraday/entries', tokenFor('ADMIN'));
      expect(status).toBe(200);
      expect(body.length).toBeGreaterThan(0);
      expect(body[0]).toHaveProperty('scannerName');
      expect(body[0]).not.toHaveProperty('segment');
    });
  });

  describe('GET /api/anand/swing/entries', () => {
    it('USER rows carry no provenance keys and segment SWING', async () => {
      const { status, body } = await get('/api/anand/swing/entries', tokenFor('USER'));
      expect(status).toBe(200);
      assertSanitized(body, 'SWING');
    });

    it('ADMIN rows retain raw provenance (scannerName + leadCount present)', async () => {
      const { status, body } = await get('/api/anand/swing/entries', tokenFor('ADMIN'));
      expect(status).toBe(200);
      expect(body.length).toBeGreaterThan(0);
      expect(body[0]).toHaveProperty('scannerName');
      expect(body[0]).toHaveProperty('leadCount');
    });
  });

  describe('GET /api/anand/swing/exits', () => {
    it('USER rows carry no provenance keys and segment SWING', async () => {
      const { status, body } = await get('/api/anand/swing/exits', tokenFor('USER'));
      expect(status).toBe(200);
      assertSanitized(body, 'SWING');
    });

    it('ADMIN rows retain raw provenance (scannerName + leadCount present)', async () => {
      const { status, body } = await get('/api/anand/swing/exits', tokenFor('ADMIN'));
      expect(status).toBe(200);
      expect(body.length).toBeGreaterThan(0);
      expect(body[0]).toHaveProperty('scannerName');
      expect(body[0]).toHaveProperty('leadCount');
    });
  });
});
