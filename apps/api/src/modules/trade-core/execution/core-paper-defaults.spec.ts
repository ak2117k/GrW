import { readFileSync } from 'fs';
import { join } from 'path';
import { isPaperPair, paperPairId, parsePaperValue, REQUIRED_PAPER_PAIRS, type PaperKey } from './paper-settings';
import { SEED_ROWS } from './testing/paper-fixtures';

/**
 * The paper defaults are rows in the M3 migration (data, not code: SP2 D4). This spec
 * proves the seed block holds one valid row per required pair plus the five index
 * underlyings, that E1/E2 carry the owner's values, that every other row is labelled
 * "default — please review", and that the fixtures the other specs use equal the seed.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const sql = readFileSync(join(ROOT, 'prisma', 'migrations', '20261011120000_sp2_m3_execution', 'migration.sql'), 'utf8');

interface SeedRow {
  key: string;
  scope: string;
  value: string;
  note: string;
}

function seedRows(): SeedRow[] {
  const seed = sql.slice(sql.indexOf('-- SEED BEGIN'), sql.indexOf('-- SEED END'));
  const re = /\('([A-Za-z]+)', '([A-Z0-9&_-]+)', (\d+(?:\.\d+)?), '([^']*)'\)/g;
  return [...seed.matchAll(re)].map((m) => ({ key: m[1], scope: m[2], value: m[3], note: m[4] }));
}

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];

describe('M3 seed defaults (core_paper_defaults)', () => {
  const rows = seedRows();

  it('has one valid row per required pair plus the five index underlyings, inserted idempotently', () => {
    expect(rows.map((r) => paperPairId(r.key, r.scope))).toEqual([...REQUIRED_PAPER_PAIRS, ...UNDERLYINGS.map((u) => paperPairId('maxLotsPerOrder', u))]);
    for (const r of rows) {
      expect(isPaperPair(r.key, r.scope)).toBe(true);
      expect(parsePaperValue(r.key as PaperKey, r.value).ok).toBe(true);
    }
    expect(sql).toContain('ON CONFLICT ("key", "scope") DO NOTHING');
  });

  it('equals the fixture rows the other specs use', () => {
    expect(rows.map((r) => `${r.key}@${r.scope}=${Number(r.value).toFixed(2)}`)).toEqual(SEED_ROWS.map((r) => `${r.key}@${r.scope}=${r.numValue.toFixed(2)}`));
  });

  it('E1 and E2 carry the owner decisions; every other row says default — please review', () => {
    const byId = new Map(rows.map((r) => [paperPairId(r.key, r.scope), r]));
    expect(byId.get('startingCapital@ALL')?.value).toBe('1000000.00');
    expect(byId.get('startingCapital@ALL')?.note).toContain('owner decision E1');
    expect(byId.get('intradayLeverage@CASH_INTRADAY')?.value).toBe('5.00');
    expect(byId.get('intradayLeverage@CASH_INTRADAY')?.note).toContain('owner decision E2');
    for (const r of rows.filter((x) => !['startingCapital', 'intradayLeverage'].includes(x.key))) {
      expect(r.note.startsWith('default — please review')).toBe(true);
    }
  });

  it('the defaults pair CHECK names exactly the fixed pairs the code knows', () => {
    const check = sql.slice(sql.indexOf('"core_paper_defaults_pair_check"'), sql.indexOf('"core_paper_defaults_value_check"'));
    const pairs = [...check.matchAll(/\('([A-Za-z]+)', '([A-Z_]+)'\)/g)].map((m) => paperPairId(m[1], m[2]));
    expect(pairs).toEqual([...REQUIRED_PAPER_PAIRS]);
  });

  it('fills and the ledger are append-only through the M2 guard, which this migration does not redefine', () => {
    expect(sql).toContain('CREATE TRIGGER "core_fills_append_only"');
    expect(sql).toContain('CREATE TRIGGER "core_cash_ledger_append_only"');
    expect(sql.match(/EXECUTE FUNCTION core_append_only_guard\(\)/g)).toHaveLength(2);
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION');
  });
});
