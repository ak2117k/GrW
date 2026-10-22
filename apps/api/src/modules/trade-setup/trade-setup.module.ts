import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CredentialVaultModule } from '../credential-vault/credential-vault.module';
import { BrokerOverviewService } from '../credential-vault/services/broker-overview.service';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketDataRepository } from '../market-data/repositories/market-data.repository';
import { AngelOneAdapterService } from '../market-data/services/angel-one-adapter.service';
import { UserFeedManager } from '../market-data/services/user-feed-manager.service';
import { MbmModule } from '../mbm/mbm.module';
import { MBM_CONFIG, type MbmConfig } from '../mbm/mbm.config';
import { ScorecardBarBackfill } from '../overnight-scorecard/scorecard-bar-backfill';
import { parseScorecardConfig } from '../overnight-scorecard/scorecard.config';
import { ScorecardRepository } from '../overnight-scorecard/scorecard.repository';
import { makeSentinelClock } from '../trade-sentinel/overnight/overnight-calendar';
import { makeFuturesSource } from './adapters/futures-source';
import { TradeSetupRepository } from './repositories/trade-setup.repository';
import { TradeSetupCron } from './services/trade-setup.cron';
import {
  parseTradeSetupConfig,
  TRADE_SETUP_BACKFILL,
  TRADE_SETUP_CLOCK,
  TRADE_SETUP_CONFIG,
  TRADE_SETUP_FUTURES,
  TRADE_SETUP_MARGIN,
  TRADE_SETUP_REPO,
  TRADE_SETUPS_REPORT,
  TradeSetupService,
  type MarginReader,
  type TradeSetupConfig,
} from './services/trade-setup.service';

/**
 * Next-morning trade setups (news idea + big-move model → a concrete futures / intraday-cash plan).
 * ADVISORY ONLY: writes `trade_setups` and `account_margin_snapshots`, nothing else — no order, no
 * paper trade, no auto-trade, no risk-limit change. TRADE_SETUPS_ENABLED=off disables every job.
 * Imported by the night report (which shows the section); crons in {@link TradeSetupCron}.
 */
@Module({
  imports: [PrismaModule, MarketDataModule, MbmModule, CredentialVaultModule],
  providers: [
    ScorecardRepository,
    TradeSetupRepository,
    { provide: TRADE_SETUP_REPO, useExisting: TradeSetupRepository },
    {
      provide: TRADE_SETUP_CONFIG,
      useFactory: (): TradeSetupConfig => parseTradeSetupConfig(process.env, parseScorecardConfig(process.env).ownerUserId),
    },
    { provide: TRADE_SETUP_CLOCK, useFactory: () => makeSentinelClock(process.env.HUB_MCX_LATE_CLOSE) },
    {
      provide: TRADE_SETUP_FUTURES,
      useFactory: (adapter: AngelOneAdapterService, repo: TradeSetupRepository) =>
        makeFuturesSource(adapter, (name) => repo.futuresFromTable(name, new Date(Date.now() - 86_400_000))),
      inject: [AngelOneAdapterService, TradeSetupRepository],
    },
    {
      // The owner's Angel RMS funds, the same sanitized read GET /api/broker/overview serves.
      provide: TRADE_SETUP_MARGIN,
      useFactory: (overview: BrokerOverviewService): MarginReader => ({
        live: async (userId) => {
          const o = await overview.getOverview(userId);
          return { availableCash: o.funds.availableCash, net: o.funds.net };
        },
      }),
      inject: [BrokerOverviewService],
    },
    {
      // Short `candles` history fetched over the owner's own Angel session, as the scorecard does.
      provide: TRADE_SETUP_BACKFILL,
      useFactory: (repo: ScorecardRepository, feeds: UserFeedManager, candles: MarketDataRepository, mbm: MbmConfig, cfg: TradeSetupConfig) =>
        new ScorecardBarBackfill(repo, feeds, candles, mbm.feedUserId ?? cfg.ownerUserId),
      inject: [ScorecardRepository, UserFeedManager, MarketDataRepository, MBM_CONFIG, TRADE_SETUP_CONFIG],
    },
    TradeSetupService,
    { provide: TRADE_SETUPS_REPORT, useExisting: TradeSetupService },
    TradeSetupCron,
  ],
  exports: [TradeSetupService, TRADE_SETUPS_REPORT],
})
export class TradeSetupModule {}
