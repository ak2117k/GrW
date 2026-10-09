import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyRepository } from './strategies/repositories/core-strategy.repository';
import { CoreStrategySelectionRepository } from './strategies/repositories/core-strategy-selection.repository';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';

/**
 * SP2 trade core (docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md).
 * M1 ships the `strategies/` part only: the catalogue, immutable versions and
 * per-user selections. Later milestones add risk-wall/, execution/, lifecycle/
 * and journal/ here. Nothing in M1 trades; AuditService comes from the @Global
 * AuditModule. Imports no silo module (approach A).
 */
@Module({
  imports: [PrismaModule],
  controllers: [CoreStrategiesController],
  providers: [
    CoreStrategyRepository,
    CoreStrategySelectionRepository,
    CoreStrategyCatalogueService,
    CoreStrategySelectionService,
  ],
  exports: [CoreStrategyCatalogueService, CoreStrategySelectionService],
})
export class TradeCoreModule {}
