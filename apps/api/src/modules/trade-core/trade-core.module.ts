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
import { CORE_SESSION_CLOCK, CORE_SQUARE_OFF, createCoreSessionClock, RISK_STATE_PROVIDER, RISK_VERDICT_SINK } from './risk-wall/ports';
import { CoreKillSwitchRepository } from './risk-wall/repositories/core-kill-switch.repository';
import { CoreRiskLimitRepository } from './risk-wall/repositories/core-risk-limit.repository';
import { CoreKillSwitchReader } from './risk-wall/services/core-kill-switch.reader';
import { CoreKillSwitchService } from './risk-wall/services/core-kill-switch.service';
import { CoreRiskLimitService } from './risk-wall/services/core-risk-limit.service';
import { RiskWallService } from './risk-wall/services/risk-wall.service';
import { SiloSquareOffAdapter } from './risk-wall/services/silo-square-off.adapter';
import { CorePaperDefaultsController } from './execution/controllers/core-paper-defaults.controller';
import { MtfInterestCron } from './execution/mtf-interest.cron';
import { CoreOrderEvents } from './execution/order-events';
import { CORE_EXECUTION_ADAPTER, PaperExecutionAdapter } from './execution/paper-execution.adapter';
import { PaperLedgerService } from './execution/paper-ledger.service';
import { PaperMatcherService } from './execution/paper-matcher.service';
import { PaperOrderSquareOff } from './execution/paper-order-square-off';
import { CoreCashLedgerRepository } from './execution/repositories/core-cash-ledger.repository';
import { CoreFillRepository } from './execution/repositories/core-fill.repository';
import { CoreOrderRepository } from './execution/repositories/core-order.repository';
import { CorePaperDefaultsRepository } from './execution/repositories/core-paper-defaults.repository';
import { CorePaperTx } from './execution/repositories/core-paper-tx';
import { CorePaperDefaultsService } from './execution/services/core-paper-defaults.service';
import { CorePositionsController } from './lifecycle/controllers/core-positions.controller';
import { CoreLifecycleService } from './lifecycle/core-lifecycle.service';
import { CoreRiskStateProvider } from './lifecycle/core-risk-state.provider';
import { CoreSquareOff } from './lifecycle/core-square-off';
import { DailyLossMonitor } from './lifecycle/daily-loss.monitor';
import { LIFECYCLE_EVENT_SINK } from './lifecycle/lifecycle-events';
import { CORE_POSITION_EXITS, LIFECYCLE_MARKS } from './lifecycle/lifecycle-ports';
import { CorePositionRepository } from './lifecycle/repositories/core-position.repository';
import { CoreEntryIntake } from './intake/core-entry-intake.service';
import { CORE_ENTRY_CONFIG, readEntryConfig } from './intake/entry-config';
import { EntryMarket } from './intake/entry-market';
import { CoreCandles } from './market/core-candles';
import { BrokerCorpusCron } from './journal/broker-corpus.cron';
import { CoreJournalController } from './journal/controllers/core-journal.controller';
import { CoreCorpusWriter } from './journal/core-corpus.writer';
import { CoreJournalService } from './journal/core-journal.service';
import { CoreReconciler } from './journal/core-reconciler.service';
import { CoreTradeSummaryService } from './journal/core-trade-summary.service';
import {
  CORE_CORPUS, CORE_INTAKE_STATUS, CORE_JOURNAL, CORE_JOURNAL_STATUS, CORE_POSITION_CLOSED, CORE_RECON_DESK, CORE_TRADE_HISTORY,
} from './journal/journal-ports';
import { JOURNAL_RISK_READS, JournalRiskReads } from './journal/journal-risk-reads';
import { JournalLifecycleSink, JournalRiskVerdictSink } from './journal/journal-sinks';
import { OrderJournaler } from './journal/order-journaler';
import { CoreJournalRepository } from './journal/repositories/core-journal.repository';
import { CoreTradeSummaryRepository } from './journal/repositories/core-trade-summary.repository';
import { SiloComparisonReader } from './journal/silo-comparison.reader';
import { SkipFollowupCron } from './journal/skip-followup.cron';

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
 * M4: `lifecycle/` (core positions, exits by rule and priority, blind detection, crash
 * recovery). M4 rebinds RISK_STATE_PROVIDER to CoreRiskStateProvider (marks, open and
 * per-strategy P&L) and CORE_SQUARE_OFF to CoreSquareOff (entry orders cancelled, every
 * position exited; the lifecycle is reached lazily through CORE_POSITION_EXITS, because
 * the adapter it uses injects the kill switch, which injects CORE_SQUARE_OFF).
 * DailyLossMonitor runs every 5 s. Nothing opens a position before M5.
 * M5: `journal/` (core_journal and the sinks that rebind RISK_VERDICT_SINK and LIFECYCLE_EVENT_SINK to it,
 * order/fill rows, closed-trade summaries, the SP3 corpus rows, the daily-loss latch and the
 * reconciliation block read by the Risk Wall, 5-minute and 15:45 IST reconciliation, 16:10 IST
 * skipped-intent follow-ups, 16:20 IST broker trades into the corpus, the journal API) and `intake/`
 * (Chartink hits → CoreEntryIntent → Risk Wall → openPosition, behind CORE_ENTRIES_MODE=off|journal|paper
 * and CORE_ENTRY_USER_IDS; reached from ChartinkProcessService through the handOffChartinkHit registry,
 * so ChartinkModule imports nothing new). None of the M5 providers is a dependency of the adapter, the
 * kill switch or the square-off, so no new cycle: the kill switch and limit service take CORE_JOURNAL
 * (repository-only), and the hub is still reached lazily through ModuleRef.
 */
