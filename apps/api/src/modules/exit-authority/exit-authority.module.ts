import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AI_HEALTH } from '../ai-gateway/audit/failover-transport';
import { AUTHORITY_STATE, OWNER_ESCALATION, SUPREME_CONFIRM, TRACKER_WAKE, TRADE_ALARMS, TRADE_BRIEFS } from './exit-authority.tokens';
import { lateAiHealth, lateHardLossProbe, lateOwnerExit, lateSupremeConfirm, lateTrackerWake } from './late-ports';
import { EscalationRepository } from './repositories/escalation.repository';
import { TradeAlarmRepository } from './repositories/trade-alarm.repository';
import { TradeBriefRepository } from './repositories/trade-brief.repository';
import { AuthorityStateService } from './services/authority-state.service';
import { EscalationRunner, HARD_LOSS_PROBE, OWNER_EXIT } from './services/escalation-runner.service';
import { TradeAlarmsService } from './services/trade-alarms.service';
import { ExitAuthorityWiringCheck } from './services/wiring-check.service';
import { OwnerButtonsService } from './telegram/owner-buttons.service';
import { TelegramBotClient } from './telegram/telegram-bot.client';
import { TrackerMessages } from './telegram/tracker-messages';

/**
 * Trade agent exit authority (docs/superpowers/specs/2026-11-27-trade-agent-exit-authority-design.md).
 * Leaf module: it imports nothing from the trading modules; they consume its ports with @Optional() @Inject().
 * TRADE_AGENT_AUTHORITY=off (default) → AUTHORITY_STATE is not live and raise() writes nothing.
 *
 * AUTHORITY_STATE is provided HERE (not only exported) so TradeAlarmsService resolves it in this injector.
 *
 * Wiring (Task 7). Consumers (TradeSentinel, SentinelExecutor, DeskManager, IntradayCarry, TradeEngine) import this
 * module for TRADE_ALARMS / TRADE_BRIEFS / AUTHORITY_STATE / OWNER_ESCALATION / SUPREME_CONFIRM. The ports this module
 * itself CONSUMES but other modules implement (TRACKER_WAKE, SUPREME_CONFIRM, HARD_LOSS_PROBE, OWNER_EXIT, AI_HEALTH)
 * are late-bound forwarders (late-ports.ts): the implementing module binds the same token and the forwarder finds it
 * on first use, so there is no module or instance cycle. ExitAuthorityWiringCheck logs ERROR at boot for any that is
 * unbound while live is requested. Only grw-api runs Nest (the grw-agents-* containers serve LLM calls only), so
 * every port and every consumer live in one injector.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    TradeAlarmRepository,
    TradeAlarmsService,
    { provide: TRADE_ALARMS, useExisting: TradeAlarmsService },
    TradeBriefRepository,
    { provide: TRADE_BRIEFS, useExisting: TradeBriefRepository },
    TelegramBotClient,
    TrackerMessages,
    AuthorityStateService,
    { provide: AUTHORITY_STATE, useExisting: AuthorityStateService },
    EscalationRepository,
    EscalationRunner,
    OwnerButtonsService,
    { provide: OWNER_ESCALATION, useExisting: OwnerButtonsService },
    // Late-bound ports (late-ports.ts): implemented by modules that import this one.
    { provide: TRACKER_WAKE, useFactory: lateTrackerWake, inject: [ModuleRef] },
    { provide: SUPREME_CONFIRM, useFactory: lateSupremeConfirm, inject: [ModuleRef] },
    { provide: HARD_LOSS_PROBE, useFactory: lateHardLossProbe, inject: [ModuleRef] },
    { provide: OWNER_EXIT, useFactory: lateOwnerExit, inject: [ModuleRef] },
    { provide: AI_HEALTH, useFactory: lateAiHealth, inject: [ModuleRef] },
    ExitAuthorityWiringCheck,
  ],
  // SUPREME_CONFIRM: for the executor's router (SentinelExecutorModule cannot import DeskManagerModule, which imports it).
  exports: [TRADE_ALARMS, TRADE_BRIEFS, TradeAlarmRepository, AUTHORITY_STATE, OWNER_ESCALATION, SUPREME_CONFIRM],
})
export class ExitAuthorityModule {}
