import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AUTHORITY_STATE, OWNER_ESCALATION, TRADE_ALARMS, TRADE_BRIEFS } from './exit-authority.tokens';
import { EscalationRepository } from './repositories/escalation.repository';
import { TradeAlarmRepository } from './repositories/trade-alarm.repository';
import { TradeBriefRepository } from './repositories/trade-brief.repository';
import { AuthorityStateService } from './services/authority-state.service';
import { EscalationRunner } from './services/escalation-runner.service';
import { TradeAlarmsService } from './services/trade-alarms.service';
import { OwnerButtonsService } from './telegram/owner-buttons.service';
import { TelegramBotClient } from './telegram/telegram-bot.client';

/**
 * Trade agent exit authority (docs/superpowers/specs/2026-11-27-trade-agent-exit-authority-design.md).
 * Leaf module: it imports nothing from the trading modules; they consume its ports with @Optional() @Inject().
 * TRADE_AGENT_AUTHORITY=off (default) → AUTHORITY_STATE is not live and raise() writes nothing.
 *
 * AUTHORITY_STATE is provided HERE (not only exported) so TradeAlarmsService resolves it in this injector.
 * OWNER_EXIT / HARD_LOSS_PROBE / AI_HEALTH / SUPREME_CONFIRM / TRACKER_WAKE are optional ports bound by Task 7.
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
    AuthorityStateService,
    { provide: AUTHORITY_STATE, useExisting: AuthorityStateService },
    EscalationRepository,
    EscalationRunner,
    OwnerButtonsService,
    { provide: OWNER_ESCALATION, useExisting: OwnerButtonsService },
  ],
  exports: [TRADE_ALARMS, TRADE_BRIEFS, TradeAlarmRepository, AUTHORITY_STATE, OWNER_ESCALATION],
})
export class ExitAuthorityModule {}
