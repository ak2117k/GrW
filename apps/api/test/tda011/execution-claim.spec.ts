/**
 * TDA-011 Phase 1 — ExecutionClaimService (DB-backed local idempotency store).
 *
 * The store is the at-most-once backstop for the per-user auto-execution
 * pipeline: a CLAIMED row is inserted BEFORE any side effect (decrypt / broker
 * order). These tests prove:
 *   - first claim on a key → { acquired: true } + one CLAIMED row;
 *   - a second (sequential) claim on the same key → { acquired: false }, no throw,
 *     still exactly one row;
 *   - a CONCURRENT double-claim (Promise.all of N identical claims) → EXACTLY ONE
 *     { acquired: true }, the rest { acquired: false } — proving the @unique
 *     constraint (not a check-then-insert race) is the guarantee;
 *   - markPlaced flips status → PLACED + records brokerOrderId;
 *   - markFailed flips status → FAILED + records the error.
 *
 * ExecutionClaim is NOT a tenant-scoped model, so a raw PrismaClient (no tenant
 * middleware) is a faithful stand-in for how the queue worker writes it (no
 * request context). Uses the throw-away scratch DB.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:5432/td_saas_tda011a \
 *     npx jest --config test/tda011/jest.config.js execution-claim --runInBand --verbose
 */
import { PrismaClient } from '@prisma/client';
import { ExecutionClaimService } from '../../src/modules/auto-execution/services/execution-claim.service';

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error('DATABASE_URL_TEST must point at the scratch td_saas_tda011a DB');
}

const prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
// ExecutionClaim is not tenant-scoped; the raw client matches the worker's
// unscoped write path. Cast to the service's PrismaService param (structurally
// compatible for the delegates the service touches).
const service = new ExecutionClaimService(prisma as never);

const KEY_PREFIX = 'tda011-claim-spec';
const USER = 'usr_tda011_spec';
const ENTRY = 'entry_tda011_spec';

async function cleanup(): Promise<void> {
  await prisma.executionClaim.deleteMany({
    where: { idempotencyKey: { startsWith: KEY_PREFIX } },
  });
}

beforeAll(async () => {
  await prisma.$connect();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('ExecutionClaimService.claim', () => {
  it('acquires a fresh key and inserts a single CLAIMED row', async () => {
    const key = `${KEY_PREFIX}-fresh`;
    const res = await service.claim({ idempotencyKey: key, userId: USER, entryId: ENTRY });

    expect(res).toEqual({ acquired: true });

    const rows = await prisma.executionClaim.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('CLAIMED');
    expect(rows[0].userId).toBe(USER);
    expect(rows[0].entryId).toBe(ENTRY);
    expect(rows[0].brokerOrderId).toBeNull();
    expect(rows[0].error).toBeNull();
  });

  it('returns { acquired: false } (no throw) on a duplicate sequential claim, keeping one row', async () => {
    const key = `${KEY_PREFIX}-dup`;
    const first = await service.claim({ idempotencyKey: key, userId: USER, entryId: ENTRY });
    const second = await service.claim({ idempotencyKey: key, userId: USER, entryId: ENTRY });

    expect(first).toEqual({ acquired: true });
    expect(second).toEqual({ acquired: false });

    const count = await prisma.executionClaim.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);
  });

  it('CONCURRENT double-claim: exactly one { acquired: true } across N racing claims (@unique is the guarantee)', async () => {
    const key = `${KEY_PREFIX}-race`;
    const N = 10;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        service.claim({ idempotencyKey: key, userId: USER, entryId: ENTRY }),
      ),
    );

    const acquired = results.filter((r) => r.acquired).length;
    expect(acquired).toBe(1);
    expect(results.filter((r) => !r.acquired)).toHaveLength(N - 1);

    const count = await prisma.executionClaim.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);
  });
});

describe('ExecutionClaimService.markPlaced / markFailed', () => {
  it('markPlaced flips status → PLACED and records the broker order id', async () => {
    const key = `${KEY_PREFIX}-placed`;
    await service.claim({ idempotencyKey: key, userId: USER, entryId: ENTRY });

    await service.markPlaced(key, 'BRK-ORDER-123');

    const row = await prisma.executionClaim.findUnique({ where: { idempotencyKey: key } });
    expect(row?.status).toBe('PLACED');
    expect(row?.brokerOrderId).toBe('BRK-ORDER-123');
    expect(row?.error).toBeNull();
  });

  it('markFailed flips status → FAILED and records the error', async () => {
    const key = `${KEY_PREFIX}-failed`;
    await service.claim({ idempotencyKey: key, userId: USER, entryId: ENTRY });

    await service.markFailed(key, 'BROKER_REJECT: insufficient margin');

    const row = await prisma.executionClaim.findUnique({ where: { idempotencyKey: key } });
    expect(row?.status).toBe('FAILED');
    expect(row?.error).toBe('BROKER_REJECT: insufficient margin');
    expect(row?.brokerOrderId).toBeNull();
  });
});
