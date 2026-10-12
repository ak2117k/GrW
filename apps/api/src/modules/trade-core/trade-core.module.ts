import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyRepository } from './strategies/repositories/core-strategy.repository';
import { CoreStrategySelectionRepository } from './strategies/repositories/core-strategy-selection.repository';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';
import { CoreRiskController } from './risk-wall/controllers/core-risk.controller';
import { CoreRiskDefaultsController } from './risk-wall/controllers/core-risk-defaults.controller';
import { CoreRiskDefaultsService } from './risk-wall/services/core-risk-defaults.service';
import { CORE_SESSION_CLOCK, CORE_SQUARE_OFF, createCoreSessionClock, LoggingRiskVerdictSink, RISK_STATE_PROVIDER, RISK_VERDICT_SINK } from './risk-wall/ports';
import { CoreKillSwitchRepository } from './risk-wall/repositories/core-kill-switch.repository';
import { CoreRiskLimitRepository } from './risk-wall/repositories/core-risk-limit.repository';
import { CoreKillSwitchReader } from './risk-wall/services/core-kill-switch.reader';
import { CoreKillSwitchService } from './risk-wall/services/core-kill-switch.service';
import { CoreRiskLimitService } from './risk-wall/services/core-risk-limit.service';
import { RiskWallService } from './risk-wall/services/risk-wall.service';
import { SiloSquareOffAdapter } from './risk-wall/services/silo-square-off.adapter';
import { CorePaperDefaultsController } from './execution/controllers/core-paper-defaults.controller';
import { MtfInterestCron } from './execution/mtf-interest.cron';
import { CORE_EXECUTION_ADAPTER, PaperExecutionAdapter } from './execution/paper-execution.adapter';
import { PaperLedgerService } from './execution/paper-ledger.service';
import { PaperMatcherService } from './execution/paper-matcher.service';
import { PaperOrderSquareOff } from './execution/paper-order-square-off';
import { PaperRiskStateProvider } from './execution/paper-risk-state.provider';
import { CoreCashLedgerRepository } from './execution/repositories/core-cash-ledger.repository';
import { CoreFillRepository } from './execution/repositories/core-fill.repository';
import { CoreOrderRepository } from './execution/repositories/core-order.repository';
import { CorePaperDefaultsRepository } from './execution/repositories/core-paper-defaults.repository';
import { CorePaperTx } from './execution/repositories/core-paper-tx';
import { CorePaperDefaultsService } from './execution/services/core-paper-defaults.service';

/**
 * SP2 trade core (docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md).
 * M1: `strategies/` (catalogue, immutable versions, per-user selections).
 * M2: `risk-wall/` (the pure Risk Wall check, per-user limits with tighten-now /
 * loosen-next-session, the persistent kill switch and its silo cascade).
 * M3: `execution/` (the paper ExecutionAdapter for cash, MTF and options; orders, fills
 * and the cash ledger; the in-memory matcher fed by the market hub; nightly MTF
 * interest). M3 rebinds RISK_STATE_PROVIDER (still rejecting every entry until M4 marks
 * positions) and CORE_SQUARE_OFF (cancels pending core orders through the ledger and the
 * matcher, never through the adapter, which injects the kill switch that injects it).
 * Nothing calls the adapter before M5. AuditService and JobRunnerService come from their
 * @Global modules; the market hub is reached lazily through ModuleRef (HUB_PRICE_SOURCE),
 * and no silo module is imported (approach A).
 */
@Module({
  imports: [PrismaModule],
  controllers: [CoreStrategiesController, CoreRiskController, CoreRiskDefaultsController, CorePaperDefaultsController],
  providers: [
    CoreStrategyRepository,
    CoreStrategySelectionRepository,
    CoreStrategyCatalogueService,
    CoreStrategySelectionService,
    CoreRiskLimitRepository,
    CoreKillSwitchRepository,
    CoreRiskLimitService,
    CoreRiskDefaultsService,
    CoreKillSwitchService,
    CoreKillSwitchReader,
    SiloSquareOffAdapter,
    RiskWallService,
    CoreOrderRepository,
    CoreFillRepository,
    CoreCashLedgerRepository,
    CorePaperDefaultsRepository,
    CorePaperTx,
    CorePaperDefaultsService,
    PaperLedgerService,
    PaperMatcherService,
    PaperExecutionAdapter,
    MtfInterestCron,
    { provide: CORE_EXECUTION_ADAPTER, useExisting: PaperExecutionAdapter },
    { provide: CORE_SESSION_CLOCK, useFactory: createCoreSessionClock },
    { provide: RISK_STATE_PROVIDER, useClass: PaperRiskStateProvider },
    { provide: RISK_VERDICT_SINK, useClass: LoggingRiskVerdictSink },
    { provide: CORE_SQUARE_OFF, useClass: PaperOrderSquareOff },
  ],
  exports: [
    CoreStrategyCatalogueService,
    CoreStrategySelectionService,
    RiskWallService,
    CoreRiskLimitService,
    CoreKillSwitchService,
    PaperExecutionAdapter,
    CORE_EXECUTION_ADAPTER,
  ],
})
export class TradeCoreModule {}
