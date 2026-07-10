/**
 * TDA-005 Task 8 — broker HTTP surface (Style-A focused boot, DB-backed).
 *
 * Boots a focused Nest app: the REAL AuthModule (global JwtAuthGuard) + the new
 * BrokerController + CredentialVaultService, with AngelOneValidator MOCKED (no
 * network). Two seeded users prove per-user isolation via @CurrentUser('userId').
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda005 \
 *     npx jest --config test/tda005/jest.config.js broker-endpoint --verbose
 */
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda005';

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error('DATABASE_URL_TEST must point at the scratch td_saas_tda005 DB');
}
process.env.DATABASE_URL = testUrl;
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'master-key-passphrase-tda005-xxxxxxxx';

import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { PrismaClient } from '@prisma/client';
import { ClsModule } from 'nestjs-cls';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { AuditModule } from '../../src/common/audit/audit.module';
import { KmsModule } from '../../src/common/crypto/kms/kms.module';
import { ConfigModule } from '@nestjs/config';
import { TenantModule } from '../../src/common/tenant/tenant.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { BrokerController } from '../../src/modules/credential-vault/controllers/broker.controller';
import { CredentialVaultService } from '../../src/modules/credential-vault/services/credential-vault.service';
import { AngelOneValidator } from '../../src/modules/market-data/services/angel-one-validator.service';
import { BrokerOverviewService } from '../../src/modules/credential-vault/services/broker-overview.service';

const raw = new PrismaClient({ datasources: { db: { url: testUrl } } });
const validator = { validateLogin: jest.fn() };

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 100_000 }] }),
    TenantModule,
    PrismaModule,
    AuditModule,
    KmsModule,
    AuthModule,
  ],
  controllers: [BrokerController],
  providers: [
    CredentialVaultService,
    { provide: AngelOneValidator, useValue: validator },
    // GET /api/broker/overview isn't exercised here, but BrokerController requires
    // BrokerOverviewService at construction (TDA-017); stub so DI resolves.
    { provide: BrokerOverviewService, useValue: {} },
  ],
})
class BrokerTestModule {}

const jwt = new JwtService();
const tokenFor = (role: 'USER' | 'ADMIN', sub: string) =>
  jwt.sign(
    { sub, role, email: `${sub}@test.local` },
    { secret: process.env.JWT_SECRET, algorithm: 'HS256', audience: 'td-access', expiresIn: '15m' },
  );

const dto = {
  apiKey: 'API_KEY_H',
  apiSecret: 'API_SECRET_H',
  clientId: 'HH3456',
  password: 'PIN7777',
  totpSecret: 'JBSWY3DPEHPK3PXP',
};

const EMAIL_1 = 'tda005-http-1@test.local';
const EMAIL_2 = 'tda005-http-2@test.local';
let app: INestApplication;
let baseUrl: string;
let u1: string;
let u2: string;

async function cleanup(): Promise<void> {
  await raw.user.deleteMany({ where: { email: { in: [EMAIL_1, EMAIL_2] } } });
}

beforeAll(async () => {
  await cleanup();
  const [a, b] = await Promise.all([
    raw.user.create({ data: { email: EMAIL_1, passwordHash: 'x', role: 'USER' } }),
    raw.user.create({ data: { email: EMAIL_2, passwordHash: 'x', role: 'USER' } }),
  ]);
  u1 = a.id;
  u2 = b.id;

  const moduleRef = await Test.createTestingModule({ imports: [BrokerTestModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  await app.init();
  await app.listen(0);
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await cleanup();
  await raw.$disconnect();
});

async function post(path: string, token: string | undefined, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function get(path: string, token: string | undefined) {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function del(path: string, token: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status };
}

describe('TDA-005 broker HTTP surface', () => {
  it('POST /api/broker/connect (valid + mocked validator) -> 200 {connected:true}', async () => {
    validator.validateLogin.mockResolvedValue({ success: true, clientName: 'Test' });
    const r = await post('/api/broker/connect', tokenFor('USER', u1), dto);
    expect(r.status).toBe(200);
    expect(r.body.connected).toBe(true);
  });

  it('GET /api/broker/status -> connected with masked client-id', async () => {
    const r = await get('/api/broker/status', tokenFor('USER', u1));
    expect(r.status).toBe(200);
    expect(r.body.connected).toBe(true);
    expect(r.body.clientIdMasked).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toContain(dto.apiKey);
  });

  it('is per-user isolated: a second user sees {connected:false}', async () => {
    const r = await get('/api/broker/status', tokenFor('USER', u2));
    expect(r.status).toBe(200);
    expect(r.body.connected).toBe(false);
  });

  it('requires auth: no token -> 401', async () => {
    const r = await get('/api/broker/status', undefined);
    expect(r.status).toBe(401);
  });

  it('a failed validator -> 422 and status stays {connected:false}', async () => {
    validator.validateLogin.mockResolvedValue({ success: false });
    const r = await post('/api/broker/connect', tokenFor('USER', u2), dto);
    expect(r.status).toBe(422);
    const s = await get('/api/broker/status', tokenFor('USER', u2));
    expect(s.body.connected).toBe(false);
  });

  it('DELETE /api/broker -> 204 and status flips to {connected:false}', async () => {
    const r = await del('/api/broker', tokenFor('USER', u1));
    expect(r.status).toBe(204);
    const s = await get('/api/broker/status', tokenFor('USER', u1));
    expect(s.body.connected).toBe(false);
  });
});
