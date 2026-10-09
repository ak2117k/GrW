import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error('DATABASE_URL_TEST must point at a throw-away database with all migrations applied');

const db = new PrismaClient({ datasources: { db: { url } } });
const MIGRATION = join(__dirname, '..', '..', '..', '..', 'prisma', 'migrations', '20261009120000_sp2_m1_strategy_catalogue', 'migration.sql');
const sql = readFileSync(MIGRATION, 'utf8');
const seedStatements = sql
  .slice(sql.indexOf('-- SEED BEGIN'), sql.indexOf('-- SEED END'))
  .split(/;\r?\n/)
  .map((s) => s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
  .filter((s) => s.length > 0);

const run = `it${Date.now()}`;
const BLOCKS = '{"entry":{"kind":"chartink","scanName":null,"match":"ANY","side":"BUY"}}';

async function draftVersion(): Promise<string> {
  const strategyId = `cs_${run}_${Math.random().toString(36).slice(2, 8)}`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_strategies" ("id","key","name","description","allowedVehicles") VALUES ($1, $1, 'IT', 'IT', ARRAY['CASH_INTRADAY']::TEXT[])`,
    strategyId,
  );
  const id = `${strategyId}_v1`;
  await db.$executeRawUnsafe(
    `INSERT INTO "core_strategy_versions" ("id","strategyId","version","blocks","status","createdBy","updatedAt") VALUES ($1, $2, 1, $3::jsonb, 'DRAFT', 'OWNER', CURRENT_TIMESTAMP)`,
    id, strategyId, BLOCKS,
  );
  return id;
}

afterAll(() => db.$disconnect());

describe('core strategy catalogue (real database)', () => {
  it('has the two seeds as DRAFT v1, and re-running the seed block changes nothing', async () => {
    const count = async () =>
      db.$queryRawUnsafe<Array<{ s: number; v: number }>>(
        `SELECT (SELECT count(*)::int FROM "core_strategies" WHERE "key" IN ('adaptive-stop','ungated')) AS s,
                (SELECT count(*)::int FROM "core_strategy_versions" WHERE "id" IN ('csv_adaptive_stop_v1','csv_ungated_v1') AND "status" = 'DRAFT' AND "version" = 1) AS v`,
      );
    expect(await count()).toEqual([{ s: 2, v: 2 }]);
    expect(seedStatements).toHaveLength(3);
    for (const stmt of seedStatements) await db.$executeRawUnsafe(stmt);
    expect(await count()).toEqual([{ s: 2, v: 2 }]);
  });

  it('lets a draft change, then refuses to change or delete an approved version, and refuses a return to DRAFT', async () => {
    const id = await draftVersion();
    await db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "notes" = 'edited' WHERE "id" = $1`, id);
    await db.$executeRawUnsafe(
      `UPDATE "core_strategy_versions" SET "status" = 'PAPER', "approvedBy" = 'usr_it', "approvedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, id,
    );
    await expect(
      db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "blocks" = '{}'::jsonb WHERE "id" = $1`, id),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "status" = 'DRAFT' WHERE "id" = $1`, id),
    ).rejects.toThrow(/cannot return to DRAFT/);
    await expect(db.$executeRawUnsafe(`DELETE FROM "core_strategy_versions" WHERE "id" = $1`, id)).rejects.toThrow(/cannot be deleted/);
    await expect(
      db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "id" = $1 || '_renamed' WHERE "id" = $1`, id),
    ).rejects.toThrow(/immutable/);
    await db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "status" = 'RETIRED' WHERE "id" = $1`, id);
    await expect(
      db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "status" = 'PAPER' WHERE "id" = $1`, id),
    ).rejects.toThrow(/cannot leave RETIRED/);
  });

  it('refuses an unknown status, an unknown creator and an unknown vehicle', async () => {
    const id = await draftVersion();
    await expect(db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "status" = 'BOGUS' WHERE "id" = $1`, id)).rejects.toThrow(/status_check/);
    await expect(db.$executeRawUnsafe(`UPDATE "core_strategy_versions" SET "createdBy" = 'ROBOT' WHERE "id" = $1`, id)).rejects.toThrow(/createdBy_check/);
    await expect(
      db.$executeRawUnsafe(`INSERT INTO "core_strategies" ("id","key","name","description","allowedVehicles") VALUES ($1, $1, 'x', 'x', ARRAY['FUTURES']::TEXT[])`, `cs_${run}_bad`),
    ).rejects.toThrow(/allowedVehicles_check/);
    await expect(
      db.$executeRawUnsafe(`INSERT INTO "core_strategies" ("id","key","name","description","allowedVehicles") VALUES ($1, $1, 'x', 'x', NULL)`, `cs_${run}_null`),
    ).rejects.toThrow(/allowedVehicles_check/);
  });

  const insertCapital = (id: string, literal: string) =>
    db.$executeRawUnsafe(
      `INSERT INTO "core_strategy_selections" ("id","userId","strategyId","strategyVersionId","capitalAllocation","updatedAt") VALUES ($1, 'usr_it', 'cs_it', 'csv_it', $2::numeric, CURRENT_TIMESTAMP)`,
      id, literal,
    );

  it('capital is DECIMAL(14,2) and 1234.56 round-trips exactly through Prisma', async () => {
    const versionId = await draftVersion();
    const strategyId = versionId.replace(/_v1$/, '');
    const user = await db.user.create({ data: { email: `${run}@it.invalid`, passwordHash: 'x' } });
    const created = await db.coreStrategySelection.create({
      data: { userId: user.id, strategyId, strategyVersionId: versionId, capitalAllocation: new Prisma.Decimal('1234.56') },
    });
    const read = await db.coreStrategySelection.findUniqueOrThrow({ where: { id: created.id } });
    expect(read.capitalAllocation).toBeInstanceOf(Prisma.Decimal);
    expect(read.capitalAllocation.toFixed(2)).toBe('1234.56');
    expect(Number(read.capitalAllocation.toFixed(2))).toBe(1234.56);
    const raw = await db.$queryRawUnsafe<Array<{ t: string; ty: string }>>(
      `SELECT "capitalAllocation"::text AS t, format_type(a.atttypid, a.atttypmod) AS ty
         FROM "core_strategy_selections" s, pg_attribute a
        WHERE s."id" = $1 AND a.attrelid = '"core_strategy_selections"'::regclass AND a.attname = 'capitalAllocation'`,
      created.id,
    );
    expect(raw).toEqual([{ t: '1234.56', ty: 'numeric(14,2)' }]);
  });

  it('refuses a negative or NaN capital (CHECK) and an infinite or ≥ 10^12 one (the type)', async () => {
    for (const bad of ['-0.01', 'NaN']) {
      await expect(insertCapital(`sel_${run}_${bad}`, bad)).rejects.toThrow(/capitalAllocation_check/);
    }
    for (const bad of ['Infinity', '-Infinity', '1000000000000']) {
      await expect(insertCapital(`sel_${run}_${bad}`, bad)).rejects.toThrow(/numeric field overflow/);
    }
  });
});
