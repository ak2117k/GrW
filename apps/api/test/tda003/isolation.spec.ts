/**
 * TDA-003 Task 2 — Prisma tenant-scoping interceptor (security-critical).
 *
 * Drives a real `PrismaService` (with the `$use` scoping middleware) against the
 * throw-away `td_saas_test` database, simulating two tenants A and B. A second
 * raw `PrismaClient` (no middleware) is used to seed and to make ground-truth
 * assertions, so the proofs are independent of the interceptor under test.
 *
 * Tenant context is driven manually: `asTenant(ctx, fn)` opens a `cls.run`
 * scope and (optionally) sets `{ userId, role }` before invoking the scoped
 * client — exactly what the HTTP interceptor does per request.
 *
 * Run from apps/api:
 *   DATABASE_URL_TEST=postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test \
 *     npx jest --config test/tda003/jest.config.js -v
 */

import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  TenantContext,
  TenantContextService,
} from '../../src/common/tenant/tenant-context.service';

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  throw new Error(
    'DATABASE_URL_TEST must be set to the td_saas_test connection string ' +
      '(e.g. postgresql://postgres:<pw>@127.0.0.1:5432/td_saas_test)',
  );
}

// PrismaService resolves its connection from DATABASE_URL (via super()). Point
// it at the test DB so a stray run can NEVER touch the real td_saas database.
process.env.DATABASE_URL = testUrl;

// Ground-truth client: bypasses the scoping middleware entirely.
const raw = new PrismaClient({ datasources: { db: { url: testUrl } } });

// Wire the scoped client exactly as Nest would: ClsService -> TenantContext ->
// PrismaService. The SAME ClsService instance backs both the middleware reads
// and the asTenant() writes, so AsyncLocalStorage propagates the context.
const als = new AsyncLocalStorage<Record<string, unknown>>();
const cls = new ClsService(als);
const tenant = new TenantContextService(cls);
const prisma = new PrismaService(tenant);

/** Run `fn` inside a CLS scope carrying `ctx` (null = active scope, no tenant). */
function asTenant<T>(ctx: TenantContext | null, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    if (ctx) tenant.set(ctx);
    return fn();
  });
}

const SUFFIX = 'tda003-iso';
const EMAIL_A = `${SUFFIX}-a@test.local`;
const EMAIL_B = `${SUFFIX}-b@test.local`;
const INST_TOKEN = 'T003ISO';
const SIGNAL_STRATEGY = 'TDA003_ISO_TEST';

let instId: string;
let userAId: string;
let userBId: string;
let tradeAId: string;
let tradeBId: string;
let signalId: string;
let subAId: string;
let subBId: string;

async function cleanup(): Promise<void> {
  // Deleting the users cascades their trades (Trade.onDelete: Cascade).
  await raw.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
  await raw.signal.deleteMany({ where: { strategy: SIGNAL_STRATEGY } });
  await raw.instrument.deleteMany({ where: { token: INST_TOKEN } });
}

beforeAll(async () => {
  await prisma.onModuleInit();
  await cleanup();

  const inst = await raw.instrument.create({
    data: {
      symbol: 'TDA003ISO',
      token: INST_TOKEN,
      name: 'Isolation Test Instrument',
      exchange: 'NSE',
      segment: 'EQ',
    },
  });
  instId = inst.id;

  const [userA, userB] = await Promise.all([
    raw.user.create({ data: { email: EMAIL_A, passwordHash: 'x', role: 'USER' } }),
    raw.user.create({ data: { email: EMAIL_B, passwordHash: 'x', role: 'USER' } }),
  ]);
  userAId = userA.id;
  userBId = userB.id;

  const baseTrade = {
    instrumentId: instId,
    side: 'BUY',
    orderType: 'MARKET',
    positionType: 'LONG',
    quantity: 1,
  };
  const [tradeA, tradeB] = await Promise.all([
    raw.trade.create({ data: { ...baseTrade, userId: userAId, notes: 'A-original' } }),
    raw.trade.create({ data: { ...baseTrade, userId: userBId, notes: 'B-original' } }),
  ]);
  tradeAId = tradeA.id;
  tradeBId = tradeB.id;

  // Second tenant model (Subscription, @@unique([userId, segment])) — proves
  // scoping is driven by TENANT_MODELS membership, not hard-coded to Trade.
  const [subA, subB] = await Promise.all([
    raw.subscription.create({ data: { userId: userAId, segment: 'INTRADAY' } }),
    raw.subscription.create({ data: { userId: userBId, segment: 'INTRADAY' } }),
  ]);
  subAId = subA.id;
  subBId = subB.id;

  const signal = await raw.signal.create({
    data: {
      instrumentId: instId,
      side: 'BUY',
      entryPrice: 100,
      targetPrice: 110,
      stoplossPrice: 95,
      expectedProfit: 10,
      expectedLoss: 5,
      riskRewardRatio: 2,
      confidence: 'HIGH',
      confidenceScore: 80,
      strategy: SIGNAL_STRATEGY,
      timeframe: '5m',
      reason: 'test',
    },
  });
  signalId = signal.id;
});

