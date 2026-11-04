import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MarketDataModule } from '../market-data/market-data.module';
import { MARKET_HOLIDAYS } from '../market-data/services/market-holidays.service';
import { CredentialDecryptorModule } from '../credential-vault/execution/credential-decryptor.module';
import { PerUserBrokerSessionFactory } from '../auto-execution/services/per-user-broker-session.factory';
import { SessionClock, parseLateClose } from '../market-hub/session-clock';
import { PrismaCandleRepo } from '../market-hub/candles/candle-repository';
import { OwnerBrokerSessionProvider } from '../sentinel-executor/services/owner-broker-session.provider';
import { AiExitExecutionRepository } from '../sentinel-executor/repositories/ai-exit-execution.repository';
import { SentinelVerdictRepository } from '../trade-sentinel/repositories/sentinel-verdict.repository';
import { TradeSentinelModule } from '../trade-sentinel/trade-sentinel.module';
import { CARRY_SESSION_CLOCK, IntradayCarryService } from './intraday-carry.service';
import { CARRY_SCORE_CANDLES, IntradayCarryScoreService } from './intraday-carry-score.service';
import { IntradayCarryRepository } from './repositories/intraday-carry.repository';

/**
 * Intraday carry (spec docs/superpowers/specs/2026-11-04-intraday-carry-and-thesis-guard-design.md):
 * the close-time CARRY / EXIT decision for intraday (MIS) F&O positions, the broker conversion and
 * its next-session scoring. Broker-capable (Angel convertPosition over the owner's warm session),
 * so — like the exit executor — it meets the sentinel cycle only through the database (verdict rows)
 * and the CloseProductBook, a broker-free in-memory cache TradeSentinelModule provides and exports.
 *
 * Inert unless INTRADAY_CARRY=live (the default) AND BOOT_JOBS on; LIVE conversions/exits only for
 * INTRADAY_CARRY_USERS (default empty). Rollback: INTRADAY_CARRY=off.
 */
@Module({
  imports: [PrismaModule, MarketDataModule, CredentialDecryptorModule, TradeSentinelModule],
  providers: [
    IntradayCarryRepository,
    IntradayCarryService,
    IntradayCarryScoreService,
    OwnerBrokerSessionProvider,
    PerUserBrokerSessionFactory,
    AiExitExecutionRepository,
    SentinelVerdictRepository,
    {
      provide: CARRY_SESSION_CLOCK,
      useFactory: (config: ConfigService) =>
        new SessionClock({ holidays: MARKET_HOLIDAYS, mcxLateClose: parseLateClose(config.get<string>('hub.mcxLateClose')) }),
      inject: [ConfigService],
    },
    { provide: CARRY_SCORE_CANDLES, useFactory: (prisma: PrismaService) => new PrismaCandleRepo(prisma as never), inject: [PrismaService] },
  ],
  exports: [IntradayCarryRepository],
})
export class IntradayCarryModule {}
