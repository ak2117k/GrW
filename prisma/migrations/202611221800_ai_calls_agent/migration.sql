-- AI agents (2026-11-22, docs/superpowers/specs/2026-11-22-ai-agents-design.md 4.7): which agent served an
-- AI call: trading | reading | background (the agent container) or in-process (the API called Vertex itself).
-- NULL for every row written before this migration and on every non-agent path. Nullable with no default: a
-- metadata-only change, no table rewrite.
ALTER TABLE "ai_calls" ADD COLUMN "agent" TEXT;
