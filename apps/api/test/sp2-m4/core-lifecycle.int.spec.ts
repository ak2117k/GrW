import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at a throwaway database with all migrations applied');
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('refusing to run against a database that is not on 127.0.0.1');

const db = new PrismaClient({ datasources: { db: { url } } });
const run = `it${Date.now()}`;
const rid = () => Math.random().toString(36).slice(2, 10);

async function newUser(): Promise<string> {
  const id = `usr_${run}_${rid()}`;
  await db.$executeRawUnsafe(`INSERT INTO "users" ("id", "email", "passwordHash", "updatedAt") VALUES ($1, $1 || '@it.local', 'x', CURRENT_TIMESTAMP)`, id);
  return id;
}

interface PositionOver {
  status?: string;
  requestedQty?: number;
  lotSize?: number;
  entryFilledQty?: number;
  exitFilledQty?: number;
  closedAt?: string | null;
  exitReason?: string | null;
}

async function insertPosition(userId: string, o: PositionOver = {}): Promise<string> {
  const id = `pos_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_positions" ("id", "userId", "intentId", "strategyId", "strategyVersionId", "vehicle", "exchange", "token", "symbol", "lotSize", "underlying", "side", "direction", "status", "requestedQty", "entryFilledQty", "exitFilledQty", "plan", "exitReason", "closedAt", "updatedAt")
     VALUES ($1, $2, $1, 'cs_x', 'csv_x', 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', $3, 'RELIANCE', 'BUY', 'LONG', $4, $5, $6, $7, '{}'::jsonb, $8, $9::timestamp, CURRENT_TIMESTAMP)`,
    id, userId, o.lotSize ?? 1, o.status ?? 'OPEN', o.requestedQty ?? 100, o.entryFilledQty ?? 100, o.exitFilledQty ?? 0, o.exitReason ?? null, o.closedAt ?? null,
  );
  return id;
}

afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" LIKE $1`, `usr_${run}_%`);
  await db.$disconnect();
});

describe('core_positions (SP2 M4 migration)', () => {
  it('accepts a valid row and refuses an unknown status or exit reason', async () => {
    const u = await newUser();
    await expect(insertPosition(u)).resolves.toMatch(/^pos_/);
    await expect(insertPosition(u, { status: 'HALF_OPEN' })).rejects.toThrow(/core_positions_vocab_check/);
    await expect(insertPosition(u, { status: 'EXITING', exitReason: 'BORED' })).rejects.toThrow(/core_positions_vocab_check/);
  });

  it('refuses quantities that do not add up, and a terminal status without closedAt (and the reverse)', async () => {
    const u = await newUser();
    await expect(insertPosition(u, { exitFilledQty: 101 })).rejects.toThrow(/core_positions_shape_check/);
    await expect(insertPosition(u, { entryFilledQty: 101 })).rejects.toThrow(/core_positions_shape_check/);
    await expect(insertPosition(u, { lotSize: 75, requestedQty: 100 })).rejects.toThrow(/core_positions_shape_check/);
    await expect(insertPosition(u, { status: 'CLOSED' })).rejects.toThrow(/core_positions_shape_check/);
    await expect(insertPosition(u, { status: 'OPEN', closedAt: '2026-10-12 10:00:00' })).rejects.toThrow(/core_positions_shape_check/);
    await expect(insertPosition(u, { status: 'CLOSED', exitFilledQty: 100, closedAt: '2026-10-12 10:00:00', exitReason: 'STOP' })).resolves.toMatch(/^pos_/);
  });

  it('the intent id is unique', async () => {
    const u = await newUser();
    const id = await insertPosition(u);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "core_positions" ("id", "userId", "intentId", "strategyId", "strategyVersionId", "vehicle", "exchange", "token", "symbol", "lotSize", "underlying", "side", "direction", "status", "requestedQty", "plan", "updatedAt")
         VALUES ($1, $2, $3, 'cs_x', 'csv_x', 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', 1, 'RELIANCE', 'BUY', 'LONG', 'PENDING_ENTRY', 100, '{}'::jsonb, CURRENT_TIMESTAMP)`,
        `pos_${rid()}`, u, id,
      ),
    ).rejects.toThrow(/23505[\s\S]*Key \("intentId"\)/); // core_positions_intentId_key (Prisma reports the detail, not the name)
  });

  it('core_orders.positionId is nullable and set to null when its position is deleted; deleting the user cascades', async () => {
    const u = await newUser();
    const pos = await insertPosition(u);
    const ord = `ord_${rid()}`;
    await db.$executeRawUnsafe(
      `INSERT INTO "core_orders" ("id", "userId", "idempotencyKey", "vehicle", "exchange", "token", "symbol", "lotSize", "side", "qty", "type", "refPrice", "purpose", "state", "submittedAt", "updatedAt", "positionId")
       VALUES ($1, $2, $1, 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', 1, 'BUY', 100, 'MARKET', 500, 'ENTRY', 'OPEN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $3)`,
      ord, u, pos,
    );
    await db.$executeRawUnsafe(`DELETE FROM "core_positions" WHERE "id" = $1`, pos);
    const [row] = await db.$queryRawUnsafe<Array<{ positionId: string | null }>>(`SELECT "positionId" FROM "core_orders" WHERE "id" = $1`, ord);
    expect(row.positionId).toBeNull();
    const kept = await insertPosition(u);
    await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = $1`, u);
    const left = await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "core_positions" WHERE "id" = $1`, kept);
    expect(left).toHaveLength(0);
  });
});

describe('core_paper_defaults (widened by M4)', () => {
  it('holds the blindAfterMs seed and refuses a value below 1000 ms or another scope', async () => {
    const [row] = await db.$queryRawUnsafe<Array<{ numValue: string }>>(`SELECT "numValue"::text AS "numValue" FROM "core_paper_defaults" WHERE "key" = 'blindAfterMs' AND "scope" = 'ALL'`);
    expect(Number(row.numValue)).toBe(30000);
    await expect(db.$executeRawUnsafe(`UPDATE "core_paper_defaults" SET "numValue" = 999 WHERE "key" = 'blindAfterMs' AND "scope" = 'ALL'`)).rejects.toThrow(/core_paper_defaults_value_check/);
    await expect(
      db.$executeRawUnsafe(`INSERT INTO "core_paper_defaults" ("key", "scope", "numValue", "note") VALUES ('blindAfterMs', 'MTF', 30000, 'x')`),
    ).rejects.toThrow(/core_paper_defaults_pair_check/);
  });
});
