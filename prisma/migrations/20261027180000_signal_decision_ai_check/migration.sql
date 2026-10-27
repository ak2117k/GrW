-- Learning mode (owner 2026-10-27): each closed paper trade held against the AI judge's call.
ALTER TABLE "signal_decisions" ADD COLUMN "ai_check" JSONB;
