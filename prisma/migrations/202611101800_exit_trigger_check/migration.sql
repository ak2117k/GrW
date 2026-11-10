-- Trigger check (2026-11-10), RECORD ONLY: what an AI exit price trigger looked like when it armed — its
-- distance in noise units, whether it sat inside the AI's own stated invalidation, and whether it cut a loss
-- or protected a profit (apps/api/src/modules/exit-discipline/trigger-check.ts). Nothing arms, fires or
-- exits on it. NULL for every row armed before this migration. Nullable with no default: a metadata-only
-- change, no table rewrite.
ALTER TABLE "sentinel_exit_triggers" ADD COLUMN "check" JSONB;
