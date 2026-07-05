/**
 * TDA-017 — AutoExecSettingsService (per-user auto-execution controls, Style-B).
 *
 * Real scratch DB `td_saas_tda017`. A raw `PrismaClient` seeds/cleans up; the
 * tenant-scoped `PrismaService` + `TenantContextService` + `AuditService` +
 * `ConsentService` are wired by hand for the SUT.
 *
 * `AutoTradeConsent` IS a tenant model (TDA-003), so every SUT call runs inside
 * a CLS scope carrying the caller's tenant context — Prisma then auto-scopes to
 * that userId. `hasAcceptedCurrent` bypasses tenant scoping internally, so the
 * consent gate works regardless of the active scope.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda017 \
 *     npx jest --config test/tda017/jest.config.js auto-exec-settings --runInBand --verbose
 */

import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { ConsentService } from '../../src/modules/consent/consent.service';
import { AutoExecSettingsService } from '../../src/modules/auto-execution/services/auto-exec-settings.service';

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  throw new Error(
    'DATABASE_URL_TEST must point at the scratch td_saas_tda017 DB ' +
      '(e.g. postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda017)',
  );
}
process.env.DATABASE_URL = url;

const raw = new PrismaClient({ datasources: { db: { url } } });
const cls = new ClsService(new AsyncLocalStorage());
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const audit = new AuditService(prisma);
const consent = new ConsentService(prisma, tenant, audit);
const svc = new AutoExecSettingsService(prisma, consent);

/** Run `fn` inside a CLS scope carrying `userId` as a non-admin tenant. */
const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  cls.run(() => {
    tenant.set({ userId, role: 'USER' });
    return fn();
  });

const suffix = Date.now().toString();
const KIND = 'risk-disclosure';
const version = `tda017-aes-${suffix}`;
let noConsentId: string;
let consentedId: string;
let freshId: string;
let docId: string;

beforeAll(async () => {
  await prisma.onModuleInit();

  const a = await raw.user.create({
    data: { email: `tda017-aes-noc-${suffix}@test.local`, passwordHash: 'x', role: 'USER', status: 'ACTIVE' },
  });
  const b = await raw.user.create({
    data: { email: `tda017-aes-ok-${suffix}@test.local`, passwordHash: 'x', role: 'USER', status: 'ACTIVE' },
  });
  const c = await raw.user.create({
    data: { email: `tda017-aes-fresh-${suffix}@test.local`, passwordHash: 'x', role: 'USER', status: 'ACTIVE' },
  });
  noConsentId = a.id;
  consentedId = b.id;
  freshId = c.id;

  // Ensure an active risk-disclosure document exists, and record that the
  // "consented" user accepted THIS current document.
  const current = await consent.getCurrent(KIND);
  if (current) {
    docId = current.documentId;
  } else {
    const doc = await raw.consentDocument.create({
      data: { kind: KIND, version, body: 'test disclosure', contentHash: `sha256:${version}`, active: true },
    });
    docId = doc.id;
  }
  await raw.consentRecord.create({
    data: { userId: consentedId, documentId: docId, version: version },
  });
});

afterAll(async () => {
  const ids = [noConsentId, consentedId, freshId];
  await raw.autoTradeConsent.deleteMany({ where: { userId: { in: ids } } });
  await raw.consentRecord.deleteMany({ where: { userId: { in: ids } } });
  await raw.user.deleteMany({ where: { id: { in: ids } } });
  await raw.$disconnect();
  await prisma.$disconnect?.();
});

it('rejects enabling auto-exec without an accepted current disclosure (409), row stays disabled', async () => {
  await expect(
    asUser(noConsentId, () => svc.update(noConsentId, 'INTRADAY', { enabled: true })),
  ).rejects.toBeInstanceOf(ConflictException);

  // No row should have been enabled (and none created behind the reject).
  const row = await raw.autoTradeConsent.findUnique({
    where: { userId_segment: { userId: noConsentId, segment: 'INTRADAY' } },
  });
  expect(row?.enabled ?? false).toBe(false);
});

it('enables auto-exec when the user HAS accepted the current disclosure', async () => {
  const res = await asUser(consentedId, () => svc.update(consentedId, 'INTRADAY', { enabled: true, riskPerTrade: 1000, maxCapital: 50000 }));
  expect(res.enabled).toBe(true);
  expect(res.riskPerTrade).toBe(1000);
  expect(res.maxCapital).toBe(50000);
  expect(res.enabledAt).toBeInstanceOf(Date);
});

it('allows setting the kill switch ON without any consent', async () => {
  const res = await asUser(noConsentId, () => svc.update(noConsentId, 'SWING', { killSwitch: true }));
  expect(res.killSwitch).toBe(true);
  expect(res.enabled).toBe(false); // still disabled — kill switch never enables
});

it('getForUser returns both segments, defaulting to disabled where no row exists', async () => {
  const rows = await asUser(freshId, () => svc.getForUser(freshId));
  expect(rows).toHaveLength(2);
  const bySeg = Object.fromEntries(rows.map((r) => [r.segment, r]));
  expect(Object.keys(bySeg).sort()).toEqual(['INTRADAY', 'SWING']);
  for (const seg of ['INTRADAY', 'SWING'] as const) {
    expect(bySeg[seg].enabled).toBe(false);
    expect(bySeg[seg].killSwitch).toBe(false);
    expect(bySeg[seg].riskPerTrade).toBeNull();
    expect(bySeg[seg].maxCapital).toBeNull();
  }
});
