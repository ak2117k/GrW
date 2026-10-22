import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PortfolioController } from './controllers/portfolio.controller';
import { PortfolioService } from './services/portfolio.service';
import { PortfolioRepository } from './repositories/portfolio.repository';
import { LiveTradesRepository } from './repositories/live-trades.repository';
import { LivePerformanceService } from './services/live-performance.service';

@Module({
  imports: [PrismaModule],
  controllers: [PortfolioController],
  providers: [PortfolioService, PortfolioRepository, LivePerformanceService, LiveTradesRepository],
  exports: [PortfolioService],
})
export class PortfolioModule {}
