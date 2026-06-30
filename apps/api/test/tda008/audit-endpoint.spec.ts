/**
 * TDA-008 Task 4 — @AdminOnly audit read / verify / export endpoint (HTTP).
 *
 * Style-A focused-boot harness, mirroring test/tda003/rbac.spec.ts: a
 * production-like root module wires the REAL global guards (JwtAuthGuard then
 * RolesGuard, both owned by AuthModule) plus the @Global AuditModule (which now
 * registers AuditController). We mint `td-access` JWTs with the same claims
 * TokenService.signAccess produces and exercise the controller over real HTTP.
 *
 * Coverage:
 *   - USER  → GET /api/admin/audit          → 403 (RolesGuard denies non-ADMIN)
 *   - ADMIN → GET /api/admin/audit          → 200 (list, seq stringified)
 *   - ADMIN → GET /api/admin/audit/verify   → 200 + body.ok === true
 *
 * The td_saas_test `global` chain may be empty (verify → { ok:true, checked:0,
 * head:null }); we assert only ok === true so the test holds whether or not
 * prior rows exist. We additionally seed two rows via AuditService.append so the
 * list/export BigInt→string serialisation is exercised against real data.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST='postgresql://postgres:postgres@127.0.0.1:5432/td_saas_test' \
 *     npx jest --config test/tda008/jest.config.js audit-endpoint --verbose
 */

// JwtStrategy + token signing both read JWT_SECRET from the environment; set it
// before any strategy/module is imported/instantiated.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda008';

// The REAL AuthModule + AuditService both boot PrismaService, which resolves its
// connection from DATABASE_URL via super(). Point it at td_saas_test before any
// module is imported/instantiated (mirrors rbac.spec / isolation.spec).
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

import { INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { ClsModule } from 'nestjs-cls';
import { AuditModule } from '../../src/common/audit/audit.module';
import { AuditService } from '../../src/common/audit/audit.service';
import { TenantModule } from '../../src/common/tenant/tenant.module';
import { AuthModule } from '../../src/modules/auth/auth.module';

// Mint an access token with exactly the claims JwtStrategy requires:
// audience 'td-access' + { sub, role, email }.
const jwt = new JwtService();
const tokenFor = (role: 'USER' | 'ADMIN') =>
  jwt.sign(
    { sub: `user-${role}`, role, email: `${role.toLowerCase()}@test.local` },
    {
      secret: process.env.JWT_SECRET,
      algorithm: 'HS256',
      audience: 'td-access',
      expiresIn: '15m',
    },
  );

// Production-like root: mirror AppModule's globally-scoped infrastructure so the
// REAL AuthModule (and its global guards) resolve, then add the @Global
// AuditModule under test.
@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    TenantModule,
    AuthModule,
    AuditModule,
  ],
})
class ProductionLikeRootModule {}

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

/** GET helper bound to a base URL; returns the HTTP status only. */
const getter =
  (baseUrl: string) =>
  async (path: string, token?: string): Promise<number> => {
    const headers: Record<string, string> = {};
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { headers });
    return res.status;
  };

/** GET helper that also parses the JSON body → { status, body }. */
const getJsonner =
  (baseUrl: string) =>
  async (
    path: string,
    token?: string,
  ): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {};
    if (token) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { headers });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

describe('TDA-008 Task 4 — @AdminOnly audit endpoint (list/verify/export)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let get: ReturnType<typeof getter>;
  let getJson: ReturnType<typeof getJsonner>;

  beforeAll(async () => {
    const booted = await boot(ProductionLikeRootModule);
    app = booted.app;
    baseUrl = booted.baseUrl;
    get = getter(baseUrl);
    getJson = getJsonner(baseUrl);

    // Seed two rows on the global chain so list/export exercise the
    // BigInt→string serialisation against real data. Appending BEFORE the
    // verify assertion keeps the chain valid (ok:true) regardless of count.
    // userId omitted (→ null): the row carries no FK to the users table, so
    // seeding never trips audit_logs_userId_fkey on a fresh td_saas_test.
    const audit = app.get(AuditService);
    await audit.append({ action: 'AUTH_LOGIN', chainKey: 'global' });
    await audit.append({ action: 'AUTH_LOGIN', chainKey: 'global' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('USER is forbidden (403) on GET /api/admin/audit', async () => {
    expect(await get('/api/admin/audit', tokenFor('USER'))).toBe(403);
  });

  it('ADMIN can list (200) on GET /api/admin/audit', async () => {
    expect(await get('/api/admin/audit', tokenFor('ADMIN'))).toBe(200);
  });

  it('ADMIN list returns rows with seq serialised as a STRING', async () => {
    const { status, body } = await getJson('/api/admin/audit', tokenFor('ADMIN'));
    expect(status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect(typeof body.items[0].seq).toBe('string');
    expect(typeof body.items[0].hash).toBe('string');
    expect(typeof body.items[0].prevHash).toBe('string');
  });

  it('ADMIN verify returns 200 and body.ok === true for the global chain', async () => {
    const { status, body } = await getJson('/api/admin/audit/verify', tokenFor('ADMIN'));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('USER is forbidden (403) on GET /api/admin/audit/verify', async () => {
    expect(await get('/api/admin/audit/verify', tokenFor('USER'))).toBe(403);
  });

  it('ADMIN export streams NDJSON with seq stringified per row', async () => {
    const res = await fetch(`${baseUrl}/api/admin/audit/export`, {
      headers: { authorization: `Bearer ${tokenFor('ADMIN')}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]);
    expect(typeof first.seq).toBe('string');
    expect(typeof first.hash).toBe('string');
  });
});