afterAll(async () => {
  await cleanup();
  await raw.$disconnect();
  await prisma.$disconnect();
});

const A = (): TenantContext => ({ userId: userAId, role: 'USER' });

describe('TDA-003 Task 2 — read isolation', () => {
  it('findMany returns ONLY tenant A rows', async () => {
    const trades = await asTenant(A(), () => prisma.trade.findMany());
    const ids = trades.map((t) => t.id);
    expect(ids).toContain(tradeAId);
    expect(ids).not.toContain(tradeBId);
    expect(trades.every((t) => t.userId === userAId)).toBe(true);
  });

  it('findUnique on OWN row returns the row', async () => {
    const t = await asTenant(A(), () =>
      prisma.trade.findUnique({ where: { id: tradeAId } }),
    );
    expect(t?.id).toBe(tradeAId);
  });

  it('findUnique on ANOTHER tenant row returns null (the gotcha)', async () => {
    const t = await asTenant(A(), () =>
      prisma.trade.findUnique({ where: { id: tradeBId } }),
    );
    expect(t).toBeNull();
  });
});

describe('TDA-003 Task 2 — write isolation', () => {
  it('update on OWN row succeeds and returns the record', async () => {
    const updated = await asTenant(A(), () =>
      prisma.trade.update({
        where: { id: tradeAId },
        data: { notes: 'A-updated' },
      }),
    );
    expect(updated.id).toBe(tradeAId);
    expect(updated.notes).toBe('A-updated');
  });

  it('update targeting ANOTHER tenant row never modifies it', async () => {
    await expect(
      asTenant(A(), () =>
        prisma.trade.update({
          where: { id: tradeBId },
          data: { notes: 'HACKED' },
        }),
      ),
    ).rejects.toBeDefined();

    const b = await raw.trade.findUnique({ where: { id: tradeBId } });
    expect(b?.notes).toBe('B-original');
  });

  it('delete targeting ANOTHER tenant row never removes it', async () => {
    await expect(
      asTenant(A(), () => prisma.trade.delete({ where: { id: tradeBId } })),
    ).rejects.toBeDefined();

    const b = await raw.trade.findUnique({ where: { id: tradeBId } });
    expect(b).not.toBeNull();
  });

  it('create stamps the context userId even when the payload spoofs another', async () => {
    const created = await asTenant(A(), () =>
      prisma.trade.create({
        data: {
          userId: userBId, // spoof attempt — context must win
          instrumentId: instId,
          side: 'BUY',
          orderType: 'MARKET',
          positionType: 'LONG',
          quantity: 1,
        },
      }),
    );
    const persisted = await raw.trade.findUnique({ where: { id: created.id } });
    expect(persisted?.userId).toBe(userAId);
    await raw.trade.delete({ where: { id: created.id } });
  });
});

describe('TDA-003 Task 2 — bypasses', () => {
  it('ADMIN context sees BOTH tenants rows', async () => {
    const trades = await asTenant({ userId: userAId, role: 'ADMIN' }, () =>
      prisma.trade.findMany(),
    );
    const ids = trades.map((t) => t.id);
    expect(ids).toContain(tradeAId);
    expect(ids).toContain(tradeBId);
  });

  it('NO context (background) sees BOTH tenants rows', async () => {
    // No cls.run at all — exactly how cron/queue/engine code runs.
    const trades = await prisma.trade.findMany();
    const ids = trades.map((t) => t.id);
    expect(ids).toContain(tradeAId);
    expect(ids).toContain(tradeBId);
  });
});

