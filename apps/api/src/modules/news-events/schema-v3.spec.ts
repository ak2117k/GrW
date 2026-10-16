import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..', '..', '..', '..', '..');
const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');
const sql = readFileSync(join(root, 'prisma', 'migrations', '20261017120000_news_context_v3', 'migration.sql'), 'utf8');

describe('news context v3 migration is expand-only (spec §12)', () => {
  it('never drops, alters or renames', () => expect(sql).not.toMatch(/\bDROP\b|ALTER COLUMN|RENAME/i));
  it('news_articles gains ruleSetVersion and drivers only', () => {
    expect(sql).toMatch(/ADD COLUMN "ruleSetVersion" INTEGER NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/ADD COLUMN "drivers" TEXT\[\] DEFAULT ARRAY\[\]::TEXT\[\]/);
    expect(sql.match(/ALTER TABLE "news_articles"/g)).toHaveLength(1);
  });
  it.each(['news_entity_profiles', 'news_tag_rules', 'news_tag_rule_sets', 'news_tag_feedback', 'night_job_runs'])('creates %s', (t) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE "${t}"`));
  });
  it('uniques and indexes', () => {
    expect(sql).toMatch(/UNIQUE INDEX "news_entity_profiles_symbol_version_key"/);
    expect(sql).toMatch(/UNIQUE INDEX "news_tag_rule_sets_version_key"/);
    expect(sql).toMatch(/UNIQUE INDEX "night_job_runs_job_nightOf_key"/);
    expect(sql).toMatch(/INDEX "news_tag_feedback_createdAt_idx"/);
    expect(sql).toMatch(/INDEX "news_tag_feedback_kind_status_idx"/);
    expect(sql).toMatch(/INDEX "news_articles_drivers_idx" ON "news_articles" USING GIN \("drivers"\)/);
  });
  it('the schema declares the same', () => {
    expect(schema).toMatch(/model NewsEntityProfile \{[\s\S]*?@@unique\(\[symbol, version\]\)[\s\S]*?@@map\("news_entity_profiles"\)/);
    expect(schema).toMatch(/model NightJobRun \{[\s\S]*?@@unique\(\[job, nightOf\]\)[\s\S]*?@@map\("night_job_runs"\)/);
    expect(schema).toMatch(/ruleSetVersion\s+Int\s+@default\(0\)/);
  });
});
