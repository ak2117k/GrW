-- Paper sentinel (paper exit shadow stage 2, owner 2026-10-29): every look the live AI sentinel took at
-- an open paper trade. Same columns as sentinel_verdicts; a separate table so no paper row can reach the
-- live trigger watcher or the auto-exit executor.
CREATE TABLE "paper_sentinel_looks" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackerId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "thesisStatus" TEXT NOT NULL,
    "recoveryAvailable" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "invalidationPoint" TEXT,
    "reviewInSec" INTEGER NOT NULL,
    "packet" JSONB NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "triggeredBy" JSONB NOT NULL,
    "netPnl" DOUBLE PRECISION NOT NULL,
    "greenFloor" DOUBLE PRECISION,
    "exitTrigger" JSONB,
    "newsShadow" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_sentinel_looks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "paper_sentinel_looks_trackerId_createdAt_idx" ON "paper_sentinel_looks"("trackerId", "createdAt");
CREATE INDEX "paper_sentinel_looks_tradeId_idx" ON "paper_sentinel_looks"("tradeId");
