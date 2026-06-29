-- CreateTable
CREATE TABLE "ai_insights" (
    "id" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "contextKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "contextData" JSONB NOT NULL,
    "insight" TEXT,
    "confidence" INTEGER,
    "errorMessage" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ai_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_insights_sectionKey_contextKey_status_idx" ON "ai_insights"("sectionKey", "contextKey", "status");

-- CreateIndex
CREATE INDEX "ai_insights_status_requestedAt_idx" ON "ai_insights"("status", "requestedAt");
