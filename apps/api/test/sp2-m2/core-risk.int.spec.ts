import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at a throwaway database with all migrations applied');
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('refusing to run against a database that is not on 127.0.0.1');

const db = new PrismaClient({ datasources: { db: { url } } });
const MIGRATION = join(__dirname, '..', '..', '..', '..', 'prisma', 'migrations', '20261010120000_sp2_m2_risk_wall', 'migration.sql');
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

function insertLimit(userId: string, key: string, scope: string, num: string | null, text: string | null, source = 'USER', reason = 'it') {
  return db.$executeRawUnsafe(
    `INSERT INTO "core_risk_limits" ("id", "userId", "key", "scope", "numValue", "textValue", "effectiveFrom", "source", "setBy", "reason")
     VALUES ($1, $2, $3, $4, $5::numeric, $6, CURRENT_TIMESTAMP, $7, $2, $8)`,
    `lim_${rid()}`, userId, key, scope, num, text, source, reason,
  );
}

function insertKill(userId: string, active: boolean, reason = 'it') {
  return db.$executeRawUnsafe(
    `INSERT INTO "core_kill_switch" ("id", "userId", "active", "effectiveFrom", "setBy", "reason") VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $2, $4)`,
    `ks_${rid()}`, userId, active, reason,
  );
}

afterAll(() => db.$disconnect());

describe('core risk tables (real database)', () => {
  it('has the 21 seed defaults, and re-running the seed block changes nothing', async () => {
    const count = async () => (await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "core_risk_limit_defaults"`))[0].n;
    expect(await count()).toBe(21);
    expect(seedStatements).toHaveLength(1);
    await db.$executeRawUnsafe(seedStatements[0]);
    expect(await count()).toBe(21);
  });

  it('refuses to update a limit row or a kill switch row (append-only)', async () => {
    const u = await newUser();
    await insertLimit(u, 'maxDailyLoss', 'ALL', '5000', null);
    await insertKill(u, true);
    await expect(db.$executeRawUnsafe(`UPDATE "core_risk_limits" SET "numValue" = 9999 WHERE "userId" = $1`, u)).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`UPDATE "core_kill_switch" SET "active" = false WHERE "userId" = $1`, u)).rejects.toThrow(/append-only/);
  });

  it('refuses an unknown pair, a wrong value shape, an unknown source and a blank reason', async () => {
    const u = await newUser();
    await expect(insertLimit(u, 'maxDailyLoss', 'MTF', '1', null)).rejects.toThrow(/core_risk_limits_pair_check/);
    await expect(insertLimit(u, 'maxDailyLoss', 'ALL', null, '5000')).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'maxDailyLoss', 'ALL', '-1', null)).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'maxOpenPositions', 'ALL', '2.5', null)).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'mtfMaxLeverage', 'MTF', '0.5', null)).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'lastEntryTime', 'MTF', null, '9:5')).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'dailyLossAction', 'ALL', null, 'PANIC')).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'lastEntryTime', 'MTF', null, null)).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'dailyLossAction', 'ALL', null, null)).rejects.toThrow(/core_risk_limits_value_check/);
    await expect(insertLimit(u, 'maxDailyLoss', 'ALL', '1', null, 'ROBOT')).rejects.toThrow(/core_risk_limits_source_check/);
    await expect(insertLimit(u, 'maxDailyLoss', 'ALL', '1', null, 'USER', '  ')).rejects.toThrow(/core_risk_limits_reason_check/);
    await expect(insertKill(u, true, ' ')).rejects.toThrow(/core_kill_switch_reason_check/);
    await insertLimit(u, 'lastEntryTime', 'MTF', null, '14:45');
    await insertLimit(u, 'mtfMaxLeverage', 'MTF', '1', null);
  });

  it('the admin may update a default (not append-only), but its CHECKs still hold', async () => {
    await db.$executeRawUnsafe(
      `UPDATE "core_risk_limit_defaults" SET "numValue" = 21, "note" = 'it edit', "updatedBy" = 'usr_it', "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'maxTradesPerDay' AND "scope" = 'ALL'`,
    );
    await expect(
      db.$executeRawUnsafe(`UPDATE "core_risk_limit_defaults" SET "numValue" = 2.5 WHERE "key" = 'maxTradesPerDay' AND "scope" = 'ALL'`),
    ).rejects.toThrow(/core_risk_limit_defaults_value_check/);
    await db.$executeRawUnsafe(`UPDATE "core_risk_limit_defaults" SET "numValue" = 20, "note" = 'no existing equivalent', "updatedBy" = NULL WHERE "key" = 'maxTradesPerDay' AND "scope" = 'ALL'`);
  });

  it('deleting a user removes their limit and kill switch rows', async () => {
    const u = await newUser();
    await insertLimit(u, 'maxTradesPerDay', 'ALL', '20', null);
    await insertKill(u, false);
    await db.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = $1`, u);
    const left = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT ((SELECT count(*) FROM "core_risk_limits" WHERE "userId" = $1) + (SELECT count(*) FROM "core_kill_switch" WHERE "userId" = $1))::int AS n`,
      u,
    );
    expect(left[0].n).toBe(0);
  });
});
