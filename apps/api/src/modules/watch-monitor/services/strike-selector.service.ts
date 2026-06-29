import { Injectable, Logger } from '@nestjs/common';
import { OptionStrikeSelectorService } from '../../options-chain/services/option-strike-selector.service';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';

export interface PickedStrike {
  optionsToken: string | null;
  optionsType: 'CE' | 'PE';
  optionsStrike: number;
  optionsExpiry: Date;
  optionsLotSize: number | null;
  optionsSelectionScore: number;
}

const ROLL_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * StrikeSelectorService
 *
 * Thin wrapper around OptionStrikeSelectorService that:
 *   1. Resolves expiries via OptionsChainService.getExpiries()
 *   2. Picks current-month expiry when > 7 days away, else next-month
 *   3. Maps BUY → CE, SELL → PE
 *   4. Delegates strike selection to OptionStrikeSelectorService
 *   5. Returns null when no F&O data is available
 */
@Injectable()
export class StrikeSelectorService {
  private readonly logger = new Logger(StrikeSelectorService.name);

  constructor(
    private readonly inner: OptionStrikeSelectorService,
    private readonly chain: OptionsChainService,
  ) {}

  async pick(input: {
    symbol: string;
    side: 'BUY' | 'SELL';
    underlyingPrice: number;
  }): Promise<PickedStrike | null> {
    const { symbol, side } = input;

    let expiries: string[] = [];
    try {
      expiries = await this.chain.getExpiries(symbol);
    } catch (err) {
      this.logger.warn(
        `pick(${symbol}): getExpiries failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }

    if (expiries.length === 0) return null;

    const expiry = this.pickExpiry(expiries);
    if (!expiry) return null;

    const legSide: 'CE' | 'PE' = side === 'BUY' ? 'CE' : 'PE';

    let selected;
    try {
      selected = await this.inner.selectBestStrike({
        underlying: symbol,
        expiry,
        side: legSide,
      });
    } catch (err) {
      this.logger.warn(
        `pick(${symbol}): inner.selectBestStrike threw: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }

    if (!selected) return null;

    // TODO(stage-3): resolve options token from chain.
    // OptionsChainEntry / OptionData do not carry per-leg tokens — the broker
    // token lives only on the raw OptionContract objects inside the master-
    // backed cache of OptionsChainService.  Until the shared type is extended
    // to propagate token through the chain, both fields stay null here.
    let optionsToken: string | null = null;
    let optionsLotSize: number | null = null;
    try {
      const chainResp = await this.chain.getOptionsChainWithSpot(symbol, expiry);
      const strikeEntry = chainResp.chain.find((e: any) => e.strikePrice === selected.strikePrice);
      if (strikeEntry) {
        const leg = legSide === 'CE' ? strikeEntry.ceData : strikeEntry.peData;
        // OptionData does not yet carry .token or .lotSize — left as null.
        optionsToken = (leg as any)?.token ?? null;
        optionsLotSize = (strikeEntry as any).lotSize ?? (leg as any)?.lotSize ?? null;
      }
    } catch (err) {
      this.logger.warn(`pick(${symbol}): could not resolve token/lotSize: ${err instanceof Error ? err.message : err}`);
    }

    return {
      optionsToken,
      optionsType: selected.side,
      optionsStrike: selected.strikePrice,
      optionsExpiry: new Date(selected.expiry),
      optionsLotSize,
      optionsSelectionScore: selected.score,
    };
  }

  /**
   * Walks the sorted expiry list and returns the first one that is at least
   * ROLL_WINDOW_DAYS out. If none qualifies (all closer than 7 days) returns
   * the last expiry so we always have something to trade.
   */
  private pickExpiry(expiries: string[]): string | null {
    const now = Date.now();
    for (const iso of expiries) {
      const ts = new Date(iso).getTime();
      const daysOut = (ts - now) / MS_PER_DAY;
      if (daysOut >= ROLL_WINDOW_DAYS) return iso;
    }
    return expiries[expiries.length - 1] ?? null;
  }
}
