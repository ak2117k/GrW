import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TradeRepository } from '../repositories/trade.repository';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { PAPER_WATCH_STRATEGIES } from '../../signal-trader/domain/paper';

/** IST calendar date (YYYY-MM-DD) of an instant. */
function istYmd(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * True once the contract's expiry DATE (in IST) is before today (in IST).
 *
 * Uses the IST date of the raw instrument timestamp, not `toISOString()`:
 * the instrument master stores some expiries at IST midnight (= the previous
 * day in UTC), which would otherwise make a contract look expired on its own
 * expiry day.
 */
export function isContractExpired(expiry: Date | string, now: Date = new Date()): boolean {
  return istYmd(new Date(expiry)) < istYmd(now);
}

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
 * - Skips trades the signal paper watch owns (PAPER_WATCH_STRATEGIES): it
 *   marks them from the owner's live LTP every 30 s, and a chain-snapshot
 *   price written here would overwrite that live mark with a stale one
 *   (prod 2026-11-04 GOLD27NOV26150000CE: P&L % stuck while the price rose).
 * - For a non-index underlying (no live spot ⇒ no delta correction), a failed
 *   broker quote keeps the previous value instead of writing the stale chain
 *   snapshot LTP (MCX quotes fail intermittently with 403).
 */
@Injectable()
export class OpenPaperTradeRefresherWorker {
  private readonly logger = new Logger(OpenPaperTradeRefresherWorker.name);
  /** Trade ids already warned about as expired — warn once, not every 30 s. */
  private readonly warnedExpired = new Set<string>();

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
          // The signal paper watch marks these from the live LTP — never overwrite with a chain snapshot.
          !PAPER_WATCH_STRATEGIES.includes((t as any).strategy) &&
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

        // An expired contract has no chain and no live quote: asking for one
        // every 30 s only produced "No MCX contracts for CRUDEOIL expiry
        // 2026-10-15" and a stale persisted snapshot. It must NOT be rolled to
        // the next expiry either — that is a different contract, so its LTP
        // would be a wrong mark for this position. Skip it; settling an
        // expired-but-open paper trade is a separate concern.
        if (isContractExpired(inst.expiry)) {
          if (!this.warnedExpired.has(trade.id)) {
            this.warnedExpired.add(trade.id);
            this.logger.warn(
              `Paper trade ${trade.id} (${underlying} ${istYmd(new Date(inst.expiry))} ${inst.strike}${inst.optionType}) ` +
                'is still OPEN past its contract expiry — skipping mark-to-market; it needs settling',
            );
          }
          continue;
        }
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
        // 3. Plain stale chain LTP (index underlyings only) — at least the row
        //    moves when the chain snapshot eventually refreshes, instead of
        //    freezing at entry. A non-index trade keeps its previous mark.
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
          // Tier 3 only for an index underlying. A non-index one (MCX, stocks) has no live spot to
          // correct with, and its chain snapshot can be far older than the trade's last mark — keep
          // the previous value rather than overwrite it with a stale price.
          if (!useDeltaCorrection && !token) continue;
          currentLtp = useDeltaCorrection
            ? Math.max(0.05, snapshotLtp + delta * (liveSpot - snapshotSpot))
            : snapshotLtp;
        }

        // A SELL (written option) gains when the premium falls.
        const sign = String(trade.side).toUpperCase() === 'SELL' ? -1 : 1;
        const pnl = sign * (currentLtp - entryPrice) * trade.quantity;
        const pnlPercent = ((sign * (currentLtp - entryPrice)) / entryPrice) * 100;

        try {
          // OPEN-only write: a close that lands while this cycle is pricing must keep its realised pnl.
          await this.tradeRepository.markOpenTrade(trade.id, {
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
