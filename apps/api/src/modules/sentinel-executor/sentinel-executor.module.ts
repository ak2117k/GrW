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
import { ExitAuthorityRouter } from './services/exit-authority-router.service';
import { ExitFillSettler } from './services/exit-fill-settler.service';
import { ExitUncertainResolver } from './services/exit-uncertain-resolver.service';
import { EXIT_OUTCOME_CANDLES, EXIT_OUTCOME_USERS, ExitOutcomeService } from './services/exit-outcome.service';
import { AiExitOutcomeRepository } from './repositories/ai-exit-outcome.repository';
import { parseAutoExitConfig } from './domain/auto-exit.config';
import { EXIT_DISCIPLINE_CONFIG, parseExitDisciplineConfig, withSessionExitTuning, type ExitTuningReader } from '../exit-discipline/config';
import { SESSION_TUNING } from '../self-review/tuning/tunables';
import { PrismaCandleRepo } from '../market-hub/candles/candle-repository';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ManualExitService } from './services/manual-exit.service';
import { SentinelExitTriggerRepository } from './repositories/sentinel-exit-trigger.repository';
import { TriggerWatchService } from './services/trigger-watch.service';
import { SentinelExecutorController } from './controllers/sentinel-executor.controller';
import { ExitGateRepository } from './repositories/exit-gate.repository';
import { ExitGateService } from './services/exit-gate.service';
import { MbmModule } from '../mbm/mbm.module';
import { FloorBrokerSlRepository } from './repositories/floor-broker-sl.repository';
import { FLOOR_SL_CANDLES, FloorBrokerSlService } from './services/floor-broker-sl.service';
import { N15Reader, TRIGGER_N15_READER } from './repositories/n15.reader';
import { CHART_CONFIRM_READER, ChartConfirmReader } from './repositories/chart-confirm.reader';
import { ExitNoiseRepository } from '../exit-noise/exit-noise.repository';
import { ExitAuthorityModule } from '../exit-authority/exit-authority.module';
import { OWNER_EXIT } from '../exit-authority/services/escalation-runner.service';
import { EXIT_EXECUTION_READER } from '../exit-authority/exit-authority.tokens';
import { ManualOwnerExit } from './services/owner-exit.adapter';
import { ExecutorAuthorityBootCheck } from './services/authority-boot-check.service';

/**
 * Sentinel auto-exit (docs/superpowers/specs/2026-10-12-sentinel-auto-exit-design.md).
 * Separate from TradeSentinelModule by design: the two meet only in the database.
 * PerUserBrokerSessionFactory is provided locally (as TradeTrackerModule does) so
 * this module has no runtime dependency on AutoExecutionModule.
 */
@Module({
  // MbmModule: MBM_EXIT_SHADOW's fail-open, cached client (inert while the flags are off).
  // ExitAuthorityModule (2026-11-27): AUTHORITY_STATE / TRADE_ALARMS / TRADE_BRIEFS / OWNER_ESCALATION and the
  // late-bound SUPREME_CONFIRM for the router, poller, trigger-watch and executor. Inert while TRADE_AGENT_AUTHORITY=off.
  imports: [PrismaModule, MarketDataModule, CredentialDecryptorModule, MbmModule, ExitAuthorityModule],
  controllers: [SentinelExecutorController],
  providers: [
    AiExitExecutionRepository,
    // EXIT_EXECUTION_READER (read-only port): the escalation runner's view of one verdict's execution row, so no file
    // outside this module reads the executions table. ExitAuthorityModule's late-bound forwarder finds it.
    { provide: EXIT_EXECUTION_READER, useExisting: AiExitExecutionRepository },
    OwnerBrokerSessionProvider,
    SentinelExitExecutor,
    SentinelExitPoller,
    // Trade agent exit authority: inert unless AUTHORITY_STATE is live (ExitAuthorityModule, imported above).
    ExitAuthorityRouter,
    // OWNER_EXIT for the authority's backstops, supreme exits and the owner's Telegram Exit: ManualExitService as
    // the owner (backstops honour AI_AUTO_EXIT_USER_IDS). ExitAuthorityModule's late-bound forwarder finds it.
    { provide: OWNER_EXIT, useFactory: (manual: ManualExitService) => new ManualOwnerExit(manual), inject: [ManualExitService] },
    // Boot ERROR when live is requested and a port is unbound here, or FLOOR_BROKER_SL=live (forced to shadow).
    ExecutorAuthorityBootCheck,
    ExitFillSettler,
    ExitUncertainResolver,
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
    // 2026-11-05: floor arm/trail + spike-bank N may be self-review overrides, fixed per session (SESSION_TUNING).
    {
      provide: EXIT_DISCIPLINE_CONFIG,
      useFactory: (tuning?: ExitTuningReader) => withSessionExitTuning(parseExitDisciplineConfig(process.env), tuning),
      inject: [{ token: SESSION_TUNING, optional: true }],
    },
    // Outcome scoring reads hub tick bars from candles_1m (no broker call).
    { provide: EXIT_OUTCOME_CANDLES, useFactory: (prisma: PrismaService) => new PrismaCandleRepo(prisma as never), inject: [PrismaService] },
    { provide: EXIT_OUTCOME_USERS, useFactory: () => parseAutoExitConfig(process.env).userIds },
    // FLOOR_BROKER_SL (2026-11-06): resting stop at the armed noise floor. Default shadow (records only).
    FloorBrokerSlRepository,
    FloorBrokerSlService,
    { provide: FLOOR_SL_CANDLES, useFactory: (prisma: PrismaService) => new PrismaCandleRepo(prisma as never), inject: [PrismaService] },
    // CUT_LOSS yardstick (2026-11-11), RECORD ONLY on real triggers: the underlying's 15-minute N from candles_1m.
    { provide: TRIGGER_N15_READER, useFactory: (prisma: PrismaService) => new N15Reader(new PrismaCandleRepo(prisma as never)), inject: [PrismaService] },
    // Loss-side chart confirmation (EXIT_CHART_CONFIRM, exit-discipline/chart-read.ts): database reads only.
    {
      provide: CHART_CONFIRM_READER,
      useFactory: (prisma: PrismaService) => new ChartConfirmReader(new PrismaCandleRepo(prisma as never), new ExitNoiseRepository(prisma)),
      inject: [PrismaService],
    },
  ],
  // The desk manager EXIT / BOOK go through the owner manual-exit path (desk-manager plan Task 7).
  exports: [ManualExitService, EXIT_EXECUTION_READER],
})
export class SentinelExecutorModule {}
