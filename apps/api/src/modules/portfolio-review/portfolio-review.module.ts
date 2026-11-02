import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiAssistModule } from '../ai-assist/ai-assist.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { LiveTradesRepository } from '../portfolio/repositories/live-trades.repository';
import { PortfolioReviewController } from './controllers/portfolio-review.controller';
import { PortfolioReviewRepository } from './repositories/portfolio-review.repository';
import { PortfolioReviewService } from './services/portfolio-review.service';

/**
 * Portfolio review (owner 2026-11-02: "look at all the history, holdings, trades — analyse it and tell
 * us how to improve"). Deterministic analysis of the caller's REAL broker book (trade_trackers +
 * the app's live exits; paper excluded) in domain/*, daily-candle trend per holding over the caller's
 * own session, and an owner-only plain-language summary through the advisor's Claude door
 * (AssistLlmService, shared slot only). READ-ONLY on trading data; writes only portfolio_reviews.
 * `portfolioReviewDigest` (domain/report.ts) is the one-paragraph text for the AI advisor.
 */
@Module({
  imports: [PrismaModule, MarketDataModule, AiAssistModule],
  controllers: [PortfolioReviewController],
  providers: [PortfolioReviewRepository, LiveTradesRepository, PortfolioReviewService],
  exports: [PortfolioReviewService],
})
export class PortfolioReviewModule {}
