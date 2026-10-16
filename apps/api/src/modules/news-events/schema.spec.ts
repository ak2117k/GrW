import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..', '..', '..', '..', '..');
const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');
const sql = readFileSync(join(root, 'prisma', 'migrations', '20261016120000_news_events_v2', 'migration.sql'), 'utf8');

describe('news-events v2 migration is expand-only', () => {
  it('adds, never drops or alters an existing column', () => {
    expect(sql).not.toMatch(/\bDROP\b|ALTER COLUMN|RENAME/i);
    // Nullable-with-default, as Prisma emits `String[] @default([])` (no drift vs schema.prisma).
    expect(sql).toMatch(/ADD COLUMN "instruments" TEXT\[\] DEFAULT ARRAY\[\]::TEXT\[\]/);
    expect(sql).toMatch(/ADD COLUMN "newsShadow" JSONB/);
    expect(sql).toMatch(/USING GIN \("relatedSymbols"\)/);
    expect(sql).toMatch(/CREATE TABLE "market_events"/);
    expect(sql).toMatch(/"startsAt" TIMESTAMPTZ\(3\) NOT NULL/);
  });
  it('the schema declares the same', () => {
    expect(schema).toMatch(/model InstrumentNameAlias \{[\s\S]*?@@unique\(\[alias, symbol\]\)[\s\S]*?@@map\("instrument_name_aliases"\)/);
    expect(schema).toMatch(/model MarketEvent \{[\s\S]*?@@unique\(\[kind, key, startsAt\]\)[\s\S]*?@@index\(\[key, startsAt\]\)/);
    expect(schema).toMatch(/newsShadow\s+Json\?/);
    expect(schema).toMatch(/@@index\(\[relatedSymbols\], type: Gin\)/);
  });
});
