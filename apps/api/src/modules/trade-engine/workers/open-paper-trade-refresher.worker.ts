import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TradeRepository } from '../repositories/trade.repository';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';

const UNDERLYING_TOKEN: Record<string, string> = {
  NIFTY: '99926000',
  BANKNIFTY: '99926009',
  FINNIFTY: '99926037',
};

/**
 * Refreshes unrealized P&L on open paper option trades.
 *
 * Why this exists: PaperTradeService updates positions via simulateTick(),
 * but the synthetic option contracts used by the universe scanner are NOT
 * subscribed to Angel One's WebSocket — no real ticks ever flow into the
 * paper service's LTP cache for them. As a result, an open NIFTY/BANKNIFTY
 * paper option position would sit at pnl=0 from entry until close, with
 * no live visibility.
 *
 * The fix: every 30 s, find open paper trades on options, look up the
 * strike's current LTP from the options chain (which IS being kept fresh),
 * compute (currentLtp - entryPrice) × quantity, and write it back to the
 * trade row. The Journal page and Auto-Trade page render unrealized P&L
 * by reading the trade row's `pnl` field, so this gives the user live
 * visibility without changing the persistence model.
 *
 * Limitations:
 * - 30 s lag (acceptable for a 15 m bar strategy)
 * - Polls only options (segment === 'OPTIONS') — equity paper trades are
 *   left to PaperTradeService's tick stream
 * - Skips when the chain has no LTP for the strike (e.g. the chain just
 *   refreshed and the row hasn't loaded) — keeps the previous value
 */
@Injectable()
export class OpenPaperTradeRefresherWorker {
  private readonly logger = new Logger(OpenPaperTradeRefresherWorker.name);

  constructor(
    private readonly tradeRepository: TradeRepository,
    private readonly optionsChainService: OptionsChainService,
    private readonly marketFeed: MarketFeedService,
  ) {}

  @Cron('*/30 * * * * *', { timeZone: 'Asia/Kolkata' })
  async refreshLoop(): Promise<void> {
    try {
      const openTrades = await this.tradeRepository.getOpenTrades();
      const paperOptionTrades = openTrades.filter(
        (t) =>
          t.isPaperTrade &&
          // Only fully-OPEN trades: a PARTIALLY_FILLED trade's `pnl` is the
          // REALIZED P&L booked by the partial close — overwriting it with a
          // mark-to-market figure would erase that realized profit.
          t.status === 'OPEN' &&
          (t as any).instrument?.segment === 'OPTIONS' &&
          (t as any).instrument?.expiry &&
          (t as any).instrument?.strike != null &&
          (t as any).instrument?.optionType,
      );

      if (paperOptionTrades.length === 0) return;

      this.logger.debug(`Refreshing ${paperOptionTrades.length} open paper option trades`);

      // Group by (underlying, expiry) so we only fetch each chain once per tick.
      const chainCache = new Map<string, Awaited<ReturnType<typeof this.optionsChainService.getOptionsChainWithSpot>>>();

      for (const trade of paperOptionTrades) {
        const inst = (trade as any).instrument;
        const underlying: string = inst.name;
        const expiryIso: string = new Date(inst.expiry).toISOString().slice(0, 10);
        const strike: number = Number(inst.strike);
        const optionType: 'CE' | 'PE' = inst.optionType;

        const key = `${underlying}:${expiryIso}`;
        let chainData = chainCache.get(key);
        if (!chainData) {
          try {
            chainData = await this.optionsChainService.getOptionsChainWithSpot(underlying, expiryIso);
            chainCache.set(key, chainData);
          } catch (err) {
            this.logger.warn(
              `Chain fetch failed for ${underlying} ${expiryIso}: ${err instanceof Error ? err.message : err}`,
            );
            continue;
          }
        }

        if (!chainData?.chain || chainData.chain.length === 0) continue;

        const row = chainData.chain.find((r) => r.strikePrice === strike);
        if (!row) continue;

        const leg = optionType === 'CE' ? row.ceData : row.peData;
        if (!leg || leg.ltp <= 0) continue;

        const entryPrice = trade.entryPrice ?? 0;
        if (entryPrice <= 0) continue;

        // Three-tier LTP resolution, best to worst:
        //
        // 1. Broker live quote (getLiveOptionLtp) — looks up the REAL Angel
        //    One token from the instrument master and calls getLiveQuote().
        //    This is exactly what the broker terminal shows, no estimation.
        //
        // 2. Delta correction off the chain snapshot — the snapshot LTP and
        //    spotPrice are usually stale (NSE firewalled, Angel returns
        //    previous-close on indices), but MarketFeedService DOES have a
        //    live tick-by-tick spot. Apply first-order Taylor:
        //      newLtp ≈ snapshotLtp + delta × (liveSpot − snapshotSpot)
        //    Accurate within ~5% for near-ATM strikes; ignores gamma, vega,
        //    and IV expansion (notably understates PE on big down moves).
        //
        // 3. Plain stale chain LTP — at least the row moves when the chain
        //    snapshot eventually refreshes, instead of freezing at entry.
        const realLtp = await this.optionsChainService.getLiveOptionLtp(
          underlying,
          expiryIso,
          strike,
          optionType,
        );

        let currentLtp: number;
        if (realLtp != null) {
          currentLtp = realLtp;
        } else {
          const snapshotSpot = chainData.spotPrice ?? 0;
          const snapshotLtp = leg.ltp;
          const delta = leg.delta ?? 0;
          const token = UNDERLYING_TOKEN[underlying];
          const liveQuote = token ? this.marketFeed.getQuote(token) : null;
          const liveSpot = liveQuote?.ltp ?? 0;

          const useDeltaCorrection =
            liveSpot > 0 && snapshotSpot > 0 && delta !== 0;
          currentLtp = useDeltaCorrection
            ? Math.max(0.05, snapshotLtp + delta * (liveSpot - snapshotSpot))
            : snapshotLtp;
        }

        const pnl = (currentLtp - entryPrice) * trade.quantity;
        const pnlPercent = ((currentLtp - entryPrice) / entryPrice) * 100;

        try {
          await this.tradeRepository.updateTrade(trade.id, {
            pnl: Math.round(pnl * 100) / 100,
            pnlPercent: Math.round(pnlPercent * 100) / 100,
          });
        } catch (err) {
          this.logger.warn(
            `Failed to update trade ${trade.id} pnl: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `refreshLoop failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
