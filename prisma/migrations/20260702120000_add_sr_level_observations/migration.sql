-- CreateTable
CREATE TABLE "sr_level_observations" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "side" TEXT NOT NULL,
    "kinds" TEXT[],
    "score" INTEGER NOT NULL,
    "ltpAtSnapshot" DOUBLE PRECISION NOT NULL,
    "atr14" DOUBLE PRECISION,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluatedAt" TIMESTAMP(3),
    "touched" BOOLEAN,
    "reaction" TEXT,
    "reactionDetail" JSONB,

    CONSTRAINT "sr_level_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sr_level_observations_token_snapshotAt_idx" ON "sr_level_observations"("token", "snapshotAt");

-- CreateIndex
CREATE INDEX "sr_level_observations_reaction_idx" ON "sr_level_observations"("reaction");

-- CreateIndex
CREATE INDEX "sr_level_observations_reaction_snapshotAt_idx" ON "sr_level_observations"("reaction", "snapshotAt");
