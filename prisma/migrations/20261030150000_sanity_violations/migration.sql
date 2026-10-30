-- Sanity audit (owner 2026-10-30): one row per broken invariant per subject (trade / exit / feed-day).
-- DETECTION ONLY: written by the sanity-audit sweep, read by nothing that trades. Idempotent on
-- (check, subject_id); severity 'known' = before SANITY_AUDIT_SINCE, stored but never alerted.
CREATE TABLE "sanity_violations" (
    "id" TEXT NOT NULL,
    "check" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alerted_at" TIMESTAMPTZ(6),

    CONSTRAINT "sanity_violations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sanity_violations_check_subject_id_key" ON "sanity_violations"("check", "subject_id");
CREATE INDEX "sanity_violations_last_seen_at_idx" ON "sanity_violations"("last_seen_at");
