import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { CredentialDecryptorModule } from '../credential-vault/execution/credential-decryptor.module';
import { PerUserBrokerSessionFactory } from '../auto-execution/services/per-user-broker-session.factory';
import { TradeTrackerService } from './services/trade-tracker.service';
import { TradeTrackerPoller } from './services/trade-tracker-poller.service';
import { TradeTrackerController } from './controllers/trade-tracker.controller';
import { SoldTradesController } from './controllers/sold-trades.controller';

/**
 * Per-trade tracker (design feature 1). Maintains a persistent `trade_trackers`
 * row per real Angel One position/holding with entry/exit, holding-period +
 * day high/low, latest LTP and P&L, filled from periodic broker snapshots and
 * live socket ticks.
 *
 * - MarketDataModule supplies {@link MarketFeedService} (subscribe + getQuote)
 *   AND {@link UserFeedManager}, whose batched `fetchQuotes` prices open
 *   trackers over the OWNING user's Angel session. The socket pool has 30 slots
 *   and ~50 open tokens, so it can only ever be the fast path — the batched
 *   call is what guarantees every open trade gets a price at all.
 * - CredentialDecryptorModule supplies the isolated CREDENTIAL_DECRYPTOR lease.
 * - PerUserBrokerSessionFactory is provided locally (it has only an @Optional
 *   USER_SMARTAPI_FACTORY dep), mirroring CredentialVaultModule — this keeps the
 *   module free of a runtime dependency on AutoExecutionModule.
 */
@Module({
  imports: [PrismaModule, MarketDataModule, CredentialDecryptorModule],
  controllers: [TradeTrackerController, SoldTradesController],
  providers: [TradeTrackerService, TradeTrackerPoller, PerUserBrokerSessionFactory],
  exports: [TradeTrackerService],
})
export class TradeTrackerModule {}
