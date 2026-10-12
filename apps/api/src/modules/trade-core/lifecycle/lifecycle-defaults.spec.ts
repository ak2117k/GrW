import { readFileSync } from 'fs';
import { join } from 'path';
import { isPaperPair, OPTIONAL_PAPER_PAIRS, paperPairId, parsePaperValue, REQUIRED_PAPER_PAIRS, type PaperKey } from '../execution/paper-settings';
import { EXIT_REASONS, POSITION_STATUSES } from './lifecycle.types';

/** The M4 migration: expand-only, one optional paper default, the position vocabularies mirrored in CHECKs. */
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const sql = readFileSync(join(ROOT, 'prisma', 'migrations', '20261012120000_sp2_m4_lifecycle', 'migration.sql'), 'utf8');

describe('M4 migration', () => {
  it('seeds blindAfterMs@ALL = 30000 as "default — please review", idempotently', () => {
    const seed = sql.slice(sql.indexOf('-- SEED BEGIN'), sql.indexOf('-- SEED END'));
    const rows = [...seed.matchAll(/\('([A-Za-z]+)', '([A-Z_]+)', (\d+(?:\.\d+)?), '([^']*)'\)/g)].map((m) => ({ key: m[1], scope: m[2], value: m[3], note: m[4] }));
    expect(rows.map((r) => paperPairId(r.key, r.scope))).toEqual([...OPTIONAL_PAPER_PAIRS]);
    expect(rows[0].value).toBe('30000');
    expect(rows[0].note.startsWith('default — please review')).toBe(true);
    expect(isPaperPair(rows[0].key, rows[0].scope)).toBe(true);
    expect(parsePaperValue(rows[0].key as PaperKey, rows[0].value).ok).toBe(true);
    expect(seed).toContain('ON CONFLICT ("key", "scope") DO NOTHING');
  });

  it('the widened pair CHECK names the required pairs plus the optional ones, exactly', () => {
    const check = sql.slice(sql.indexOf('ADD CONSTRAINT "core_paper_defaults_pair_check"'), sql.indexOf('ADD CONSTRAINT "core_paper_defaults_value_check"'));
    const pairs = [...check.matchAll(/\('([A-Za-z]+)', '([A-Z_]+)'\)/g)].map((m) => paperPairId(m[1], m[2]));
    expect(pairs).toEqual([...REQUIRED_PAPER_PAIRS, ...OPTIONAL_PAPER_PAIRS]);
    expect(sql).toContain(`WHEN 'blindAfterMs' THEN "numValue" >= 1000 AND "numValue" = trunc("numValue")`);
  });

  it('mirrors the status and exit-reason vocabularies in CHECKs', () => {
    for (const s of POSITION_STATUSES) expect(sql).toContain(`'${s}'`);
    const reasons = sql.slice(sql.indexOf('"exitReason" IN ('), sql.indexOf('))', sql.indexOf('"exitReason" IN (')));
    expect([...reasons.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])).toEqual([...EXIT_REASONS]);
  });

  it('is expand-only: drops no table or column and redefines no function', () => {
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|CREATE OR REPLACE FUNCTION/);
    expect(sql.match(/DROP CONSTRAINT/g)).toHaveLength(2); // the two widened paper-default CHECKs, re-added below
  });
});
