import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PortfolioController } from './controllers/portfolio.controller';
import { PortfolioService } from './services/portfolio.service';
import { PortfolioRepository } from './repositories/portfolio.repository';

@Module({
  imports: [PrismaModule],
  controllers: [PortfolioController],
  providers: [PortfolioService, PortfolioRepository],
  exports: [PortfolioService],
})
export class PortfolioModule {}
