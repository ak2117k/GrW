import { readFileSync } from 'fs';
import { join } from 'path';
import { EXIT_REASONS } from '../lifecycle/lifecycle.types';
import { JOURNAL_TYPES } from './journal.types';

/** The M5 migration: expand-only, two append-only tables whose CHECKs mirror the code's vocabularies. */
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const sql = readFileSync(join(ROOT, 'prisma', 'migrations', '20261013120000_sp2_m5_journal', 'migration.sql'), 'utf8')
  .replace(/\r\n/g, '\n'); // a Windows checkout (core.autocrlf) has CRLF line ends
const listAfter = (marker: string): string[] => {
  const start = sql.indexOf(marker);
  return [...sql.slice(start, sql.indexOf(')', start + marker.length)).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
};

describe('M5 migration', () => {
  it('the journal type CHECK lists JOURNAL_TYPES exactly, in order', () => {
    expect(listAfter('"type" IN (')).toEqual([...JOURNAL_TYPES]);
  });

  it('the summary exit-reason CHECK lists EXIT_REASONS exactly', () => {
    expect(listAfter('"exitReason" IN (')).toEqual([...EXIT_REASONS]);
  });

  it('both tables are append-only through the M2 guard, which this migration does not redefine', () => {
    expect(sql).toContain('CREATE TRIGGER "core_journal_append_only"\n    BEFORE UPDATE ON "core_journal"');
    expect(sql).toContain('CREATE TRIGGER "core_trade_summaries_append_only"\n    BEFORE UPDATE ON "core_trade_summaries"');
    expect(sql.match(/EXECUTE FUNCTION core_append_only_guard\(\)/g)).toHaveLength(2);
  });

  it('is expand-only: drops nothing, redefines no function, alters no existing table', () => {
    expect(sql).not.toMatch(/DROP |CREATE OR REPLACE FUNCTION|ALTER TABLE "core_(positions|orders|fills|cash_ledger|paper_defaults|risk_limits|kill_switch)"/);
  });

  it('a dedupe key and a position summary are unique (idempotent writers rely on it)', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "core_journal_dedupeKey_key" ON "core_journal"("dedupeKey");');
    expect(sql).toContain('CREATE UNIQUE INDEX "core_trade_summaries_positionId_key" ON "core_trade_summaries"("positionId");');
  });
});
