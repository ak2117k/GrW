import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import { ENTRY_WINDOW_CLOSE_MIN } from '../../../common/utils/market-hours';
import { fromStorage, isLimitPair, LIMIT_PAIRS, pairId, type LimitKey } from './limits/limit-keys';

/**
 * The seed defaults are rows in the M2 migration (data, not code, D4). This spec
 * proves (1) there is exactly one valid row per (key, scope), (2) the defaults that
 * stand in for a UserSettings field equal that field's column default, and (3) the
 * cash cutoff and square-off defaults equal the silo code they were taken from.
 * Silo files are read, never imported for behaviour.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const sql = readFileSync(join(ROOT, 'prisma', 'migrations', '20261010120000_sp2_m2_risk_wall', 'migration.sql'), 'utf8');
const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const silo = (rel: string) => readFileSync(join(ROOT, 'apps', 'api', 'src', 'modules', rel), 'utf8');

interface DefaultRow {
  key: string;
  scope: string;
  value: string | null;
  note: string;
}

function defaults(): DefaultRow[] {
  const seed = sql.slice(sql.indexOf('-- SEED BEGIN'), sql.indexOf('-- SEED END'));
  const re = /\('([A-Za-z]+)', '([A-Z_]+)', (NULL|\d+(?:\.\d+)?), (NULL|'[^']*'), '([^']*)'\)/g;
  return [...seed.matchAll(re)].map((m) => {
    const num = m[3] === 'NULL' ? null : new Prisma.Decimal(m[3]);
    const text = m[4] === 'NULL' ? null : m[4].slice(1, -1);
    const value = isLimitPair(m[1], m[2]) ? fromStorage(m[1] as LimitKey, num, text) : null;
    return { key: m[1], scope: m[2], value, note: m[5] };
  });
}

/** `<field>  Float|Int  @default(n)` inside `model UserSettings { … }`. */
function settingsDefault(field: string): number {
  const start = schema.indexOf('model UserSettings {');
  const block = schema.slice(start, schema.indexOf('\n}', start));
  const m = new RegExp(`\\n\\s+${field}\\s+(?:Float|Int)\\s+@default\\(([0-9.]+)\\)`).exec(block);
  if (!m) throw new Error(`UserSettings.${field} default not found`);
  return Number(m[1]);
}

describe('M2 seed defaults (core_risk_limit_defaults)', () => {
  const rows = defaults();
  const valueOf = (id: string) => rows.find((r) => pairId(r) === id)?.value;

  it('has exactly one valid row per (key, scope), with a note, inserted idempotently', () => {
    expect(rows.map(pairId)).toEqual(LIMIT_PAIRS.map(pairId));
    for (const r of rows) {
      expect(r.value).not.toBeNull();
      expect(r.note.trim().length).toBeGreaterThan(0);
    }
    expect(sql).toContain('ON CONFLICT ("key", "scope") DO NOTHING');
  });

  it('the UserSettings-equivalent defaults equal the user_settings column defaults', () => {
    expect(valueOf('maxDailyLoss@ALL')).toBe(new Prisma.Decimal(settingsDefault('maxDailyLoss')).toFixed(2));
    expect(valueOf('maxOpenPositions@ALL')).toBe(String(settingsDefault('maxConcurrentPositions')));
    expect(valueOf('optionsMaxPremiumPerTrade@OPTIONS_BUY')).toBe(new Prisma.Decimal(settingsDefault('maxCapitalPerTrade')).toFixed(2));
  });

  it('the cash entry cutoff and square-off defaults equal the silo code (owner answer 1: cash squares off at Ungated’s 15:25)', () => {
    const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    expect(valueOf('lastEntryTime@CASH_INTRADAY')).toBe(hhmm(ENTRY_WINDOW_CLOSE_MIN));
    expect(silo('ungated-track/services/ungated-tick-poller.service.ts')).toContain("@Cron('0 25 15 * * 1-5'");
    expect(valueOf('squareOffTime@CASH_INTRADAY')).toBe('15:25');
  });

  it('the pair CHECK names exactly the 21 pairs the code knows', () => {
    const check = sql.slice(sql.indexOf('"core_risk_limits_pair_check"'), sql.indexOf('"core_risk_limits_value_check"'));
    const pairs = [...check.matchAll(/\('([A-Za-z]+)', '([A-Z_]+)'\)/g)].map((m) => `${m[1]}@${m[2]}`);
    expect(pairs).toEqual(LIMIT_PAIRS.map(pairId));
  });

  /** The body of `ADD CONSTRAINT "<name>" CHECK …` up to its `;`, whitespace-normalised. */
  function checkBody(name: string): string {
    const marker = `ADD CONSTRAINT "${name}" CHECK`;
    const start = sql.indexOf(marker);
    if (start < 0) throw new Error(`${name} not found in the migration`);
    const from = start + marker.length;
    return sql.slice(from, sql.indexOf(';', from)).replace(/\s+/g, ' ').trim();
  }

  it('the defaults table repeats the limits table pair and value CHECKs exactly', () => {
    expect(checkBody('core_risk_limit_defaults_pair_check')).toBe(checkBody('core_risk_limits_pair_check'));
    expect(checkBody('core_risk_limit_defaults_value_check')).toBe(checkBody('core_risk_limits_value_check'));
    expect(checkBody('core_risk_limits_value_check')).toMatch(/^\( CASE .* END\)$/);
  });
});
