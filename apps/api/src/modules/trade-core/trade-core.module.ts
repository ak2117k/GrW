import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyRepository } from './strategies/repositories/core-strategy.repository';
import { CoreStrategySelectionRepository } from './strategies/repositories/core-strategy-selection.repository';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';
import { CoreRiskController } from './risk-wall/controllers/core-risk.controller';
import {
  CORE_SESSION_CLOCK,
  CORE_SQUARE_OFF,
  createCoreSessionClock,
  LoggingRiskVerdictSink,
  NoCorePositionsSquareOff,
  RISK_STATE_PROVIDER,
  RISK_VERDICT_SINK,
  UnavailableRiskStateProvider,
} from './risk-wall/ports';
import { CoreKillSwitchRepository } from './risk-wall/repositories/core-kill-switch.repository';
import { CoreRiskLimitRepository } from './risk-wall/repositories/core-risk-limit.repository';
import { CoreKillSwitchService } from './risk-wall/services/core-kill-switch.service';
import { CoreRiskLimitService } from './risk-wall/services/core-risk-limit.service';
import { RiskWallService } from './risk-wall/services/risk-wall.service';
import { SiloSquareOffAdapter } from './risk-wall/services/silo-square-off.adapter';

/**
 * SP2 trade core (docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md).
 * M1: `strategies/` (catalogue, immutable versions, per-user selections).
 * M2: `risk-wall/` (the pure Risk Wall check, per-user limits with tighten-now /
 * loosen-next-session, the persistent kill switch and its silo cascade). The four
 * port tokens carry fail-closed M2 defaults that M3/M4/M5 rebind here. Nothing in M2
 * trades. AuditService comes from the @Global AuditModule. No silo module is imported
 * (approach A): SiloSquareOffAdapter reaches the silos' existing entry points through
 * ModuleRef at call time.
 */
@Module({
  imports: [PrismaModule],
  controllers: [CoreStrategiesController, CoreRiskController],
  providers: [
    CoreStrategyRepository,
    CoreStrategySelectionRepository,
    CoreStrategyCatalogueService,
    CoreStrategySelectionService,
    CoreRiskLimitRepository,
    CoreKillSwitchRepository,
    CoreRiskLimitService,
    CoreKillSwitchService,
    SiloSquareOffAdapter,
    RiskWallService,
    { provide: CORE_SESSION_CLOCK, useFactory: createCoreSessionClock },
    { provide: RISK_STATE_PROVIDER, useClass: UnavailableRiskStateProvider },
    { provide: RISK_VERDICT_SINK, useClass: LoggingRiskVerdictSink },
    { provide: CORE_SQUARE_OFF, useClass: NoCorePositionsSquareOff },
  ],
  exports: [CoreStrategyCatalogueService, CoreStrategySelectionService, RiskWallService, CoreRiskLimitService, CoreKillSwitchService],
})
export class TradeCoreModule {}
