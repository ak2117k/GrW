-- CreateTable
CREATE TABLE "client_feed_reports" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "health" TEXT NOT NULL,
    "tickSocketUp" BOOLEAN NOT NULL,
    "secondsSinceLastTick" INTEGER,
    "transport" TEXT,
    "subscribedTokens" INTEGER NOT NULL,
    "namespaces" JSONB NOT NULL,
    "recoveredWithoutReload" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_feed_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_feed_reports_createdAt_idx" ON "client_feed_reports"("createdAt");
