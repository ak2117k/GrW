import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TradeCoreModule } from './trade-core.module';
import { CoreStrategiesController } from './strategies/controllers/core-strategies.controller';
import { CoreStrategyCatalogueService } from './strategies/services/core-strategy-catalogue.service';
import { CoreStrategySelectionService } from './strategies/services/core-strategy-selection.service';

/** Stands in for the real @Global AuditModule, which AppModule provides. */
@Global()
@Module({ providers: [{ provide: AuditService, useValue: { append: jest.fn() } }], exports: [AuditService] })
class FakeAuditModule {}

describe('TradeCoreModule', () => {
  it('resolves the controller and both services', async () => {
    const mod = await Test.createTestingModule({ imports: [FakeAuditModule, TradeCoreModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    expect(mod.get(CoreStrategiesController)).toBeInstanceOf(CoreStrategiesController);
    expect(mod.get(CoreStrategyCatalogueService)).toBeInstanceOf(CoreStrategyCatalogueService);
    expect(mod.get(CoreStrategySelectionService)).toBeInstanceOf(CoreStrategySelectionService);
  });
});
