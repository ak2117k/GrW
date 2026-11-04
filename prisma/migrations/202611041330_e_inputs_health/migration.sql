-- Inputs health (2026-11-04): one row per alert sent by the inputs-health check, unique per
-- (problem, underlying, IST day) so a restart never re-sends the day's alert. DETECTION ONLY:
-- written by the inputs-health cron, read by nothing that trades.
CREATE TABLE "inputs_health_alerts" (
    "id" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "ist_day" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "alerted_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inputs_health_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inputs_health_alerts_problem_underlying_ist_day_key" ON "inputs_health_alerts"("problem", "underlying", "ist_day");
CREATE INDEX "inputs_health_alerts_alerted_at_idx" ON "inputs_health_alerts"("alerted_at");
