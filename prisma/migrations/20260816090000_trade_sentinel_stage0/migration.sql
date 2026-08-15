-- CreateTable
CREATE TABLE "sentinel_theses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackerId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "levelPrice" DOUBLE PRECISION,
    "targetPrice" DOUBLE PRECISION,
    "invalidation" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'INFERRED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sentinel_theses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentinel_verdicts" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sentinel_verdicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oi_wall_snapshots" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "expiry" TEXT NOT NULL,
    "callWall" DOUBLE PRECISION,
    "putWall" DOUBLE PRECISION,
    "callWallOi" DOUBLE PRECISION,
    "putWallOi" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oi_wall_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sentinel_theses_trackerId_key" ON "sentinel_theses"("trackerId");

-- CreateIndex
CREATE INDEX "sentinel_theses_userId_idx" ON "sentinel_theses"("userId");

-- CreateIndex
CREATE INDEX "sentinel_verdicts_userId_createdAt_idx" ON "sentinel_verdicts"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "sentinel_verdicts_trackerId_createdAt_idx" ON "sentinel_verdicts"("trackerId", "createdAt");

-- CreateIndex
CREATE INDEX "oi_wall_snapshots_symbol_capturedAt_idx" ON "oi_wall_snapshots"("symbol", "capturedAt");

-- CreateIndex
CREATE INDEX "oi_wall_snapshots_capturedAt_idx" ON "oi_wall_snapshots"("capturedAt");

