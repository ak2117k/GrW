-- CreateTable
CREATE TABLE "instruments" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "lotSize" INTEGER NOT NULL DEFAULT 1,
    "tickSize" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "expiry" TIMESTAMP(3),
    "strike" DOUBLE PRECISION,
    "optionType" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candles" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oi_snapshots" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "oi" BIGINT NOT NULL,
    "oiChange" BIGINT NOT NULL DEFAULT 0,
    "volume" BIGINT NOT NULL DEFAULT 0,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oi_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "targetPrice" DOUBLE PRECISION NOT NULL,
    "stoplossPrice" DOUBLE PRECISION NOT NULL,
    "expectedProfit" DOUBLE PRECISION NOT NULL,
    "expectedLoss" DOUBLE PRECISION NOT NULL,
    "riskRewardRatio" DOUBLE PRECISION NOT NULL,
    "confidence" TEXT NOT NULL,
    "confidenceScore" INTEGER NOT NULL,
    "strategy" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "signalId" TEXT,
    "orderId" TEXT,
    "side" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "positionType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "entryPrice" DOUBLE PRECISION,
    "exitPrice" DOUBLE PRECISION,
    "stoploss" DOUBLE PRECISION,
    "target" DOUBLE PRECISION,
    "pnl" DOUBLE PRECISION,
    "pnlPercent" DOUBLE PRECISION,
    "fees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "strategy" TEXT,
    "isPaperTrade" BOOLEAN NOT NULL DEFAULT true,
    "entryTime" TIMESTAMP(3),
    "exitTime" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_performance" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "totalPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unrealizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "winningTrades" INTEGER NOT NULL DEFAULT 0,
    "losingTrades" INTEGER NOT NULL DEFAULT 0,
    "maxDrawdown" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "capitalDeployed" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "daily_performance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_articles" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "source" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sentiment" TEXT,
    "sentimentScore" DOUBLE PRECISION,
    "relatedSymbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "news_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_trade_analyses" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "analysis" TEXT NOT NULL,
    "suggestions" TEXT NOT NULL,
    "patterns" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_trade_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_weekly_reports" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "weekEnd" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "strengths" TEXT NOT NULL,
    "weaknesses" TEXT NOT NULL,
    "recommendations" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_weekly_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "id" TEXT NOT NULL,
    "autoTradeMode" TEXT NOT NULL DEFAULT 'OFF',
    "paperTrading" BOOLEAN NOT NULL DEFAULT true,
    "maxDailyLoss" DOUBLE PRECISION NOT NULL DEFAULT 5000,
    "maxCapitalPerTrade" DOUBLE PRECISION NOT NULL DEFAULT 50000,
    "maxConcurrentPositions" INTEGER NOT NULL DEFAULT 5,
    "defaultRiskReward" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "activeStrategies" TEXT[] DEFAULT ARRAY['gamma-blast']::TEXT[],
    "preferredSegments" TEXT[] DEFAULT ARRAY['OPTIONS', 'EQUITY']::TEXT[],
    "tradingHoursOnly" BOOLEAN NOT NULL DEFAULT true,
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT,
    "type" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "message" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_runs" (
    "id" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "parameters" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "totalTrades" INTEGER NOT NULL,
    "winRate" DOUBLE PRECISION NOT NULL,
    "totalReturn" DOUBLE PRECISION NOT NULL,
    "maxDrawdown" DOUBLE PRECISION NOT NULL,
    "sharpeRatio" DOUBLE PRECISION NOT NULL,
    "results" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instruments_exchange_segment_idx" ON "instruments"("exchange", "segment");

-- CreateIndex
CREATE INDEX "instruments_symbol_idx" ON "instruments"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "instruments_symbol_exchange_token_key" ON "instruments"("symbol", "exchange", "token");

-- CreateIndex
CREATE INDEX "candles_instrumentId_timeframe_timestamp_idx" ON "candles"("instrumentId", "timeframe", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "candles_instrumentId_timeframe_timestamp_key" ON "candles"("instrumentId", "timeframe", "timestamp");

-- CreateIndex
CREATE INDEX "oi_snapshots_instrumentId_timestamp_idx" ON "oi_snapshots"("instrumentId", "timestamp");

-- CreateIndex
CREATE INDEX "signals_isActive_confidenceScore_idx" ON "signals"("isActive", "confidenceScore");

-- CreateIndex
CREATE INDEX "signals_strategy_idx" ON "signals"("strategy");

-- CreateIndex
CREATE INDEX "signals_createdAt_idx" ON "signals"("createdAt");

-- CreateIndex
CREATE INDEX "trades_status_idx" ON "trades"("status");

-- CreateIndex
CREATE INDEX "trades_createdAt_idx" ON "trades"("createdAt");

-- CreateIndex
CREATE INDEX "trades_strategy_idx" ON "trades"("strategy");

-- CreateIndex
CREATE INDEX "trades_isPaperTrade_idx" ON "trades"("isPaperTrade");

-- CreateIndex
CREATE UNIQUE INDEX "daily_performance_date_key" ON "daily_performance"("date");

-- CreateIndex
CREATE INDEX "daily_performance_date_idx" ON "daily_performance"("date");

-- CreateIndex
CREATE UNIQUE INDEX "news_articles_url_key" ON "news_articles"("url");

-- CreateIndex
CREATE INDEX "news_articles_category_publishedAt_idx" ON "news_articles"("category", "publishedAt");

-- CreateIndex
CREATE INDEX "news_articles_sentiment_idx" ON "news_articles"("sentiment");

-- CreateIndex
CREATE INDEX "ai_trade_analyses_createdAt_idx" ON "ai_trade_analyses"("createdAt");

-- CreateIndex
CREATE INDEX "ai_weekly_reports_weekStart_idx" ON "ai_weekly_reports"("weekStart");

-- CreateIndex
CREATE INDEX "alerts_isActive_type_idx" ON "alerts"("isActive", "type");

-- CreateIndex
CREATE INDEX "backtest_runs_strategy_createdAt_idx" ON "backtest_runs"("strategy", "createdAt");

-- AddForeignKey
ALTER TABLE "candles" ADD CONSTRAINT "candles_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oi_snapshots" ADD CONSTRAINT "oi_snapshots_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "instruments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
