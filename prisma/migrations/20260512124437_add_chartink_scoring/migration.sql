-- AlterTable
ALTER TABLE "chartink_alert_setups" ADD COLUMN "score" INTEGER;

-- AlterTable
ALTER TABLE "chartink_alert_setups" ADD COLUMN "lotCount" INTEGER;

-- AlterTable
ALTER TABLE "chartink_alert_setups" ADD COLUMN "scoreBreakdown" JSONB;
