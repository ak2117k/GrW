// apps/api/src/modules/sentinel-executor/sentinel-executor.module.spec.ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { CREDENTIAL_DECRYPTOR } from '../credential-vault/execution/credential-decryptor';
import { SessionClock } from '../market-hub/session-clock';
import { SentinelExecutorModule } from './sentinel-executor.module';
import { AI_EXIT_SESSION_CLOCK, SentinelExitExecutor } from './services/sentinel-exit-executor.service';
import { SentinelExitPoller } from './services/sentinel-exit-poller.service';
import { ManualExitService } from './services/manual-exit.service';
import { ExitGateService } from './services/exit-gate.service';
import { ExitGateRepository } from './repositories/exit-gate.repository';
import { ExitFillSettler } from './services/exit-fill-settler.service';
import { ExitOutcomeService } from './services/exit-outcome.service';
import { AiExitOutcomeRepository } from './repositories/ai-exit-outcome.repository';
import { EXIT_DISCIPLINE_CONFIG } from '../exit-discipline/config';
import { TriggerWatchService } from './services/trigger-watch.service';
import { SentinelExitTriggerRepository } from './repositories/sentinel-exit-trigger.repository';

/** The module's real imports (Prisma, MarketData, CredentialDecryptor), faked. */
const prisma = { $queryRaw: jest.fn(), aiExitExecution: { updateMany: jest.fn(), create: jest.fn() } };
const userFeeds = { warmRestClient: jest.fn(), hasSession: jest.fn() };
const decryptor = { withDecryptedCredentials: jest.fn() };

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: UserFeedManager, useValue: userFeeds },
    { provide: CREDENTIAL_DECRYPTOR, useValue: decryptor },
    { provide: ConfigService, useValue: { get: () => '' } },
  ],
  exports: [PrismaService, UserFeedManager, CREDENTIAL_DECRYPTOR, ConfigService],
})
class FakeDepsModule {}

describe('SentinelExecutorModule wiring', () => {
  afterEach(() => { delete process.env.AI_AUTO_EXIT_ENABLED; delete process.env.AI_AUTO_EXIT_USER_IDS; });

  it('resolves every provider from its declared imports, and boots inert by default', async () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SentinelExecutorModule);
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SentinelExecutorModule);
    const ref = await Test.createTestingModule({
      imports: [FakeDepsModule],
      providers,
      controllers,
    }).compile();
    const app = ref.createNestApplication();
    await app.init();
    expect(ref.get(SentinelExitExecutor)).toBeInstanceOf(SentinelExitExecutor);
    expect(ref.get(SentinelExitPoller)).toBeInstanceOf(SentinelExitPoller);
    expect(ref.get(ManualExitService)).toBeInstanceOf(ManualExitService);
    expect(ref.get(ExitFillSettler)).toBeInstanceOf(ExitFillSettler);
    expect(ref.get(ExitOutcomeService)).toBeInstanceOf(ExitOutcomeService);
    expect(ref.get(AiExitOutcomeRepository)).toBeInstanceOf(AiExitOutcomeRepository);
    expect(ref.get(AI_EXIT_SESSION_CLOCK)).toBeInstanceOf(SessionClock);
    // Exit discipline: the gate, its reads and its config are providers.
    expect(ref.get(ExitGateService)).toBeInstanceOf(ExitGateService);
    expect(ref.get(ExitGateRepository)).toBeInstanceOf(ExitGateRepository);
    expect(ref.get(EXIT_DISCIPLINE_CONFIG)).toEqual(expect.objectContaining({ enabled: true, floorArmN: 1.5, outcomeWindowMin: 60 }));
    // Price triggers: registered, and inert (flag unset) — no timer, no hub lookup, no query.
    expect(ref.get(TriggerWatchService)).toBeInstanceOf(TriggerWatchService);
    expect(ref.get(SentinelExitTriggerRepository)).toBeInstanceOf(SentinelExitTriggerRepository);
    // Disabled by default: not one query, not one broker touch.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.aiExitExecution.updateMany).not.toHaveBeenCalled();
    expect(userFeeds.warmRestClient).not.toHaveBeenCalled();
    expect(decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
    await app.close();
  });

  it('SENTINEL_TRIGGERS_ENABLED=true with the auto-exit off still boots inert (no timer, no query)', async () => {
    process.env.SENTINEL_TRIGGERS_ENABLED = 'true';
    const interval = jest.spyOn(global, 'setInterval');
    try {
      const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SentinelExecutorModule);
      const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SentinelExecutorModule);
      const ref = await Test.createTestingModule({ imports: [FakeDepsModule], providers, controllers }).compile();
      const app = ref.createNestApplication();
      await app.init();
      expect(interval).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      await app.close();
    } finally {
      interval.mockRestore();
      delete process.env.SENTINEL_TRIGGERS_ENABLED;
    }
  });

  it('declares exactly the three imports the plan names (no trade-sentinel, no auto-execution module)', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, SentinelExecutorModule) as Array<{ name: string }>)
      .map((m) => m.name)
      .sort();
    expect(imports).toEqual(['CredentialDecryptorModule', 'MarketDataModule', 'PrismaModule']);
  });
});
