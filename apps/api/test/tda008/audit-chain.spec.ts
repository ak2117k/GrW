/**
 * TDA-008 Task 3 — AuditService hash-chain (append + verifyChain).
 *
 * DB-backed against the throw-away `td_saas_test` database. Mirrors
 * test/tda003/isolation.spec.ts for setup: DATABASE_URL is pointed at the test
 * DB BEFORE PrismaService is constructed, the scoped PrismaService is wired
 * exactly as Nest would (ClsService -> TenantContextService -> PrismaService),
 * and a second raw PrismaClient seeds / mutates as ground truth (bypassing both
 * the tenant extension and AuditService.append).
 *
 * AuditLog is NOT a tenant model, so append/verify pass through the extension
 * UNSCOPED — exactly what a single global-style chain needs. Each test uses a
 * UNIQUE chainKey so concurrent rows never collide with the dev `global` chain
 * or with each other.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda008/jest.config.js audit-chain --verbose
 */

import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenant/tenant-context.service';
import { AuditService } from '../../src/common/audit/audit.service';

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error(
    'DATABASE_URL_TEST must be set to the td_saas_test connection string ' +
      '(e.g. postgresql://postgres:postgres@127.0.0.1:5432/td_saas_test)',
  );
}

// PrismaService resolves its connection from DATABASE_URL (via super()). Point
// it at the test DB so a stray run can NEVER touch the real td_saas database.
process.env.DATABASE_URL = testUrl;

// Ground-truth client: bypasses the tenant extension and AuditService entirely.
const raw = new PrismaClient({ datasources: { db: { url: testUrl } } });

const als = new AsyncLocalStorage<Record<string, unknown>>();
const cls = new ClsService(als);
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);
const svc = new AuditService(prisma);

// audit_logs.userId carries an FK to users; seed one real user so appends that
// set userId satisfy the constraint. (Value is irrelevant to the hash chain.)
const USER_EMAIL = 'tda008-audit@test.local';
let userId: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  await raw.user.deleteMany({ where: { email: USER_EMAIL } });
  const u = await raw.user.create({
    data: { email: USER_EMAIL, passwordHash: 'x', role: 'USER' },
  });
  userId = u.id;
});

afterAll(async () => {
  // Remove this test's audit rows, then the seed user (rows reference it).
  await raw.auditLog.deleteMany({ where: { userId } });
  await raw.user.deleteMany({ where: { email: USER_EMAIL } });
  await raw.$disconnect();
  await prisma.$disconnect();
});

describe('TDA-008 Task 3 — AuditService.append + verifyChain', () => {
  it('chains sequential appends (seq 1n, 2n) and verifies ok', async () => {
    const ck = `test-${Date.now()}`;
    const a = await svc.append({ action: 'AUTH_LOGIN', userId, chainKey: ck });
    const b = await svc.append({ action: 'AUTH_LOGOUT', userId, chainKey: ck });

    expect(a.seq).toBe(1n);
    expect(b.seq).toBe(2n);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.hash).toMatch(/^[0-9a-f]{64}$/);

    const v = await svc.verifyChain(ck);
    expect(v.ok).toBe(true);
    expect(v.ok && v.checked).toBe(2);
    expect(v.ok && v.head?.seq).toBe(2n);
    expect(v.ok && v.head?.hash).toBe(b.hash);
  });

  it('is concurrency-safe under 20-way parallel append (no gaps, no dupes)', async () => {
    const ck = `test-conc-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        svc.append({ action: 'AUTH_LOGIN', userId, chainKey: ck }),
      ),
    );

    // Every seq 1..20 present exactly once.
    const seqs = results.map((r) => r.seq).sort((x, y) => Number(x - y));
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(i + 1)));

    const v = await svc.verifyChain(ck);
    expect(v.ok).toBe(true);
    expect(v.ok && v.checked).toBe(20);
    expect(v.ok && v.head?.seq).toBe(20n);
  });

  it('detects an edited row (tamper on seq 1) → ok:false, firstBrokenSeq 1n', async () => {
    const ck = `test-tamper-${Date.now()}`;
    await svc.append({ action: 'AUTH_LOGIN', userId, chainKey: ck });
    await svc.append({ action: 'AUTH_LOGIN', userId, chainKey: ck });

    // Mutate seq 1's action directly via raw prisma (bypassing append). The
    // stored hash no longer matches the recomputed hash for seq 1.
    await raw.auditLog.updateMany({
      where: { chainKey: ck, seq: 1n },
      data: { action: 'AUTH_LOGOUT' },
    });

    const v = await svc.verifyChain(ck);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.firstBrokenSeq).toBe(1n);
    expect(!v.ok && v.reason).toBe('HASH_MISMATCH');
  });

  it('verifies an empty chain as ok with checked 0 and null head', async () => {
    const ck = `test-empty-${Date.now()}`;
    const v = await svc.verifyChain(ck);
    expect(v.ok).toBe(true);
    expect(v.ok && v.checked).toBe(0);
    expect(v.ok && v.head).toBeNull();
  });
});
