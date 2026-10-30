-- Entry engine stage 1 (owner 2026-10-30): every evaluation of news + trend + OI per underlying,
-- NO_TRADE included. `trade_id` is the PAPER trade an ENTER opened (ENTRY_ENGINE=paper), else NULL.
-- `mode` is the ENTRY_ENGINE mode at the time (observe | paper). No FK, like exit_noise_reads.
CREATE TABLE "entry_engine_decisions" (
    "id" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "action" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "trade_id" TEXT,
    "mode" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entry_engine_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "entry_engine_decisions_at_idx" ON "entry_engine_decisions"("at");
CREATE INDEX "entry_engine_decisions_underlying_at_idx" ON "entry_engine_decisions"("underlying", "at");
CREATE INDEX "entry_engine_decisions_trade_id_idx" ON "entry_engine_decisions"("trade_id");