describe('TDA-003 Task 2 — global models are never scoped', () => {
  it('signal.findMany in tenant-A context returns rows (not scoped by userId)', async () => {
    const signals = await asTenant(A(), () =>
      prisma.signal.findMany({ where: { strategy: SIGNAL_STRATEGY } }),
    );
    expect(signals.map((s) => s.id)).toContain(signalId);
  });
});

const baseTradeData = (): {
  instrumentId: string;
  side: string;
  orderType: string;
  positionType: string;
  quantity: number;
} => ({
  instrumentId: instId,
  side: 'BUY',
  orderType: 'MARKET',
  positionType: 'LONG',
  quantity: 1,
});

describe('TDA-003 Task 2 — adversarial cross-tenant bulk writes (I-1)', () => {
  it('updateMany targeting B rows affects 0 rows and leaves B untouched', async () => {
    const res = await asTenant(A(), () =>
      prisma.trade.updateMany({
        where: { id: tradeBId },
        data: { notes: 'HACKED-updateMany' },
      }),
    );
    expect(res.count).toBe(0); // scoped to A → B's id matches nothing

    const b = await raw.trade.findUnique({ where: { id: tradeBId } });
    expect(b?.notes).toBe('B-original');
  });

  it('deleteMany targeting B rows deletes 0 of B', async () => {
    const res = await asTenant(A(), () =>
      prisma.trade.deleteMany({ where: { id: tradeBId } }),
    );
    expect(res.count).toBe(0);

    const b = await raw.trade.findUnique({ where: { id: tradeBId } });
    expect(b).not.toBeNull();
  });

  it('createMany stamps userId=A on every row even when the payload spoofs B', async () => {
    const marker = 'A-createMany-marker';
    const res = await asTenant(A(), () =>
      prisma.trade.createMany({
        data: [
          { ...baseTradeData(), userId: userBId, notes: marker },
          { ...baseTradeData(), userId: userBId, notes: marker },
        ],
      }),
    );
    expect(res.count).toBe(2);

    const rows = await raw.trade.findMany({ where: { notes: marker } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.userId === userAId)).toBe(true);

    await raw.trade.deleteMany({ where: { notes: marker } });
  });
});

describe('TDA-003 Task 2 — adversarial upsert (I-1)', () => {
  it("upsert by B's id does NOT touch B; creates a NEW A-owned row (create.userId:B overridden)", async () => {
    const result = await asTenant(A(), () =>
      prisma.trade.upsert({
        where: { id: tradeBId },
        update: { userId: userBId, notes: 'HACKED-upsert-update' },
        create: { ...baseTradeData(), userId: userBId, notes: 'A-upsert-create' },
      }),
    );

    // B's row is never reached (where is scoped to A → create branch runs).
    const b = await raw.trade.findUnique({ where: { id: tradeBId } });
    expect(b?.notes).toBe('B-original');

    // A brand-new row was created, stamped with the context owner (A), not B.
    expect(result.id).not.toBe(tradeBId);
    expect(result.userId).toBe(userAId);
    const persisted = await raw.trade.findUnique({ where: { id: result.id } });
    expect(persisted?.userId).toBe(userAId);

    await raw.trade.delete({ where: { id: result.id } });
  });

  it("upsert on A's OWN row freezes a spoofed update.userId:B back to A", async () => {
    const result = await asTenant(A(), () =>
      prisma.trade.upsert({
        where: { id: tradeAId },
        update: { userId: userBId, notes: 'A-upsert-updated' }, // userId must be frozen
        create: { ...baseTradeData(), userId: userAId, notes: 'unused' },
      }),
    );

    expect(result.id).toBe(tradeAId); // update branch ran on A's own row
    expect(result.notes).toBe('A-upsert-updated');
    expect(result.userId).toBe(userAId); // ownership not reassigned to B

    const persisted = await raw.trade.findUnique({ where: { id: tradeAId } });
    expect(persisted?.userId).toBe(userAId);
  });
});

