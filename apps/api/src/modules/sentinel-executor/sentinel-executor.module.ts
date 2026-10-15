// apps/api/src/modules/sentinel-executor/sentinel-executor.module.ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { CredentialDecryptorModule } from '../credential-vault/execution/credential-decryptor.module';
import { PerUserBrokerSessionFactory } from '../auto-execution/services/per-user-broker-session.factory';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { SessionClock, parseLateClose } from '../market-hub/session-clock';
import { AiExitExecutionRepository } from './repositories/ai-exit-execution.repository';
import { OwnerBrokerSessionProvider } from './services/owner-broker-session.provider';
import {
  AI_EXIT_SESSION_CLOCK,
  AI_EXIT_SLEEP,
  SentinelExitExecutor,
} from './services/sentinel-exit-executor.service';
import { SentinelExitPoller } from './services/sentinel-exit-poller.service';
import { ExitFillSettler } from './services/exit-fill-settler.service';
import { EXIT_OUTCOME_CANDLES, EXIT_OUTCOME_USERS, ExitOutcomeService } from './services/exit-outcome.service';
import { AiExitOutcomeRepository } from './repositories/ai-exit-outcome.repository';
import { parseAutoExitConfig } from './domain/auto-exit.config';
import { EXIT_DISCIPLINE_CONFIG, parseExitDisciplineConfig } from '../exit-discipline/config';
import { PrismaCandleRepo } from '../market-hub/candles/candle-repository';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ManualExitService } from './services/manual-exit.service';
import { SentinelExitTriggerRepository } from './repositories/sentinel-exit-trigger.repository';
import { TriggerWatchService } from './services/trigger-watch.service';
import { SentinelExecutorController } from './controllers/sentinel-executor.controller';
import { ExitGateRepository } from './repositories/exit-gate.repository';
import { ExitGateService } from './services/exit-gate.service';

/**
 * Sentinel auto-exit (docs/superpowers/specs/2026-10-12-sentinel-auto-exit-design.md).
 * Separate from TradeSentinelModule by design: the two meet only in the database.
 * PerUserBrokerSessionFactory is provided locally (as TradeTrackerModule does) so
 * this module has no runtime dependency on AutoExecutionModule.
 */
@Module({
  imports: [PrismaModule, MarketDataModule, CredentialDecryptorModule],
  controllers: [SentinelExecutorController],
  providers: [
    AiExitExecutionRepository,
    OwnerBrokerSessionProvider,
    SentinelExitExecutor,
    SentinelExitPoller,
    ExitFillSettler,
    AiExitOutcomeRepository,
    ExitOutcomeService,
    SentinelExitTriggerRepository,
    // Price triggers (docs/superpowers/plans/2026-10-13-sentinel-price-triggers.md).
    // Inert unless SENTINEL_TRIGGERS_ENABLED=true and the AI auto-exit is on.
    TriggerWatchService,
    ManualExitService,
    PerUserBrokerSessionFactory,
    {
      // Ruling R12: the hub's own inputs, so MCX's late-close window is honoured.
      provide: AI_EXIT_SESSION_CLOCK,
      useFactory: (config: ConfigService) =>
        new SessionClock({
          holidays: MARKET_HOLIDAYS,
          mcxLateClose: parseLateClose(config.get<string>('hub.mcxLateClose')),
        }),
      inject: [ConfigService],
    },
    { provide: AI_EXIT_SLEEP, useValue: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) },
    // Exit discipline (docs/superpowers/specs/2026-10-14-exit-discipline-design.md): the AI exit gate.
    ExitGateRepository,
    ExitGateService,
    { provide: EXIT_DISCIPLINE_CONFIG, useFactory: () => parseExitDisciplineConfig(process.env) },
    // Outcome scoring reads hub tick bars from candles_1m (no broker call).
    { provide: EXIT_OUTCOME_CANDLES, useFactory: (prisma: PrismaService) => new PrismaCandleRepo(prisma as never), inject: [PrismaService] },
    { provide: EXIT_OUTCOME_USERS, useFactory: () => parseAutoExitConfig(process.env).userIds },
  ],
})
export class SentinelExecutorModule {}
