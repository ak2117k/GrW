import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { TRADE_ALARMS, TRADE_BRIEFS } from './exit-authority.tokens';
import { TradeAlarmRepository } from './repositories/trade-alarm.repository';
import { TradeBriefRepository } from './repositories/trade-brief.repository';
import { TradeAlarmsService } from './services/trade-alarms.service';

/**
 * Trade agent exit authority (docs/superpowers/specs/2026-11-27-trade-agent-exit-authority-design.md).
 * Leaf module: it imports nothing from the trading modules; they consume its ports with @Optional() @Inject().
 * TRADE_AGENT_AUTHORITY=off (default) → AUTHORITY_STATE is not live and raise() writes nothing.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    TradeAlarmRepository,
    TradeAlarmsService,
    { provide: TRADE_ALARMS, useExisting: TradeAlarmsService },
    TradeBriefRepository,
    { provide: TRADE_BRIEFS, useExisting: TradeBriefRepository },
  ],
  exports: [TRADE_ALARMS, TRADE_BRIEFS, TradeAlarmRepository],
})
export class ExitAuthorityModule {}
