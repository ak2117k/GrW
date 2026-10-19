-- MBM NIFTY option-chain capture (MBM_CHAIN_CAPTURE). Expand-only: one new table, nothing altered.
-- Body is `prisma migrate diff` output for schema.prisma, so there is no drift. Never pruned (training
-- data; Angel serves nothing for expired contracts). The grw_ai SELECT grant lives in
-- deploy/sql/grw-ai-role.sql (re-run it after this migration).

-- CreateTable
CREATE TABLE "mbm_chain_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "instrument" TEXT NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "expiry" DATE NOT NULL,
    "spot" DOUBLE PRECISION NOT NULL,
    "pcr" DOUBLE PRECISION,
    "max_pain" DOUBLE PRECISION,
    "call_wall" DOUBLE PRECISION,
    "put_wall" DOUBLE PRECISION,
    "strikes" JSONB NOT NULL,

    CONSTRAINT "mbm_chain_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mbm_chain_snapshots_instrument_captured_at_idx" ON "mbm_chain_snapshots"("instrument", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "mbm_chain_snapshots_instrument_expiry_captured_at_key" ON "mbm_chain_snapshots"("instrument", "expiry", "captured_at");
