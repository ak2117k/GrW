-- SP3 M0 — AI call audit, decision corpus, model registry
-- (docs/superpowers/specs/2026-10-11-sp3-ai-decision-layer-design.md §4.6, §5.1). Expand-only.

CREATE TABLE "ai_calls" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "priority" INTEGER NOT NULL,
    "userId" TEXT,
    "positionId" TEXT,
    "setupId" TEXT,
    "decisionRecordId" TEXT,
    "requestHash" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB,
    "errorClass" TEXT,
    "errorMessage" TEXT,
    "stopReason" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costInr" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "queuedMs" INTEGER NOT NULL DEFAULT 0,
    "fallbackFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_calls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_calls_job_createdAt_idx" ON "ai_calls"("job", "createdAt");
CREATE INDEX "ai_calls_createdAt_idx" ON "ai_calls"("createdAt");

CREATE TABLE "ai_decision_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT,
    "instrumentType" TEXT,
    "direction" TEXT,
    "vehicle" TEXT,
    "strategyKey" TEXT NOT NULL,
    "strategyVersionId" TEXT,
    "setupGroupKey" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "featureSet" TEXT,
    "features" JSONB,
    "ruleScore" DOUBLE PRECISION,
    "mlScore" DOUBLE PRECISION,
    "mlModelId" TEXT,
    "decision" JSONB NOT NULL,
    "aiCallIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outcome" JSONB,
    "outcomeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_decision_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_decision_records_source_sourceId_key" ON "ai_decision_records"("source", "sourceId");
CREATE INDEX "ai_decision_records_kind_decidedAt_idx" ON "ai_decision_records"("kind", "decidedAt");
CREATE INDEX "ai_decision_records_setupGroupKey_idx" ON "ai_decision_records"("setupGroupKey");

CREATE TABLE "ai_models" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "featureSet" TEXT NOT NULL,
    "trainedAt" TIMESTAMP(3) NOT NULL,
    "dataWindow" JSONB NOT NULL,
    "nTrain" INTEGER NOT NULL,
    "nHoldout" INTEGER NOT NULL,
    "metrics" JSONB NOT NULL,
    "gate" TEXT NOT NULL,
    "gateReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "artifactPath" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_models_kind_active_idx" ON "ai_models"("kind", "active");
-- At most one active model per kind; only a GO model may be active.
CREATE UNIQUE INDEX "ai_models_one_active_per_kind" ON "ai_models"("kind") WHERE "active";
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_active_requires_go" CHECK (NOT "active" OR "gate" = 'GO');

-- ai_calls is append-only (spec §4.6).
CREATE OR REPLACE FUNCTION ai_calls_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ai_calls is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER ai_calls_no_update_delete BEFORE UPDATE OR DELETE ON "ai_calls"
  FOR EACH ROW EXECUTE FUNCTION ai_calls_append_only();
