-- Portfolio review runs (owner 2026-11-02: "rather than starting the review automatically, it should be a button to press";
-- free once per month per user, then a subscription — the subscription is NEXT, not now).
--
-- portfolio_review_runs: one row per explicit POST /api/portfolio-review/run. status RUNNING | DONE | FAILED;
-- review_id points at the portfolio_reviews row the run stored (no FK, like portfolio_reviews itself). The monthly
-- quota hook counts RUNNING + DONE rows per user per IST month; it is NOT enforced yet. A RUNNING row older than
-- the run time box (process restart) is read as FAILED.
CREATE TABLE "portfolio_review_runs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL,
    "progress" TEXT,
    "error" TEXT,
    "review_id" TEXT,

    CONSTRAINT "portfolio_review_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "portfolio_review_runs_user_id_started_at_idx" ON "portfolio_review_runs"("user_id", "started_at");
