import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { FundamentalsController } from './fundamentals.controller';
import { FundamentalsService } from './fundamentals.service';

/**
 * Fundamentals module — exposes GET /api/fundamentals/:symbol backed by
 * Yahoo Finance's quoteSummary endpoint with a 24h in-memory cache.
 *
 * Stays self-contained: no DB, no shared cache, no broker adapter — the
 * Yahoo path is independent of Angel One so this works even when the
 * broker session is down.
 */
@Module({
  imports: [HttpModule.register({ timeout: 5000 })],
  controllers: [FundamentalsController],
  providers: [FundamentalsService],
  exports: [FundamentalsService],
})
export class FundamentalsModule {}
