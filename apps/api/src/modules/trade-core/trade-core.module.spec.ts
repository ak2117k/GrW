import { Global, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service';
import { JobRunnerService } from '../../common/job-registry';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { SessionClock } from '../market-hub/session-clock';
import { TradeCoreModule } from './trade-core.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';
import { CoreRiskController } from './risk-wall/controllers/core-risk.controller';
import { CoreRiskDefaultsController } from './risk-wall/controllers/core-risk-defaults.controller';
import { CoreRiskDefaultsService } from './risk-wall/services/core-risk-defaults.service';
import { CORE_SESSION_CLOCK, CORE_SQUARE_OFF, RISK_STATE_PROVIDER, RISK_VERDICT_SINK } from './risk-wall/ports';
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
import { CoreCashLedgerRepository } from './execution/repositories/core-cash-ledger.repository';
import { CoreFillRepository } from './execution/repositories/core-fill.repository';
import { CoreOrderRepository } from './execution/repositories/core-order.repository';
import { CorePaperDefaultsRepository } from './execution/repositories/core-paper-defaults.repository';
import { CorePaperTx } from './execution/repositories/core-paper-tx';
import { CorePaperDefaultsService } from './execution/services/core-paper-defaults.service';
import { CoreOrderEvents } from './execution/order-events';
import { CorePositionsController } from './lifecycle/controllers/core-positions.controller';
import { CoreLifecycleService } from './lifecycle/core-lifecycle.service';
import { CoreRiskStateProvider } from './lifecycle/core-risk-state.provider';
import { CoreSquareOff } from './lifecycle/core-square-off';
import { DailyLossMonitor } from './lifecycle/daily-loss.monitor';
import { LIFECYCLE_EVENT_SINK } from './lifecycle/lifecycle-events';
import { CORE_POSITION_EXITS, LIFECYCLE_MARKS } from './lifecycle/lifecycle-ports';
import { CorePositionRepository } from './lifecycle/repositories/core-position.repository';
import { currentCoreAlertIntake, setCoreAlertIntake } from './intake/alert-handoff';
import { CoreEntryIntake } from './intake/core-entry-intake.service';
import { CORE_ENTRY_CONFIG } from './intake/entry-config';
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
 * Stands in for the real @Global AuditModule, @Global JobRegistryModule, @Global
 * TenantModule and the global ClsModule.forRoot({ global: true }), which AppModule provides.
 */
@Global()
@Module({
  providers: [
    { provide: AuditService, useValue: { append: jest.fn() } },
    { provide: JobRunnerService, useValue: { run: jest.fn() } },
    { provide: TenantContextService, useValue: { runWithoutTenant: (fn: () => unknown) => fn() } },
    { provide: ClsService, useValue: { isActive: () => false } },
  ],
  exports: [AuditService, JobRunnerService, TenantContextService, ClsService],
})
class FakeAuditModule {}

async function compile() {
  return Test.createTestingModule({ imports: [FakeAuditModule, TradeCoreModule] })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
}

describe('TradeCoreModule', () => {
  it('resolves the controller and both services', async () => {
    const mod = await compile();
    expect(mod.get(CoreStrategiesController)).toBeInstanceOf(CoreStrategiesController);
    expect(mod.get(CoreStrategyCatalogueService)).toBeInstanceOf(CoreStrategyCatalogueService);
    expect(mod.get(CoreStrategySelectionService)).toBeInstanceOf(CoreStrategySelectionService);
  });

  it('resolves the M2 risk parts', async () => {
    const mod = await compile();
    expect(mod.get(CoreRiskController)).toBeInstanceOf(CoreRiskController);
    expect(mod.get(RiskWallService)).toBeInstanceOf(RiskWallService);
    expect(mod.get(CoreRiskLimitService)).toBeInstanceOf(CoreRiskLimitService);
    expect(mod.get(CoreKillSwitchService)).toBeInstanceOf(CoreKillSwitchService);
    expect(mod.get(SiloSquareOffAdapter)).toBeInstanceOf(SiloSquareOffAdapter);
    expect(mod.get(CORE_SESSION_CLOCK)).toBeInstanceOf(SessionClock);
    expect(mod.get(RISK_VERDICT_SINK)).toBeInstanceOf(JournalRiskVerdictSink);
    expect(mod.get(CoreRiskDefaultsController)).toBeInstanceOf(CoreRiskDefaultsController);
    expect(mod.get(CoreRiskDefaultsService)).toBeInstanceOf(CoreRiskDefaultsService);
    expect(mod.get(CoreKillSwitchReader)).toBeInstanceOf(CoreKillSwitchReader);
  });

  it('resolves the M3 execution parts and rebinds the M2 ports to them', async () => {
    const mod = await compile();
    expect(mod.get(RISK_STATE_PROVIDER)).toBeInstanceOf(CoreRiskStateProvider);
    expect(mod.get(CORE_SQUARE_OFF)).toBeInstanceOf(CoreSquareOff);
    expect(mod.get(CORE_EXECUTION_ADAPTER)).toBeInstanceOf(PaperExecutionAdapter);
    expect(mod.get(CORE_EXECUTION_ADAPTER)).toBe(mod.get(PaperExecutionAdapter));
    expect(mod.get(PaperLedgerService)).toBeInstanceOf(PaperLedgerService);
    expect(mod.get(PaperMatcherService)).toBeInstanceOf(PaperMatcherService);
    expect(mod.get(CorePaperDefaultsService)).toBeInstanceOf(CorePaperDefaultsService);
    expect(mod.get(CorePaperDefaultsController)).toBeInstanceOf(CorePaperDefaultsController);
    expect(mod.get(MtfInterestCron)).toBeInstanceOf(MtfInterestCron);
    for (const repo of [CoreOrderRepository, CoreFillRepository, CoreCashLedgerRepository, CorePaperDefaultsRepository, CorePaperTx]) {
      expect(mod.get(repo)).toBeInstanceOf(repo);
    }
  });

  it('mounts the paper defaults controller and exports the execution adapter', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, TradeCoreModule)).toContain(CorePaperDefaultsController);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, TradeCoreModule)).toEqual(expect.arrayContaining([PaperExecutionAdapter, CORE_EXECUTION_ADAPTER]));
  });

  it('one process, one matcher: the square-off and the adapter share the ledger and matcher singletons', async () => {
    const mod = await compile();
    const squareOff = mod.get(PaperOrderSquareOff);
    const adapter = mod.get(PaperExecutionAdapter);
    const matcher = mod.get(PaperMatcherService);
    expect((squareOff as unknown as { matcher: unknown }).matcher).toBe(matcher);
    expect((adapter as unknown as { matcher: unknown }).matcher).toBe(matcher);
    expect(mod.get(CoreKillSwitchService)).toBe((adapter as unknown as { killSwitch: unknown }).killSwitch);
  });

  it('resolves the M4 lifecycle parts: one lifecycle behind both ports, one order-event stream', async () => {
    const mod = await compile();
    const lifecycle = mod.get(CoreLifecycleService);
    expect(lifecycle).toBeInstanceOf(CoreLifecycleService);
    expect(mod.get(LIFECYCLE_MARKS)).toBe(lifecycle);
    expect(mod.get(CORE_POSITION_EXITS)).toBe(lifecycle);
    expect(mod.get(LIFECYCLE_EVENT_SINK)).toBeInstanceOf(JournalLifecycleSink);
    expect(mod.get(DailyLossMonitor)).toBeInstanceOf(DailyLossMonitor);
    expect(mod.get(CorePositionRepository)).toBeInstanceOf(CorePositionRepository);
    expect((mod.get(PaperLedgerService) as unknown as { events: unknown }).events).toBe(mod.get(CoreOrderEvents));
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, TradeCoreModule)).toContain(CorePositionsController);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, TradeCoreModule)).toEqual(expect.arrayContaining([CoreLifecycleService]));
  });

  it('resolves the M5 journal, outcomes, reconciliation and intake, one instance behind each port', async () => {
    const mod = await compile();
    const journal = mod.get(CoreJournalService);
    expect(mod.get(CORE_JOURNAL)).toBe(journal);
    expect(mod.get(CORE_JOURNAL_STATUS)).toBe(journal);
    const summaries = mod.get(CoreTradeSummaryService);
    expect(mod.get(CORE_POSITION_CLOSED)).toBe(summaries);
    expect(mod.get(CORE_TRADE_HISTORY)).toBe(summaries);
    expect(mod.get(CORE_CORPUS)).toBe(mod.get(CoreCorpusWriter));
    expect(mod.get(JOURNAL_RISK_READS)).toBe(mod.get(JournalRiskReads));
    expect(mod.get(CORE_RECON_DESK)).toBe(mod.get(CoreReconciler));
    expect(mod.get(CORE_INTAKE_STATUS)).toBe(mod.get(CoreEntryIntake));
    expect(mod.get(CORE_ENTRY_CONFIG)).toEqual({ mode: 'off', userIds: new Set(), maxAlertAgeMs: 180_000 }); // the test env sets neither variable
    for (const cls of [OrderJournaler, SkipFollowupCron, BrokerCorpusCron, SiloComparisonReader, EntryMarket, CoreCandles, CoreJournalRepository, CoreTradeSummaryRepository]) {
      expect(mod.get(cls)).toBeInstanceOf(cls);
    }
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, TradeCoreModule)).toContain(CoreJournalController);
    expect(mod.get(CoreJournalController)).toBeInstanceOf(CoreJournalController);
    expect((mod.get(RISK_STATE_PROVIDER) as unknown as { reads: unknown }).reads).toBe(mod.get(JournalRiskReads));
  });

  it('binds CORE_JOURNAL into every optional consumer, so kill-switch, limit, latch and lifecycle rows never silently vanish', async () => {
    const mod = await compile();
    const journal = mod.get(CoreJournalService);
    const field = (o: unknown, k: string): unknown => (o as Record<string, unknown>)[k];
    expect(field(mod.get(CoreKillSwitchService), 'journal')).toBe(journal);
    expect(field(mod.get(CoreRiskLimitService), 'journal')).toBe(journal);
    expect(field(mod.get(DailyLossMonitor), 'journal')).toBe(journal);
    const sink = mod.get(LIFECYCLE_EVENT_SINK);
    expect(field(sink, 'journal')).toBe(journal);
    expect(field(sink, 'closed')).toBe(mod.get(CoreTradeSummaryService));
    expect(field(mod.get(RISK_VERDICT_SINK), 'journal')).toBe(journal);
    expect(field(mod.get(CoreTradeSummaryService), 'corpus')).toBe(mod.get(CoreCorpusWriter));
    expect(field(mod.get(CoreReconciler), 'adapter')).toBe(mod.get(PaperExecutionAdapter));
    expect(field(mod.get(CoreJournalController), 'desk')).toBe(mod.get(CoreReconciler));
  });

  it('safety default: with CORE_ENTRIES_MODE unset the intake never registers its Chartink hand-off', async () => {
    setCoreAlertIntake(null);
    const mod = await compile();
    const intake = mod.get(CoreEntryIntake);
    intake.onModuleInit();
    expect(currentCoreAlertIntake()).toBeNull();
    expect(intake.status()).toMatchObject({ mode: 'off', users: 0, pending: 0 });
  });
});
