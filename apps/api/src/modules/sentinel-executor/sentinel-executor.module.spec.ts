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
import { ExitFillSettler } from './services/exit-fill-settler.service';
import { ExitOutcomeService } from './services/exit-outcome.service';
import { AiExitOutcomeRepository } from './repositories/ai-exit-outcome.repository';
import { EXIT_DISCIPLINE_CONFIG } from '../exit-discipline/config';

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
    expect(ref.get(EXIT_DISCIPLINE_CONFIG)).toEqual(expect.objectContaining({ enabled: true, outcomeWindowMin: 60 }));
    expect(ref.get(AI_EXIT_SESSION_CLOCK)).toBeInstanceOf(SessionClock);
    // Disabled by default: not one query, not one broker touch.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.aiExitExecution.updateMany).not.toHaveBeenCalled();
    expect(userFeeds.warmRestClient).not.toHaveBeenCalled();
    expect(decryptor.withDecryptedCredentials).not.toHaveBeenCalled();
    await app.close();
  });

  it('declares exactly the three imports the plan names (no trade-sentinel, no auto-execution module)', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, SentinelExecutorModule) as Array<{ name: string }>)
      .map((m) => m.name)
      .sort();
    expect(imports).toEqual(['CredentialDecryptorModule', 'MarketDataModule', 'PrismaModule']);
  });
});
