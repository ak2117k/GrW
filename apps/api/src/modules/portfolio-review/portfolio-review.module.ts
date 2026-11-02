import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiAssistModule } from '../ai-assist/ai-assist.module';
import { CredentialVaultModule } from '../credential-vault/credential-vault.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { LiveTradesRepository } from '../portfolio/repositories/live-trades.repository';
import { PortfolioReviewController } from './controllers/portfolio-review.controller';
import { PlanDataRepository } from './repositories/plan-data.repository';
import { PortfolioReviewRepository } from './repositories/portfolio-review.repository';
import { PlanDataService } from './services/plan-data.service';
import { PortfolioReviewService } from './services/portfolio-review.service';

/**
 * Portfolio review (owner 2026-11-02: "look at all the history, holdings, trades — analyse it and tell
 * us how to improve", then "tell the things one CAN do"). Run on demand only (POST /run; opening the
 * page reads the stored review). Deterministic analysis of the caller's REAL broker book
 * (trade_trackers + the app's live exits; paper excluded) in domain/*, plus the forward-looking action
 * plan (domain/action-plan.ts): daily candles + futures OI over the caller's own session, the broker
 * balance (BrokerOverviewService.getFunds, read-only), news / events / sectors from the DB. Owner-only
 * plain-language texts through the advisor's Claude door (AssistLlmService, shared slot only).
 * READ-ONLY on trading data; writes only portfolio_reviews and portfolio_review_runs.
 * `portfolioReviewDigest` (domain/report.ts) is the one-paragraph text for the AI advisor.
 */
@Module({
  imports: [PrismaModule, MarketDataModule, AiAssistModule, CredentialVaultModule],
  controllers: [PortfolioReviewController],
  providers: [PortfolioReviewRepository, PlanDataRepository, LiveTradesRepository, PlanDataService, PortfolioReviewService],
  exports: [PortfolioReviewService],
})
export class PortfolioReviewModule {}
