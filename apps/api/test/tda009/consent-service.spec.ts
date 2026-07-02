/**
 * TDA-009 Tasks 3 & 4 — ConsentService (DB-backed, Style-B).
 *
 * Real `td_saas_test` DB. A raw `PrismaClient` seeds/cleans up; `PrismaService`
 * + `TenantContextService` + `AuditService` are wired by hand for the SUT.
 * `ConsentRecord` is a TENANT_MODEL (TDA-003) but the service keys on an
 * explicit `userId` via `runWithoutTenant`, so these checks drive it with NO
 * tenant context — proving the explicit-userId path works.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_tda009 \
 *     npx jest --config test/tda009/jest.config.js consent-service --verbose
 */

import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { ConsentService } from '../../src/modules/consent/consent.service';

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  throw new Error(
    'DATABASE_URL_TEST must be set to the tda009 scratch DB connection string ' +
      '(e.g. postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_tda009)',
  );
}
process.env.DATABASE_URL = url;

const raw = new PrismaClient({ datasources: { db: { url } } });
const cls = new ClsService(new AsyncLocalStorage());
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const audit = new AuditService(prisma);
const svc = new ConsentService(prisma, tenant, audit);

/** Run `fn` inside a CLS scope with NO tenant set (system/background scope). */
const run = <T>(fn: () => Promise<T>): Promise<T> => cls.run(() => fn());

const KIND = 'risk-disclosure';
const suffix = Date.now().toString();
const v1 = `test-${suffix}.1`;
const v2 = `test-${suffix}.2`;
const E = `tda009-consent-${suffix}@test.local`;
let uId: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  await raw.user.deleteMany({ where: { email: E } });
  const u = await raw.user.create({
    data: { email: E, passwordHash: 'x', role: 'USER' },
  });
  uId = u.id;
});

afterAll(async () => {
  await raw.consentRecord.deleteMany({ where: { userId: uId } });
  await raw.consentDocument.deleteMany({ where: { version: { in: [v1, v2] } } });
  await raw.user.deleteMany({ where: { email: E } });
  await raw.$disconnect();
  await prisma.$disconnect();
});

describe('TDA-009 Tasks 3 & 4 — ConsentService', () => {
  it('publish v1: getCurrent returns v1, exactly one active, real hash', async () => {
    await run(() => svc.publish(KIND, v1, 'BODY-1', null));
    const cur = await run(() => svc.getCurrent(KIND));
    expect(cur?.version).toBe(v1);
    expect(cur?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('gate is closed before acceptance', async () => {
    expect(await run(() => svc.hasAcceptedCurrent(uId, KIND))).toBe(false);
  });

  it('accept records ip/userAgent, gate opens, chain verifies', async () => {
    const cur = await run(() => svc.getCurrent(KIND));
    await run(() =>
      svc.accept(uId, v1, cur!.contentHash, '1.2.3.4', 'jest-agent'),
    );
    expect(await run(() => svc.hasAcceptedCurrent(uId, KIND))).toBe(true);

    const rec = await raw.consentRecord.findFirst({ where: { userId: uId } });
    expect(rec?.ipAddress).toBe('1.2.3.4');
    expect(rec?.userAgent).toBe('jest-agent');
    expect(rec?.version).toBe(v1);

    expect((await audit.verifyChain('global')).ok).toBe(true);
    const row = await raw.auditLog.findFirst({
      where: { action: 'CONSENT_ACCEPT', userId: uId, target: v1 },
    });
    expect(row).toBeTruthy();
    expect(typeof row?.hash).toBe('string');
  });

  it('getStatus reflects acceptance of the current version', async () => {
    const s = await run(() => svc.getStatus(uId, KIND));
    expect(s.currentVersion).toBe(v1);
    expect(s.accepted).toBe(true);
    expect(s.acceptedVersion).toBe(v1);
    expect(s.requiresReconsent).toBe(false);
  });

  it('accept is idempotent (one row per user+document)', async () => {
    const cur = await run(() => svc.getCurrent(KIND));
    await run(() => svc.accept(uId, v1, cur!.contentHash, null, null));
    await run(() => svc.accept(uId, v1, cur!.contentHash, null, null));
    const rows = await raw.consentRecord.findMany({
      where: { userId: uId, version: v1 },
    });
    expect(rows.length).toBe(1);
    expect(await run(() => svc.hasAcceptedCurrent(uId, KIND))).toBe(true);
  });

  it('stale version is rejected', async () => {
    await expect(
      run(() => svc.accept(uId, 'nope-not-current', 'sha256:' + 'a'.repeat(64), null, null)),
    ).rejects.toBeTruthy();
  });

  it('content mismatch is rejected', async () => {
    await expect(
      run(() => svc.accept(uId, v1, 'sha256:' + 'b'.repeat(64), null, null)),
    ).rejects.toBeTruthy();
  });

  it('publish v2 deactivates v1 and forces re-consent (single active + audit row)', async () => {
    await run(() => svc.publish(KIND, v2, 'BODY-2', uId));

    const activeCount = await raw.consentDocument.count({
      where: { version: { in: [v1, v2] }, active: true },
    });
    expect(activeCount).toBe(1);
    const cur = await run(() => svc.getCurrent(KIND));
    expect(cur?.version).toBe(v2);

    // Re-consent forced: prior v1 acceptance no longer matches the active doc.
    expect(await run(() => svc.hasAcceptedCurrent(uId, KIND))).toBe(false);
    const s = await run(() => svc.getStatus(uId, KIND));
    expect(s.accepted).toBe(false);
    expect(s.requiresReconsent).toBe(true);
    expect(s.acceptedVersion).toBe(v1);
  });

  // Task 4 — publish appends a fatal CONSENT_VERSION_PUBLISHED audit row.
  it('publish appended a CONSENT_VERSION_PUBLISHED audit row for v2', async () => {
    const pub = await raw.auditLog.findFirst({
      where: { action: 'CONSENT_VERSION_PUBLISHED', target: v2 },
    });
    expect(pub).toBeTruthy();
    expect((await audit.verifyChain('global')).ok).toBe(true);
  });

  it('accepting v2 re-opens the gate; chain still verifies', async () => {
    const cur = await run(() => svc.getCurrent(KIND));
    await run(() => svc.accept(uId, v2, cur!.contentHash, null, null));
    expect(await run(() => svc.hasAcceptedCurrent(uId, KIND))).toBe(true);
    expect((await audit.verifyChain('global')).ok).toBe(true);
  });

  it('revoke closes the gate again', async () => {
    await run(() => svc.revoke(uId, KIND));
    expect(await run(() => svc.hasAcceptedCurrent(uId, KIND))).toBe(false);
    const rev = await raw.auditLog.findFirst({
      where: { action: 'CONSENT_REVOKE', userId: uId },
    });
    expect(rev).toBeTruthy();
  });
});
