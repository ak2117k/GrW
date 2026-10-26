-- Agent lessons count per session (2026-10-26). Expand-only: one new column, then a backfill.
--
-- A lesson is now shown to an agent only once its right cases come from >= 2 sessions, and a
-- case is one (session, symbol) — one position's overnight + pre-open scorecards are one case.
-- The backfill re-derives sessions and both counters from every stored diagnosis, so the rows
-- written under the old per-refId counting follow the same rule. Status is never changed here.

-- AlterTable
ALTER TABLE "agent_lessons" ADD COLUMN "sessions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill
WITH miss AS (
  SELECT r.session_date, m
  FROM "self_review_runs" r, jsonb_array_elements(r.diagnosis -> 'misses') m
  WHERE jsonb_typeof(r.diagnosis -> 'misses') = 'array'
),
refs AS (
  SELECT miss.session_date, miss.m, ref.value AS ref_id,
         miss.session_date || '|' || COALESCE(
           (SELECT v.symbol FROM "verification_results" v WHERE v.ref_id = ref.value AND v.symbol IS NOT NULL LIMIT 1),
           'ref:' || ref.value
         ) AS case_key
  FROM miss, jsonb_array_elements_text(miss.m -> 'refIds') ref
),
named AS (
  SELECT m ->> 'lessonKey' AS key, session_date, case_key FROM refs WHERE m ? 'lessonKey'
),
contra AS (
  SELECT c.value AS key, case_key FROM refs, jsonb_array_elements_text(COALESCE(m -> 'contradicts', '[]'::jsonb)) c
),
counts AS (
  SELECT n.key,
         ARRAY(SELECT DISTINCT n2.session_date FROM named n2 WHERE n2.key = n.key ORDER BY 1) AS sessions,
         COUNT(DISTINCT n.case_key) AS right_n
  FROM named n GROUP BY n.key
)
UPDATE "agent_lessons" l
SET "sessions" = c.sessions,
    "right_count" = c.right_n,
    "wrong_count" = (SELECT COUNT(DISTINCT x.case_key) FROM contra x WHERE x.key = l.key)
FROM counts c
WHERE c.key = l.key;
