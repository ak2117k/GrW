-- "Noise or real?" read at every AI exit (owner 2026-10-30). RECORD ONLY: written after the exit
-- decision, never read by any exit path. The underlying 15 / 30 min later (and its excursions over
-- those 30 min) are filled by a sweep so the nightly self-review can score the read.
CREATE TABLE "exit_noise_reads" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "trade_id" TEXT,
    "tracker_id" TEXT,
    "user_id" TEXT,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT,
    "underlying" TEXT,
    "underlying_exchange" TEXT,
    "underlying_token" TEXT,
    "side" TEXT NOT NULL,
    "want" TEXT NOT NULL,
    "exit_rule" TEXT NOT NULL,
    "exit_price" DOUBLE PRECISION,
    "exit_at" TIMESTAMPTZ(6) NOT NULL,
    "underlying_at_exit" DOUBLE PRECISION,
    "noise_n" DOUBLE PRECISION,
    "verdict" TEXT NOT NULL,
    "read" JSONB NOT NULL,
    "underlying_after_15m" DOUBLE PRECISION,
    "underlying_after_30m" DOUBLE PRECISION,
    "max_favour_30m" DOUBLE PRECISION,
    "max_against_30m" DOUBLE PRECISION,
    "followed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exit_noise_reads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exit_noise_reads_source_ref_id_exit_rule_key" ON "exit_noise_reads"("source", "ref_id", "exit_rule");
CREATE INDEX "exit_noise_reads_exit_at_idx" ON "exit_noise_reads"("exit_at");
CREATE INDEX "exit_noise_reads_followed_at_exit_at_idx" ON "exit_noise_reads"("followed_at", "exit_at");
