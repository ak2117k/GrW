import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SessionClock } from '../market-hub/session-clock';
import { TradeCoreModule } from './trade-core.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';
import { CoreRiskController } from './risk-wall/controllers/core-risk.controller';
import {
  CORE_SESSION_CLOCK,
  CORE_SQUARE_OFF,
  LoggingRiskVerdictSink,
  NoCorePositionsSquareOff,
  RISK_STATE_PROVIDER,
  RISK_VERDICT_SINK,
  UnavailableRiskStateProvider,
} from './risk-wall/ports';
import { CoreKillSwitchService } from './risk-wall/services/core-kill-switch.service';
import { CoreRiskLimitService } from './risk-wall/services/core-risk-limit.service';
import { RiskWallService } from './risk-wall/services/risk-wall.service';
import { SiloSquareOffAdapter } from './risk-wall/services/silo-square-off.adapter';

/** Stands in for the real @Global AuditModule, which AppModule provides. */
@Global()
@Module({ providers: [{ provide: AuditService, useValue: { append: jest.fn() } }], exports: [AuditService] })
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

  it('resolves the M2 risk parts with their fail-closed default ports', async () => {
    const mod = await compile();
    expect(mod.get(CoreRiskController)).toBeInstanceOf(CoreRiskController);
    expect(mod.get(RiskWallService)).toBeInstanceOf(RiskWallService);
    expect(mod.get(CoreRiskLimitService)).toBeInstanceOf(CoreRiskLimitService);
    expect(mod.get(CoreKillSwitchService)).toBeInstanceOf(CoreKillSwitchService);
    expect(mod.get(SiloSquareOffAdapter)).toBeInstanceOf(SiloSquareOffAdapter);
    expect(mod.get(CORE_SESSION_CLOCK)).toBeInstanceOf(SessionClock);
    expect(mod.get(RISK_STATE_PROVIDER)).toBeInstanceOf(UnavailableRiskStateProvider);
    expect(mod.get(RISK_VERDICT_SINK)).toBeInstanceOf(LoggingRiskVerdictSink);
    expect(mod.get(CORE_SQUARE_OFF)).toBeInstanceOf(NoCorePositionsSquareOff);
  });
});
