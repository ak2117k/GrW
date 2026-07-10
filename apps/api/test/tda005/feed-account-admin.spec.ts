/**
 * Vault→market-feed bridge (design §3.5) — the ADMIN-only feed-account endpoint.
 *
 * `PATCH /api/broker/feed-account { userId }` designates the ONE account whose
 * vault credentials power the shared market-data feed. It is guarded by the
 * global RolesGuard via handler-level `@AdminOnly()` (the rest of BrokerController
 * is caller-scoped USER surface), and the swap runs in a single
 * `prisma.$transaction`: clear the prior feed account, then flag the target.
 *
 * Same DB-backed Style-A harness as broker-endpoint.spec.ts: REAL AuthModule
 * (global JwtAuthGuard → RolesGuard, both APP_GUARDs) + BrokerController +
 * CredentialVaultService, with AngelOneValidator MOCKED (no network). Broker
 * credentials are seeded directly (encrypted-field values are opaque dummies —
 * setFeedAccount only checks for the ROW's existence, never decrypts).
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda005 \
 *     npx jest --config test/tda005/jest.config.js feed-account-admin --verbose
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
import { BrokerOverviewService } from '../../src/modules/credential-vault/services/broker-overview.service';
import { AngelOneValidator } from '../../src/modules/market-data/services/angel-one-validator.service';

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
    // BrokerController also depends on the overview service; the feed-account
    // route never touches it, so an empty stub satisfies DI construction.
    { provide: BrokerOverviewService, useValue: {} },
  ],
})
class FeedAccountTestModule {}

const jwt = new JwtService();
const tokenFor = (role: 'USER' | 'ADMIN', sub: string) =>
  jwt.sign(
    { sub, role, email: `${sub}@test.local` },
    { secret: process.env.JWT_SECRET, algorithm: 'HS256', audience: 'td-access', expiresIn: '15m' },
  );

// Opaque dummies — setFeedAccount checks the row EXISTS, never decrypts it.
const encStub = {
  encApiKey: 'x',
  encApiSecret: 'x',
  encClientId: 'x',
  encPassword: 'x',
  encTotpSecret: 'x',
  encDataKey: 'x',
};

const EMAIL_ADMIN = 'tda005-feed-admin@test.local';
const EMAIL_A = 'tda005-feed-a@test.local'; // has a broker credential → valid target
const EMAIL_B = 'tda005-feed-b@test.local'; // has a credential + starts as feed account
const EMAIL_NOCRED = 'tda005-feed-nocred@test.local'; // no broker credential → 400

const ALL_EMAILS = [EMAIL_ADMIN, EMAIL_A, EMAIL_B, EMAIL_NOCRED];

let app: INestApplication;
let baseUrl: string;
let adminId: string;
let userAId: string;
let userBId: string;
let userNoCredId: string;

async function cleanup(): Promise<void> {
  // Cascade deletes broker_credentials via the FK onDelete: Cascade.
  await raw.user.deleteMany({ where: { email: { in: ALL_EMAILS } } });
}

beforeAll(async () => {
  await cleanup();
  const [admin, a, b, nocred] = await Promise.all([
    raw.user.create({ data: { email: EMAIL_ADMIN, passwordHash: 'x', role: 'ADMIN' } }),
    raw.user.create({ data: { email: EMAIL_A, passwordHash: 'x', role: 'USER' } }),
    // userB starts as the current feed account.
    raw.user.create({ data: { email: EMAIL_B, passwordHash: 'x', role: 'USER', isFeedAccount: true } }),
    raw.user.create({ data: { email: EMAIL_NOCRED, passwordHash: 'x', role: 'USER' } }),
  ]);
  adminId = admin.id;
  userAId = a.id;
  userBId = b.id;
  userNoCredId = nocred.id;

  await Promise.all([
    raw.brokerCredential.create({ data: { userId: userAId, ...encStub } }),
    raw.brokerCredential.create({ data: { userId: userBId, ...encStub } }),
  ]);

  const moduleRef = await Test.createTestingModule({ imports: [FeedAccountTestModule] }).compile();
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

async function patch(path: string, token: string | undefined, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const ROUTE = '/api/broker/feed-account';

describe('vault→market-feed bridge — PATCH /api/broker/feed-account (ADMIN-only)', () => {
  it('a non-admin (USER) caller -> 403 (RolesGuard denies)', async () => {
    const r = await patch(ROUTE, tokenFor('USER', userAId), { userId: userAId });
    expect(r.status).toBe(403);
    // The USER never reached the handler, so no flag changed.
    const a = await raw.user.findUnique({ where: { id: userAId } });
    expect(a?.isFeedAccount).toBe(false);
  });

  it('admin + target has NO broker credential -> 400', async () => {
    const r = await patch(ROUTE, tokenFor('ADMIN', adminId), { userId: userNoCredId });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('User has no connected broker account');
    const nc = await raw.user.findUnique({ where: { id: userNoCredId } });
    expect(nc?.isFeedAccount).toBe(false);
  });

  it('admin + unknown user -> 404', async () => {
    const r = await patch(ROUTE, tokenFor('ADMIN', adminId), { userId: 'does-not-exist' });
    expect(r.status).toBe(404);
  });

  it('admin transactional swap: prior feed account (B) is unset, target (A) is set', async () => {
    // Precondition: B is the current feed account, A is not.
    const before = await raw.user.findMany({
      where: { id: { in: [userAId, userBId] } },
      select: { id: true, isFeedAccount: true },
    });
    expect(before.find((u) => u.id === userBId)?.isFeedAccount).toBe(true);
    expect(before.find((u) => u.id === userAId)?.isFeedAccount).toBe(false);

    const r = await patch(ROUTE, tokenFor('ADMIN', adminId), { userId: userAId });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ userId: userAId, email: EMAIL_A });

    // Exactly one feed account, and it is A.
    const feeds = await raw.user.findMany({ where: { isFeedAccount: true } });
    expect(feeds.map((u) => u.id)).toEqual([userAId]);
    const b = await raw.user.findUnique({ where: { id: userBId } });
    expect(b?.isFeedAccount).toBe(false);
  });

  it('never leaks secret credential fields in the response', async () => {
    const r = await patch(ROUTE, tokenFor('ADMIN', adminId), { userId: userAId });
    expect(r.status).toBe(200);
    const s = JSON.stringify(r.body);
    for (const k of Object.keys(encStub)) expect(s).not.toContain(k);
    expect(s).not.toContain('password');
  });

  it('rejects an empty userId (DTO validation) -> 400', async () => {
    const r = await patch(ROUTE, tokenFor('ADMIN', adminId), { userId: '' });
    expect(r.status).toBe(400);
  });
});
