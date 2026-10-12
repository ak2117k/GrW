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
import { CORE_SESSION_CLOCK, CORE_SQUARE_OFF, LoggingRiskVerdictSink, RISK_STATE_PROVIDER, RISK_VERDICT_SINK } from './risk-wall/ports';
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
    expect(mod.get(RISK_VERDICT_SINK)).toBeInstanceOf(LoggingRiskVerdictSink);
    expect(mod.get(CoreRiskDefaultsController)).toBeInstanceOf(CoreRiskDefaultsController);
    expect(mod.get(CoreRiskDefaultsService)).toBeInstanceOf(CoreRiskDefaultsService);
    expect(mod.get(CoreKillSwitchReader)).toBeInstanceOf(CoreKillSwitchReader);
  });

  it('resolves the M3 execution parts and rebinds the M2 ports to them', async () => {
    const mod = await compile();
    expect(mod.get(RISK_STATE_PROVIDER)).toBeInstanceOf(PaperRiskStateProvider);
    expect(mod.get(CORE_SQUARE_OFF)).toBeInstanceOf(PaperOrderSquareOff);
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
    const squareOff = mod.get<PaperOrderSquareOff>(CORE_SQUARE_OFF);
    const adapter = mod.get(PaperExecutionAdapter);
    const matcher = mod.get(PaperMatcherService);
    expect((squareOff as unknown as { matcher: unknown }).matcher).toBe(matcher);
    expect((adapter as unknown as { matcher: unknown }).matcher).toBe(matcher);
    expect(mod.get(CoreKillSwitchService)).toBe((adapter as unknown as { killSwitch: unknown }).killSwitch);
  });
});
