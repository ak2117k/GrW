import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AiGatewayModule } from '../ai-gateway/ai-gateway.module';
import { AiSetupsModule } from '../ai-setups/ai-setups.module';
import { SETUP_WATCH_MARKET } from '../ai-setups/services/setup-watch.service';
import { EntryEngineModule } from '../entry-engine/entry-engine.module';
import { ExitAuthorityModule } from '../exit-authority/exit-authority.module';
import { SUPREME_CONFIRM } from '../exit-authority/exit-authority.tokens';
import { SentinelExecutorModule } from '../sentinel-executor/sentinel-executor.module';
import { SignalTraderModule } from '../signal-trader/signal-trader.module';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { DeskMarketAdapter } from './adapters/desk-market.adapter';
import { DeskManagerController } from './controllers/desk-manager.controller';
import { DESK_MANAGER_CONFIG, type DeskManagerConfig } from './desk-manager.config';
import { DeskGuardModule } from './desk-guard.module';
import { DESK_ACTIONS, DESK_WAKE } from './domain/desk.types';
import { DeskActionsRepository } from './repositories/desk-actions.repository';
import { DeskManagerRepository } from './repositories/desk-manager.repository';
import { DeskStateRepository } from './repositories/desk-state.repository';
import { DESK_EXIT_ACTIONS, DESK_MARKET as DESK_ACTIONS_MARKET, DESK_OPEN_GUARD, DESK_RUNNER_HEALTH } from './services/desk-actions.ports';
import { DeskActionsService } from './services/desk-actions.service';
import { DeskExitActions } from './services/desk-exit-actions.service';
import { DESK_GRADE_MARKET, DeskGradeCron } from './services/desk-grade.cron';
import { DeskGuardService } from './services/desk-guard.service';
import { DESK_MARKET as DESK_STATE_MARKET, DESK_STATE_GUARD, DESK_STATUS, DeskStateService } from './services/desk-state.service';
import { DeskStatusAdapter } from './adapters/desk-status.adapter';
import { DeskWakeListener } from './services/desk-wake.listener';
import { ManagerLlmService } from './services/manager-llm.service';
import { DESK_PACKET_BUILDER, ManagerRunnerService, type DeskPacketBuilder } from './services/manager-runner.service';
import { PendingEntryWatchService } from './services/pending-entry-watch.service';
import { SupremeConfirmService } from './services/supreme-confirm.service';
import { DESK_WAKE as TARGET_WATCH_WAKE, TargetWatchService } from './services/target-watch.service';

/**
 * Desk manager (docs/superpowers/specs/2026-11-26-desk-manager-design.md): one AI that sees the whole desk and
 * decides, acting only through the existing executors. DESK_MANAGER=off (default) starts no loop; the guard on
 * the live order path is null while off (DeskGuardModule), so importing this module changes nothing until the
 * owner switches it on.
 */
@Module({
  imports: [
    PrismaModule,
    DeskGuardModule,
    AiGatewayModule,
    AiSetupsModule,
    EntryEngineModule,
    SentinelExecutorModule,
    SignalTraderModule,
    TradeEngineModule,
    TradeSentinelModule,
    // Trade agent exit authority (2026-11-27): TRADE_ALARMS / TRADE_BRIEFS / AUTHORITY_STATE for DeskExitActions,
    // TargetWatchService, DeskActionsService, PendingEntryWatchService, DeskStateService and ManagerLlmService.
    // SUPREME_CONFIRM stays this module's own binding below (a local provider wins over the imported forwarder).
    ExitAuthorityModule,
  ],
  controllers: [DeskManagerController],
  providers: [
    // The desk packet (Task 3) and its market reads.
    DeskStateRepository,
    DeskStateService,
    DeskMarketAdapter,
    { provide: DESK_STATE_MARKET, useExisting: DeskMarketAdapter },
    { provide: DESK_STATE_GUARD, useExisting: DeskGuardService },
    // The health block's feed + agent status (audit 2026-11-27: was "unknown (status port not wired)" / {}).
    { provide: DESK_STATUS, useFactory: (ref: ModuleRef) => DeskStatusAdapter.fromModuleRef(ref), inject: [ModuleRef] },
    // The manager (Task 4).
    DeskManagerRepository,
    ManagerLlmService,
    ManagerRunnerService,
    {
      provide: DESK_PACKET_BUILDER,
      useFactory: (state: DeskStateService, repo: DeskStateRepository): DeskPacketBuilder => ({
        build: (userId: string, now: Date, cfg: DeskManagerConfig) => state.build(userId, now, cfg),
        busy: (userId: string, now: Date) => repo.busy(userId, now),
      }),
      inject: [DeskStateService, DeskStateRepository],
    },
    { provide: DESK_WAKE, useExisting: ManagerRunnerService },
    { provide: TARGET_WATCH_WAKE, useExisting: ManagerRunnerService },
    { provide: DESK_RUNNER_HEALTH, useExisting: ManagerRunnerService },
    DeskWakeListener,
    // Acting (Tasks 5 + 7).
    DeskActionsRepository,
    DeskActionsService,
    { provide: DESK_ACTIONS, useExisting: DeskActionsService },
    { provide: DESK_ACTIONS_MARKET, useExisting: SETUP_WATCH_MARKET },
    { provide: DESK_OPEN_GUARD, useExisting: DeskGuardService },
    DeskExitActions,
    { provide: DESK_EXIT_ACTIONS, useExisting: DeskExitActions },
    PendingEntryWatchService,
    TargetWatchService,
    // Trade agent exit authority (2026-11-27): the supreme confirm call.
    SupremeConfirmService,
    { provide: SUPREME_CONFIRM, useExisting: SupremeConfirmService },
    // Learning (Task 6).
    { provide: DESK_GRADE_MARKET, useExisting: SETUP_WATCH_MARKET },
    DeskGradeCron,
  ],
  exports: [DeskGuardModule, ManagerRunnerService, SUPREME_CONFIRM],
})
export class DeskManagerModule {}
