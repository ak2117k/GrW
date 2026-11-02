-- Portfolio review (owner 2026-11-02: "look at all the history, holdings, trades, analyse it and tell us how to improve").
--
-- portfolio_reviews: one row per generated review (GET /api/portfolio-review computes at most every ~15 min per user,
-- or on ?refresh=1). Headline numbers as columns so the owner can compare over time; `payload` is the whole report
-- (headline, breakdowns, patterns, holdings, suggestions, data-quality notes, the AI summary). summary_status
-- OK | SKIPPED | PENDING | BUSY | FAILED; a PENDING summary is filled in place when the model finishes. No FK.
CREATE TABLE "portfolio_reviews" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "realised_net" DOUBLE PRECISION NOT NULL,
    "unrealised" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "charges" DOUBLE PRECISION NOT NULL,
    "trades" INTEGER NOT NULL,
    "win_rate" DOUBLE PRECISION NOT NULL,
    "summary_status" TEXT NOT NULL,
    "summary" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "portfolio_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "portfolio_reviews_user_id_created_at_idx" ON "portfolio_reviews"("user_id", "created_at");
