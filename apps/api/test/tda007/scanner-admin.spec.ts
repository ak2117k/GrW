/**
 * TDA-007 final-review fix — ADMIN-only gate on the scanner-category write.
 *
 * `PATCH /api/anand/scanners/:id/category` (handler `tagScanner`) mutates a
 * scanner's category — an ADMIN cockpit write touching scanner IP. It carries
 * no class-level guard (the controller also serves USER product endpoints such
 * as `intraday/entries`), so the gate must live on the handler via `@AdminOnly()`
 * and be enforced by the global `RolesGuard`.
 *
 * Style-A focused-module harness (mirrors gate.spec / tda006 provenance-routes):
 * mount the REAL AnandDualTrackController behind the REAL JwtAuthGuard +
 * RolesGuard (both APP_GUARDs, same order production wires them) and the REAL
 * JwtStrategy. The `tagScanner` path only touches `ChartinkRepository`, so every
 * other collaborator (repo, broker adapter, SubscriptionService) is stubbed and
 * NO database is required. The Chartink stub returns null so an ADMIN that the
 * gate lets through lands on a clean 404 — proving the gate is open for ADMIN
 * without asserting a specific success body.
 *
 * Run from apps/api:
 *   npx jest --config test/tda007/jest.config.js scanner-admin --verbose
 */

// JwtStrategy reads JWT_SECRET at construction; set it before any import.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda007';

import { INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/modules/auth/guards/roles.guard';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { AnandDualTrackController } from '../../src/modules/anand-dual-track/controllers/anand-dual-track.controller';
import { AnandDualTrackRepository } from '../../src/modules/anand-dual-track/repositories/anand-dual-track.repository';
import { AngelOneAdapterService } from '../../src/modules/market-data/services/angel-one-adapter.service';
import { ChartinkRepository } from '../../src/modules/chartink/repositories/chartink.repository';
import { SubscriptionService } from '../../src/modules/subscription/subscription.service';

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

// `tagScanner` is the only handler exercised here and it touches ONLY the
// Chartink repo; returning null makes an ADMIN that clears the gate land on a
// 404 (NotFoundException), so "not 403" proves the gate let ADMIN through.
const chartinkStub = { updateScannerCategory: async () => null };
// Remaining collaborators are never called on this path — stub them so the
// controller can be constructed without a DB / broker / subscription service.
const repoStub = {};
const adapterStub = { getLtpsBatch: async () => new Map<string, number>() };
const subsStub = { hasActive: async () => true };

@Module({
  imports: [PassportModule],
  controllers: [AnandDualTrackController],
  providers: [
    JwtStrategy,
    // Order matters: JwtAuthGuard populates req.user, RolesGuard reads its role.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: AnandDualTrackRepository, useValue: repoStub },
    { provide: AngelOneAdapterService, useValue: adapterStub },
    { provide: ChartinkRepository, useValue: chartinkStub },
    { provide: SubscriptionService, useValue: subsStub },
  ],
})
class ScannerAdminTestModule {}

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

/** PATCH helper bound to a base URL; returns the HTTP status + parsed JSON. */
const patchJsonFor =
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
      method: 'PATCH',
      headers,
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  };

let app: INestApplication;
let patchJson: ReturnType<typeof patchJsonFor>;
const userToken = tokenFor('user-tda007-scanner', 'USER');
const adminToken = tokenFor('admin-tda007-scanner', 'ADMIN');
const ROUTE = '/api/anand/scanners/some-scanner-id/category';

beforeAll(async () => {
  const booted = await boot(ScannerAdminTestModule);
  app = booted.app;
  patchJson = patchJsonFor(booted.baseUrl);
});

afterAll(async () => {
  await app?.close();
});

describe('TDA-007 — scanner-category write is ADMIN-only', () => {
  it('USER PATCH tagScanner → 403 (RolesGuard denies)', async () => {
    const { status } = await patchJson(ROUTE, { category: 'momentum' }, userToken);
    expect(status).toBe(403);
  });

  it('ADMIN PATCH tagScanner → NOT 403 (gate lets ADMIN through)', async () => {
    const { status } = await patchJson(ROUTE, { category: 'momentum' }, adminToken);
    // 404 here (Chartink stub returns null); the point is the gate did not 403.
    expect(status).not.toBe(403);
  });
});
