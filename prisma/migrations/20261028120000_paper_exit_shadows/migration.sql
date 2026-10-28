-- Live exit rules recorded beside each paper trade, never acted on (owner 2026-10-28).
CREATE TABLE "paper_exit_shadows" (
    "id" TEXT NOT NULL,
    "trade_id" TEXT NOT NULL,
    "decision_id" TEXT,
    "rule" TEXT NOT NULL,
    "would_exit_at" TIMESTAMPTZ(6),
    "price" DOUBLE PRECISION,
    "reason" TEXT,
    "detail" JSONB,
    "held_pnl" DOUBLE PRECISION,
    "rule_pnl" DOUBLE PRECISION,
    "saved" DOUBLE PRECISION,
    "settled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "paper_exit_shadows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "paper_exit_shadows_trade_id_rule_key" ON "paper_exit_shadows"("trade_id", "rule");
CREATE INDEX "paper_exit_shadows_settled_at_idx" ON "paper_exit_shadows"("settled_at");