describe('TDA-003 Task 2 — aggregates count only A (I-1)', () => {
  it('count returns A-only total (excludes B)', async () => {
    const scoped = await asTenant(A(), () => prisma.trade.count());
    const expectedA = await raw.trade.count({ where: { userId: userAId } });
    const total = await raw.trade.count();

    expect(scoped).toBe(expectedA);
    expect(scoped).toBeLessThan(total); // B has at least one row → total is larger
  });

  it('aggregate computes over A-only rows', async () => {
    const agg = await asTenant(A(), () =>
      prisma.trade.aggregate({ _count: { _all: true } }),
    );
    const expectedA = await raw.trade.count({ where: { userId: userAId } });
    expect(agg._count._all).toBe(expectedA);
  });
});

describe('TDA-003 Task 2 — fail-safe throw (I-1)', () => {
  it('refuses to run a tenant-model op it cannot scope (createMany without data)', async () => {
    // The guard throws rather than running unscoped when it cannot determine how
    // to stamp/scope a tenant-model write. createMany with no `data` is the one
    // unscopable shape reachable through the typed client; the generic
    // "unhandled operation" branch is otherwise unreachable because Prisma's
    // public delegate surface only emits the operations the extension handles —
    // the branch is defensive against future Prisma additions.
    await expect(
      asTenant(A(), () => (prisma.trade as unknown as {
        createMany: () => Promise<unknown>;
      }).createMany()),
    ).rejects.toThrow(/refusing to run unscoped/i);
  });
});

describe('TDA-003 Task 2 — second tenant model: Subscription (I-1)', () => {
  it('findMany returns ONLY A subscriptions', async () => {
    const subs = await asTenant(A(), () => prisma.subscription.findMany());
    const ids = subs.map((s) => s.id);
    expect(ids).toContain(subAId);
    expect(ids).not.toContain(subBId);
    expect(subs.every((s) => s.userId === userAId)).toBe(true);
  });

  it('updateMany targeting B subscription affects 0 rows', async () => {
    const res = await asTenant(A(), () =>
      prisma.subscription.updateMany({
        where: { id: subBId },
        data: { status: 'CANCELLED' },
      }),
    );
    expect(res.count).toBe(0);

    const b = await raw.subscription.findUnique({ where: { id: subBId } });
    expect(b?.status).toBe('ACTIVE');
  });

  it('create stamps userId=A even when the payload spoofs B', async () => {
    const created = await asTenant(A(), () =>
      prisma.subscription.create({
        data: { userId: userBId, segment: 'SWING' }, // spoof + distinct segment
      }),
    );
    const persisted = await raw.subscription.findUnique({
      where: { id: created.id },
    });
    expect(persisted?.userId).toBe(userAId);

    await raw.subscription.delete({ where: { id: created.id } });
  });
});

describe('TDA-003 Task 2 — transaction scoping (I-2)', () => {
  it('updateMany inside an interactive $transaction only affects A rows', async () => {
    const expectedA = await raw.trade.count({ where: { userId: userAId } });

    const res = await asTenant(A(), () =>
      prisma.$transaction((tx) =>
        tx.trade.updateMany({ data: { strategy: 'TXN_A_ONLY' } }),
      ),
    );
    expect(res.count).toBe(expectedA); // scoping applied inside the transaction

    const bTagged = await raw.trade.count({
      where: { userId: userBId, strategy: 'TXN_A_ONLY' },
    });
    expect(bTagged).toBe(0); // B never touched by the transactional updateMany
  });
});

describe('TDA-003 Task 2 — runWithoutTenant clears scoping (§7.6)', () => {
  it('inside tenant-A context, runWithoutTenant sees BOTH A and B rows', async () => {
    const trades = await asTenant(A(), () =>
      tenant.runWithoutTenant(() => prisma.trade.findMany()),
    );
    const ids = trades.map((t) => t.id);
    expect(ids).toContain(tradeAId);
    expect(ids).toContain(tradeBId);
  });
});
