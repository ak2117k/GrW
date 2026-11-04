-- Intraday carry (2026-11-04, spec docs/superpowers/specs/2026-11-04-intraday-carry-and-thesis-guard-design.md):
-- one row per intraday (MIS) position's close decision, live or paper — CARRY (converted to carry-forward)
-- or EXIT — with its reason, facts JSON, the conversion result and the broker's answer. Unique per
-- (trackerId, IST day): a restart never decides the same position twice in a session. The next session's
-- 10:20 IST scorer fills the score columns (gap, first-hour range, carry-vs-exit P&L at 10:15). No FK.
CREATE TABLE "intraday_carry_decisions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "trackerId" TEXT NOT NULL,
    "tradeId" TEXT,
    "istDay" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "productType" TEXT,
    "positionSide" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "verdictId" TEXT,
    "facts" JSONB NOT NULL,
    "decisionPrice" DOUBLE PRECISION,
    "conversionStatus" TEXT,
    "conversionAttempts" INTEGER NOT NULL DEFAULT 0,
    "brokerMessage" TEXT,
    "exitVerdictId" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "scoreStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "gapPct" DOUBLE PRECISION,
    "maxAfter" DOUBLE PRECISION,
    "minAfter" DOUBLE PRECISION,
    "priceAt1015" DOUBLE PRECISION,
    "pnlCarry" DOUBLE PRECISION,
    "pnlExit" DOUBLE PRECISION,
    "scoreVerdict" TEXT,
    "scoreNote" TEXT,
    "scoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intraday_carry_decisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intraday_carry_decisions_trackerId_istDay_key" ON "intraday_carry_decisions"("trackerId", "istDay");
CREATE INDEX "intraday_carry_decisions_userId_decidedAt_idx" ON "intraday_carry_decisions"("userId", "decidedAt");
CREATE INDEX "intraday_carry_decisions_scoreStatus_decidedAt_idx" ON "intraday_carry_decisions"("scoreStatus", "decidedAt");
