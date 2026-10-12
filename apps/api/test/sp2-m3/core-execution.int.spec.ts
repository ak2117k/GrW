import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at a throwaway database with all migrations applied');
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('refusing to run against a database that is not on 127.0.0.1');

const db = new PrismaClient({ datasources: { db: { url } } });
const MIGRATION = join(__dirname, '..', '..', '..', '..', 'prisma', 'migrations', '20261011120000_sp2_m3_execution', 'migration.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const seedStatements = sql
  .slice(sql.indexOf('-- SEED BEGIN'), sql.indexOf('-- SEED END'))
  .split(';\n')
  .map((s) => s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
  .filter((s) => s.length > 0);

const run = `it${Date.now()}`;
const rid = () => Math.random().toString(36).slice(2, 10);

async function newUser(): Promise<string> {
  const id = `usr_${run}_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "users" ("id", "email", "passwordHash", "updatedAt") VALUES ($1, $1 || '@it.local', 'x', CURRENT_TIMESTAMP)`,
    id,
  );
  return id;
}

interface OrderOver {
  state?: string;
  qty?: number;
  lotSize?: number;
  type?: string;
  limitPrice?: string | null;
  filledQty?: number;
  rejectReason?: string | null;
}

async function insertOrder(userId: string, o: OrderOver = {}): Promise<string> {
  const id = `ord_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_orders" ("id", "userId", "idempotencyKey", "vehicle", "exchange", "token", "symbol", "lotSize", "side", "qty", "filledQty", "type", "limitPrice", "refPrice", "purpose", "state", "rejectReason", "submittedAt", "updatedAt")
     VALUES ($1, $2, $1, 'CASH_INTRADAY', 'NSE', '2885', 'RELIANCE-EQ', $3, 'BUY', $4, $5, $6, $7::numeric, 500, 'ENTRY', $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    id, userId, o.lotSize ?? 1, o.qty ?? 100, o.filledQty ?? 0, o.type ?? 'MARKET', o.limitPrice ?? null, o.state ?? 'OPEN', o.rejectReason ?? null,
  );
  return id;
}

async function insertFill(userId: string, orderId: string): Promise<string> {
  const id = `fil_${rid()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_fills" ("id", "orderId", "userId", "price", "qty", "charges", "chargesTotal", "priceAt") VALUES ($1, $2, $3, 500.25, 100, '{}'::jsonb, 26.92, CURRENT_TIMESTAMP)`,
    id, orderId, userId,
  );
  return id;
}

interface LedgerOver {
  orderId?: string | null;
  fillId?: string | null;
  token?: string | null;
  interestDate?: string | null;
  note?: string;
}

function insertLedger(userId: string, type: string, amount: string, x: LedgerOver = {}) {
  return db.$executeRawUnsafe(
    `INSERT INTO "core_cash_ledger" ("id", "userId", "type", "amount", "orderId", "fillId", "token", "interestDate", "note") VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8::date, $9)`,
    `led_${rid()}`, userId, type, amount, x.orderId ?? null, x.fillId ?? null, x.token ?? null, x.interestDate ?? null, x.note ?? 'it',
  );
}

afterAll(() => db.$disconnect());

describe('core execution tables (real database)', () => {
  it('has the 14 seed defaults, and re-running the seed block changes nothing', async () => {
    const count = async () => (await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "core_paper_defaults"`))[0].n;
    expect(await count()).toBe(14);
    expect(seedStatements).toHaveLength(1);
    await db.$executeRawUnsafe(seedStatements[0]);
    expect(await count()).toBe(14);
  });

  it('refuses to update a fill or a ledger row (append-only)', async () => {
    const u = await newUser();
    const o = await insertOrder(u);
    const f = await insertFill(u, o);
    await insertLedger(u, 'CHARGES', '-26.92', { orderId: o, fillId: f });
    await expect(db.$executeRawUnsafe(`UPDATE "core_fills" SET "qty" = 1 WHERE "id" = $1`, f)).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`UPDATE "core_cash_ledger" SET "amount" = -1 WHERE "userId" = $1`, u)).rejects.toThrow(/append-only/);
  });

  it('pins the ledger signs and links', async () => {
    const u = await newUser();
    const o = await insertOrder(u);
    const f = await insertFill(u, o);
    await expect(insertLedger(u, 'DEPOSIT', '0')).rejects.toThrow(/core_cash_ledger_type_check/);
    await expect(insertLedger(u, 'MARGIN_BLOCK', '100', { orderId: o })).rejects.toThrow(/core_cash_ledger_type_check/);
    await expect(insertLedger(u, 'MARGIN_BLOCK', '-100')).rejects.toThrow(/core_cash_ledger_type_check/);
    await expect(insertLedger(u, 'CHARGES', '-1', { orderId: o })).rejects.toThrow(/core_cash_ledger_type_check/);
    await expect(insertLedger(u, 'TIP', '-1')).rejects.toThrow(/core_cash_ledger_type_check/);
    await expect(insertLedger(u, 'MTF_INTEREST', '-1', { token: '1594' })).rejects.toThrow(/core_cash_ledger_interest_date_check/);
    await expect(insertLedger(u, 'DEPOSIT', '1', { interestDate: '2026-10-12' })).rejects.toThrow(/core_cash_ledger_interest_date_check/);
    await expect(insertLedger(u, 'DEPOSIT', '1', { note: ' ' })).rejects.toThrow(/core_cash_ledger_note_check/);
    await insertLedger(u, 'DEPOSIT', '1000000');
    await insertLedger(u, 'MARGIN_BLOCK', '-100', { orderId: o });
    await insertLedger(u, 'REALISED_PNL', '-5', { orderId: o, fillId: f });
    await insertLedger(u, 'MTF_INTEREST', '0', { token: '1594', interestDate: '2026-10-11' });
  });

  it('allows one MTF interest row per user, token and day; ON CONFLICT DO NOTHING makes the cron idempotent', async () => {
    const u = await newUser();
    await insertLedger(u, 'MTF_INTEREST', '-2.47', { token: '1594', interestDate: '2026-10-12' });
    await expect(insertLedger(u, 'MTF_INTEREST', '-2.47', { token: '1594', interestDate: '2026-10-12' })).rejects.toThrow(/23505[\s\S]*Key \("userId", token, "interestDate"\)/);
    const n = await db.$executeRawUnsafe(
      `INSERT INTO "core_cash_ledger" ("id", "userId", "type", "amount", "token", "interestDate", "note") VALUES ($1, $2, 'MTF_INTEREST', -2.47, '1594', '2026-10-12', 'it') ON CONFLICT ("userId", "token", "interestDate") DO NOTHING`,
      `led_${rid()}`, u,
    );
    expect(n).toBe(0);
    await insertLedger(u, 'DEPOSIT', '1', { token: '1594' });
    await insertLedger(u, 'DEPOSIT', '1', { token: '1594' });
  });

  it('pins the order shapes; a REJECTED order may keep a non-lot quantity', async () => {
    const u = await newUser();
    await expect(insertOrder(u, { qty: 100, lotSize: 75 })).rejects.toThrow(/core_orders_shape_check/);
    await insertOrder(u, { qty: 100, lotSize: 75, state: 'REJECTED', rejectReason: 'qty 100 is not a multiple of the lot size 75' });
    await expect(insertOrder(u, { state: 'REJECTED' })).rejects.toThrow(/core_orders_shape_check/);
    await expect(insertOrder(u, { type: 'LIMIT' })).rejects.toThrow(/core_orders_shape_check/);
    await expect(insertOrder(u, { state: 'FILLED', filledQty: 40 })).rejects.toThrow(/core_orders_shape_check/);
    await expect(insertOrder(u, { state: 'PENDING' })).rejects.toThrow(/core_orders_vocab_check/);
    await insertOrder(u, { type: 'LIMIT', limitPrice: '499.50' });
  });

  it('persists triggered_at, a nullable timestamp an order starts without (rulings P10/P10a)', async () => {
    const u = await newUser();
    const o = await insertOrder(u);
    const read = async () => (await db.coreOrder.findUniqueOrThrow({ where: { id: o }, select: { triggeredAt: true } })).triggeredAt;
    expect(await read()).toBeNull();
    const at = new Date('2026-10-12T04:00:00.123Z');
    await db.coreOrder.update({ where: { id: o }, data: { triggeredAt: at } });
    expect((await read())?.toISOString()).toBe(at.toISOString());
  });

  it('pins the default shapes; the owner may add a cap for a new underlying', async () => {
    const upd = (key: string, scope: string, v: string) =>
      db.$executeRawUnsafe(`UPDATE "core_paper_defaults" SET "numValue" = $3::numeric WHERE "key" = $1 AND "scope" = $2`, key, scope, v);
    await expect(upd('mtfFundedShare', 'MTF', '1')).rejects.toThrow(/core_paper_defaults_value_check/);
    await expect(upd('noPriceRejectMs', 'ALL', '999')).rejects.toThrow(/core_paper_defaults_value_check/);
    await expect(upd('maxLotsPerOrder', 'NIFTY', '2.5')).rejects.toThrow(/core_paper_defaults_value_check/);
    const add = (scope: string) =>
      db.$executeRawUnsafe(`INSERT INTO "core_paper_defaults" ("key", "scope", "numValue", "note") VALUES ('maxLotsPerOrder', $1, 4, 'it') ON CONFLICT DO NOTHING`, scope);
    await expect(add('reliance')).rejects.toThrow(/core_paper_defaults_pair_check/);
    await expect(add('MTF')).rejects.toThrow(/core_paper_defaults_pair_check/);
    await add('RELIANCE');
    await db.$executeRawUnsafe(`DELETE FROM "core_paper_defaults" WHERE "key" = 'maxLotsPerOrder' AND "scope" = 'RELIANCE'`);
  });

  it('deleting a user removes their orders, fills and ledger rows', async () => {
    const u = await newUser();
    const o = await insertOrder(u);
    const f = await insertFill(u, o);
    await insertLedger(u, 'DEPOSIT', '1000000');
    await insertLedger(u, 'CHARGES', '-26.92', { orderId: o, fillId: f });
    await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = $1`, u);
    const left = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT ((SELECT count(*) FROM "core_orders" WHERE "userId" = $1) + (SELECT count(*) FROM "core_fills" WHERE "userId" = $1) + (SELECT count(*) FROM "core_cash_ledger" WHERE "userId" = $1))::int AS n`,
      u,
    );
    expect(left[0].n).toBe(0);
  });
});
