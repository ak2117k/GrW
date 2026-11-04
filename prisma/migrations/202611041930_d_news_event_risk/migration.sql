-- News EVENT_RISK (2026-11-04, spec docs/superpowers/specs/2026-11-04-analysis-inputs-and-judge-design.md goal 2):
-- the news-impact reader (prompt v3) tags a story "big move expected, direction unknown" — elections, rate
-- decisions, war / ceasefire — separately from BULL / BEAR. Nullable with no default: rows read before v3
-- stay NULL (unknown), never a false "no event risk".
ALTER TABLE "news_impacts" ADD COLUMN "event_risk" BOOLEAN;
