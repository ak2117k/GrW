/**
 * TDA-015 Task 5 — billing routes + @Public() webhook + module wiring.
 *
 * Style-A focused HTTP app (mirrors test/tda007/gate.spec): REAL AuthModule
 * guards (APP_GUARD JwtAuthGuard + JwtStrategy), REAL SubscriptionModule +
 * BillingModule with BILLING_PROVIDER=fake, against the td_saas_tda015 scratch
 * DB. The app is created with { rawBody: true } so the webhook controller can
 * read the exact bytes the HMAC was computed over (the single main.ts concern).
 *
 * Proves:
 *   - anonymous POST /api/me/billing/checkout -> 401;
 *   - authed checkout { segment: INTRADAY } -> 201 + checkout payload; the row is
 *     PAST_DUE with providerSubId; GET /api/me/subscriptions still INTRADAY:false;
 *   - POST /webhooks/razorpay with a VALID fake signature for that sub's charged
 *     event -> 200; GET /api/me/subscriptions now INTRADAY:true;
 *   - forged signature -> 401; the webhook route needs no bearer (bypasses guard).
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda015 \
 *     npx jest --config test/tda015/jest.config.js billing-routes --runInBand --verbose
 */
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-tda015';
process.env.BILLING_PROVIDER = 'fake';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at the scratch td_saas_tda015 DB');
process.env.DATABASE_URL = url;

import { INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AddressInfo } from 'net';
import { createHmac } from 'crypto';
import { ClsModule } from 'nestjs-cls';
import configuration from '../../src/config/configuration';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { TenantModule } from '../../src/common/tenant/tenant.module';
import { AuditModule } from '../../src/common/audit/audit.module';
import { JwtAuthGuard } from '../../src/modules/auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { SubscriptionModule } from '../../src/modules/subscription/subscription.module';
import { BillingModule } from '../../src/modules/billing/billing.module';
import { FAKE_WEBHOOK_SECRET } from '../../src/modules/billing/providers/fake-payment.provider';

const jwt = new JwtService();
const tokenFor = (sub: string, role: 'USER' | 'ADMIN') =>
  jwt.sign(
    { sub, role, email: `${role.toLowerCase()}@test.local` },
    { secret: process.env.JWT_SECRET, algorithm: 'HS256', audience: 'td-access', expiresIn: '15m' },
  );

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    TenantModule,
    PrismaModule,
    AuditModule,
    PassportModule,
    SubscriptionModule,
    BillingModule,
  ],
  providers: [JwtStrategy, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
class BillingRoutesTestModule {}

async function boot(): Promise<{ app: INestApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [BillingRoutesTestModule],
  }).compile();
  // rawBody:true is the production main.ts setting — the webhook HMAC verify
  // needs the exact request bytes.
  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

const raw = new PrismaClient({ datasources: { db: { url } } });
const E = 'tda015-routes@test.local';
let userId: string;
let userToken: string;
let app: INestApplication;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await raw.webhookEvent.deleteMany({ where: { eventId: { contains: 'route_wh' } } });
  await raw.subscription.deleteMany({ where: { user: { email: E } } });
  await raw.billingProfile.deleteMany({ where: { user: { email: E } } });
  await raw.user.deleteMany({ where: { email: E } });
}

beforeAll(async () => {
  await cleanup();
  const u = await raw.user.create({ data: { email: E, passwordHash: 'x', role: 'USER' } });
  userId = u.id;
  userToken = tokenFor(userId, 'USER');
  const booted = await boot();
  app = booted.app;
  baseUrl = booted.baseUrl;
});

afterAll(async () => {
  await app?.close();
  await cleanup();
  await raw.$disconnect();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, body: json };
}

async function getSubs(token: string) {
  const res = await fetch(`${baseUrl}/api/me/subscriptions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json();
}

describe('TDA-015 billing routes + webhook', () => {
  let providerSubId: string;

  it('anonymous checkout -> 401', async () => {
    const { status } = await post('/api/me/billing/checkout', { segment: 'INTRADAY' });
    expect(status).toBe(401);
  });

  it('authed checkout -> 201 + checkout payload; row PAST_DUE; still not subscribed', async () => {
    const { status, body } = await post(
      '/api/me/billing/checkout',
      { segment: 'INTRADAY' },
      { authorization: `Bearer ${userToken}` },
    );
    expect(status).toBe(201);
    expect(body.checkout).toBeDefined();
    expect(typeof body.checkout.subscriptionId).toBe('string');
    expect(typeof body.checkout.keyId).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(/secret/i);
    providerSubId = body.checkout.subscriptionId;

    const row = await raw.subscription.findUnique({
      where: { userId_segment: { userId, segment: 'INTRADAY' } },
    });
    expect(row?.status).toBe('PAST_DUE');
    expect(row?.providerSubId).toBe(providerSubId);

    expect(await getSubs(userToken)).toEqual({ INTRADAY: false, SWING: false });
  });

  it('valid webhook charged -> 200; access turns on (no bearer needed)', async () => {
    const currentEnd = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const bodyStr = JSON.stringify({
      entity: 'event',
      event: 'subscription.charged',
      created_at: 1_700_000_500,
      payload: {
        subscription: { entity: { id: providerSubId, current_end: currentEnd } },
        payment: { entity: { id: 'pay_route_wh_1' } },
      },
    });
    const sig = createHmac('sha256', FAKE_WEBHOOK_SECRET).update(Buffer.from(bodyStr)).digest('hex');

    const res = await fetch(`${baseUrl}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig },
      body: bodyStr,
    });
    expect(res.status).toBe(200);

    expect(await getSubs(userToken)).toEqual({ INTRADAY: true, SWING: false });
  });

  it('forged webhook signature -> 401', async () => {
    const bodyStr = JSON.stringify({
      event: 'subscription.charged',
      created_at: 1_700_000_600,
      payload: { subscription: { entity: { id: providerSubId, current_end: 1 } }, payment: { entity: { id: 'pay_route_wh_2' } } },
    });
    const res = await fetch(`${baseUrl}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'deadbeef' },
      body: bodyStr,
    });
    expect(res.status).toBe(401);
  });
});
