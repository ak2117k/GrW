/**
 * TDA-009 Task 5 — consent HTTP API (Style-A focused boot).
 *
 * A production-like root wires the REAL global guards (JwtAuthGuard then
 * RolesGuard, from AuthModule) plus the @Global AuditModule + ConsentModule.
 * We mint `td-access` JWTs whose `sub` is a REAL seeded user id (accept/publish
 * append audit rows FK'd to users, and we keep users to preserve the chain).
 *
 * Coverage (spec §7 / AC4-6):
 *   - USER  GET  /api/consent/current  → 200
 *   - USER  GET  /api/consent/status   → accepted:false
 *   - USER  POST /api/consent/accept   → 201, status flips to accepted:true
 *   - USER  POST /api/admin/consent/publish → 403 (RolesGuard)
 *   - ADMIN POST /api/admin/consent/publish → 201, forces reconsent
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda009 \
 *     npx jest --config test/tda009/jest.config.js consent-endpoint --verbose
 */

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda009';
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

import { INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AddressInfo } from 'net';
import { ClsModule } from 'nestjs-cls';
import { AuditModule } from '../../src/common/audit/audit.module';
import { TenantModule } from '../../src/common/tenant/tenant.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { ConsentModule } from '../../src/modules/consent/consent.module';
import { ConsentService } from '../../src/modules/consent/consent.service';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at the tda009 scratch DB');

const raw = new PrismaClient({ datasources: { db: { url } } });
const jwt = new JwtService();
const suffix = Date.now().toString();

const sign = (sub: string, role: 'USER' | 'ADMIN') =>
  jwt.sign(
    { sub, role, email: `${role.toLowerCase()}-${suffix}@test.local` },
    { secret: process.env.JWT_SECRET, algorithm: 'HS256', audience: 'td-access', expiresIn: '15m' },
  );

@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    TenantModule,
    AuthModule,
    AuditModule,
    ConsentModule,
  ],
})
class ProductionLikeRootModule {}

describe('TDA-009 Task 5 — consent HTTP API', () => {
  let app: INestApplication;
  let baseUrl: string;
  let userToken: string;
  let adminToken: string;

  const req = async (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };
  const getJson = (p: string, t?: string) => req('GET', p, t);
  const postJson = (p: string, b: unknown, t?: string) => req('POST', p, t, b);

  beforeAll(async () => {
    const uEmail = `tda009-ep-user-${suffix}@test.local`;
    const aEmail = `tda009-ep-admin-${suffix}@test.local`;
    const u = await raw.user.create({ data: { email: uEmail, passwordHash: 'x', role: 'USER' } });
    const a = await raw.user.create({ data: { email: aEmail, passwordHash: 'x', role: 'ADMIN' } });
    userToken = sign(u.id, 'USER');
    adminToken = sign(a.id, 'ADMIN');

    const moduleRef = await Test.createTestingModule({
      imports: [ProductionLikeRootModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Establish a known current version (the service spec may have left no
    // active doc). actorUserId null → audit userId null (no FK dependency).
    await app.get(ConsentService).publish('risk-disclosure', `ep-${suffix}.1`, 'ENDPOINT BODY', null);
  });

  afterAll(async () => {
    await raw.$disconnect();
    await app?.close();
  });

  it('USER can read the current disclosure', async () => {
    const r = await getJson('/api/consent/current', userToken);
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(`ep-${suffix}.1`);
    expect(r.body.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('USER status starts unaccepted', async () => {
    const r = await getJson('/api/consent/status', userToken);
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(false);
  });

  it('accept flips status; admin publish forces reconsent', async () => {
    const cur = (await getJson('/api/consent/current', userToken)).body;
    const acc = await postJson(
      '/api/consent/accept',
      { version: cur.version, contentHash: cur.contentHash },
      userToken,
    );
    expect(acc.status).toBe(201);
    expect((await getJson('/api/consent/status', userToken)).body.accepted).toBe(true);

    // USER cannot publish (RolesGuard), ADMIN can.
    const forbidden = await postJson(
      '/api/admin/consent/publish',
      { version: `ep-${suffix}.9`, body: 'NEW' },
      userToken,
    );
    expect(forbidden.status).toBe(403);

    const published = await postJson(
      '/api/admin/consent/publish',
      { version: `ep-${suffix}.9`, body: 'NEW' },
      adminToken,
    );
    expect(published.status).toBe(201);

    // Version bump → re-consent forced for the user.
    const after = (await getJson('/api/consent/status', userToken)).body;
    expect(after.accepted).toBe(false);
    expect(after.requiresReconsent).toBe(true);
  });

  it('accept echoing a wrong contentHash is rejected (409)', async () => {
    const cur = (await getJson('/api/consent/current', userToken)).body;
    const bad = await postJson(
      '/api/consent/accept',
      { version: cur.version, contentHash: 'sha256:' + 'a'.repeat(64) },
      userToken,
    );
    expect(bad.status).toBe(409);
  });
});