@Module({
  imports: [PrismaModule],
  controllers: [CoreStrategiesController, CoreRiskController, CoreRiskDefaultsController, CorePaperDefaultsController, CorePositionsController, CoreJournalController],
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
    // SP2 M4 (ruling L3): one emitter shared by the ledger and the lifecycle.
    CoreOrderEvents,
    PaperLedgerService,
    PaperMatcherService,
    PaperExecutionAdapter,
    MtfInterestCron,
    // SP2 M4: the Position Manager and the M2 ports rebound to its positions (ruling L14).
    PaperOrderSquareOff,
    CorePositionRepository,
    CoreLifecycleService,
    CoreSquareOff,
    DailyLossMonitor,
    { provide: LIFECYCLE_EVENT_SINK, useClass: JournalLifecycleSink },
    { provide: LIFECYCLE_MARKS, useExisting: CoreLifecycleService },
    { provide: CORE_POSITION_EXITS, useExisting: CoreLifecycleService },
    { provide: CORE_EXECUTION_ADAPTER, useExisting: PaperExecutionAdapter },
    { provide: CORE_SESSION_CLOCK, useFactory: createCoreSessionClock },
    { provide: RISK_STATE_PROVIDER, useClass: CoreRiskStateProvider },
    { provide: RISK_VERDICT_SINK, useClass: JournalRiskVerdictSink },
    { provide: CORE_SQUARE_OFF, useExisting: CoreSquareOff },
    // SP2 M5: the journal (J10), its writers, summaries (J16), the corpus (O9, every trading mode), the
    // broker corpus (Task 13b), the latch and recon block reads (J12, J13), reconciliation (J17),
    // follow-ups (J14), the journal API and the intake (default off).
    CoreCandles,
    CoreJournalRepository,
    CoreTradeSummaryRepository,
    CoreJournalService,
    { provide: CORE_JOURNAL, useExisting: CoreJournalService },
    { provide: CORE_JOURNAL_STATUS, useExisting: CoreJournalService },
    OrderJournaler,
    CoreCorpusWriter,
    { provide: CORE_CORPUS, useExisting: CoreCorpusWriter },
    CoreTradeSummaryService,
    { provide: CORE_POSITION_CLOSED, useExisting: CoreTradeSummaryService },
    { provide: CORE_TRADE_HISTORY, useExisting: CoreTradeSummaryService },
    SkipFollowupCron,
    BrokerCorpusCron,
    JournalRiskReads,
    { provide: JOURNAL_RISK_READS, useExisting: JournalRiskReads },
    CoreReconciler,
    { provide: CORE_RECON_DESK, useExisting: CoreReconciler },
    SiloComparisonReader,
    EntryMarket,
    { provide: CORE_ENTRY_CONFIG, useFactory: () => readEntryConfig(process.env) },
    CoreEntryIntake,
    { provide: CORE_INTAKE_STATUS, useExisting: CoreEntryIntake },
  ],
  exports: [
    CoreStrategyCatalogueService,
    CoreStrategySelectionService,
    RiskWallService,
    CoreRiskLimitService,
    CoreKillSwitchService,
    PaperExecutionAdapter,
    CORE_EXECUTION_ADAPTER,
    CoreLifecycleService,
  ],
})
export class TradeCoreModule {}
