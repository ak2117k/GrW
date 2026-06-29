import { Injectable, Logger } from '@nestjs/common';
import { OptionsChainEntry, OptionData } from '@td/shared/types';
import { OptionsChainService } from './options-chain.service';

export interface SelectedStrike {
  strikePrice: number;
  side: 'CE' | 'PE';
  ltp: number;
  oi: number;
  oiChange: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  score: number;
  scoreBreakdown: {
    gamma: number;
    volume: number;
    oiChange: number;
    iv: number;
  };
  spotPrice: number;
  expiry: string;
  reason: string;
}

interface ScoredCandidate {
  strikePrice: number;
  leg: OptionData;
  gammaNorm: number;
  volumeNorm: number;
  oiChangeNorm: number;
  ivNorm: number;
  score: number;
}

/**
 * OptionStrikeSelectorService
 *
 * Picks the "best" CE or PE strike to trade around the ATM band using a
 * blended score over gamma (40%), volume (30%), oiChange (20%), and iv (10%).
 *
 * The caller is responsible for resolving a tradable expiry for the symbol;
 * this service just takes `{ underlying, expiry, side }` and returns the
 * winning strike — or `null` if the chain is too thin / illiquid to trade.
 */
@Injectable()
export class OptionStrikeSelectorService {
  private readonly logger = new Logger(OptionStrikeSelectorService.name);

  // Weights must sum to 1.0
  private static readonly WEIGHT_GAMMA = 0.4;
  private static readonly WEIGHT_VOLUME = 0.3;
  private static readonly WEIGHT_OI_CHANGE = 0.2;
  private static readonly WEIGHT_IV = 0.1;

  private static readonly DEFAULT_BAND_STRIKES = 5;
  private static readonly MIN_VALID_STRIKES = 3;

  constructor(private readonly optionsChainService: OptionsChainService) {}

  async selectBestStrike(args: {
    underlying: string;
    expiry: string;
    side: 'CE' | 'PE';
    bandStrikes?: number;
  }): Promise<SelectedStrike | null> {
    const { underlying, expiry, side } = args;
    const bandStrikes =
      args.bandStrikes ?? OptionStrikeSelectorService.DEFAULT_BAND_STRIKES;

    const { chain, spotPrice } =
      await this.optionsChainService.getOptionsChainWithSpot(
        underlying,
        expiry,
      );

    if (!chain || chain.length === 0) {
      this.logger.debug(
        `Empty chain for ${underlying} ${expiry} — no strike selectable`,
      );
      return null;
    }

    // Sort by strike ascending so "either side of ATM" is well-defined.
    const sortedChain = [...chain].sort(
      (a, b) => a.strikePrice - b.strikePrice,
    );

    // 1. Locate ATM index (strike closest to spot).
    const atmIndex = this.findAtmIndex(sortedChain, spotPrice);

    // 2. Slice a band of ±bandStrikes around ATM (clamped to chain bounds).
    const band = this.sliceBand(sortedChain, atmIndex, bandStrikes);

    // 3. Keep only rows where the requested leg exists.
    const candidates = band.filter((entry) => {
      const leg = side === 'CE' ? entry.ceData : entry.peData;
      return leg !== null && leg !== undefined;
    });

    if (candidates.length < OptionStrikeSelectorService.MIN_VALID_STRIKES) {
      this.logger.debug(
        `Only ${candidates.length} valid ${side} strikes in band for ${underlying} ${expiry} — skipping`,
      );
      return null;
    }

    // 4. Extract legs and compute per-field maxima for normalisation.
    const legs: Array<{ strikePrice: number; leg: OptionData }> =
      candidates.map((entry) => ({
        strikePrice: entry.strikePrice,
        leg: (side === 'CE' ? entry.ceData : entry.peData) as OptionData,
      }));

    const maxGamma = Math.max(
      ...legs.map(({ leg }) => this.safeNum(leg.gamma)),
      0,
    );
    const maxVolume = Math.max(
      ...legs.map(({ leg }) => this.safeNum(leg.volume)),
      0,
    );
    const maxPositiveOiChange = Math.max(
      ...legs.map(({ leg }) => Math.max(0, this.safeNum(leg.oiChange))),
      0,
    );
    const maxIv = Math.max(...legs.map(({ leg }) => this.safeNum(leg.iv)), 0);

    // 5. Score every candidate.
    const scored: ScoredCandidate[] = legs.map(({ strikePrice, leg }) => {
      const gammaVal = this.safeNum(leg.gamma);
      const volumeVal = this.safeNum(leg.volume);
      const oiChangeVal = this.safeNum(leg.oiChange);
      const ivVal = this.safeNum(leg.iv);

      const gammaNorm = maxGamma > 0 ? gammaVal / maxGamma : 0;
      const volumeNorm = maxVolume > 0 ? volumeVal / maxVolume : 0;
      const oiChangeNorm =
        maxPositiveOiChange > 0
          ? Math.max(0, oiChangeVal) / maxPositiveOiChange
          : 0;
      // Lower IV is better — cheaper premium. If we can't compute, stay neutral.
      const ivNorm = maxIv > 0 ? 1 - ivVal / maxIv : 0.5;

      const score =
        (gammaNorm * OptionStrikeSelectorService.WEIGHT_GAMMA +
          volumeNorm * OptionStrikeSelectorService.WEIGHT_VOLUME +
          oiChangeNorm * OptionStrikeSelectorService.WEIGHT_OI_CHANGE +
          ivNorm * OptionStrikeSelectorService.WEIGHT_IV) *
        100;

      return {
        strikePrice,
        leg,
        gammaNorm,
        volumeNorm,
        oiChangeNorm,
        ivNorm,
        score,
      };
    });

    // 6. Pick the highest scorer.
    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0];

    const winnerOi = this.safeNum(winner.leg.oi);
    const winnerVolume = this.safeNum(winner.leg.volume);
    if (winnerOi <= 0 && winnerVolume <= 0) {
      this.logger.debug(
        `Winner ${underlying} ${winner.strikePrice} ${side} has no liquidity (oi=0, vol=0) — skipping`,
      );
      return null;
    }

    const result: SelectedStrike = {
      strikePrice: winner.strikePrice,
      side,
      ltp: this.safeNum(winner.leg.ltp),
      oi: winnerOi,
      oiChange: this.safeNum(winner.leg.oiChange),
      volume: winnerVolume,
      iv: this.safeNum(winner.leg.iv),
      delta: this.safeNum(winner.leg.delta),
      gamma: this.safeNum(winner.leg.gamma),
      theta: this.safeNum(winner.leg.theta),
      vega: this.safeNum(winner.leg.vega),
      score: this.round2(winner.score),
      scoreBreakdown: {
        gamma: this.round4(winner.gammaNorm),
        volume: this.round4(winner.volumeNorm),
        oiChange: this.round4(winner.oiChangeNorm),
        iv: this.round4(winner.ivNorm),
      },
      spotPrice,
      expiry,
      reason: this.buildReason(underlying, winner, side),
    };

    return result;
  }

  private findAtmIndex(
    chain: OptionsChainEntry[],
    spotPrice: number,
  ): number {
    let bestIdx = 0;
    let bestDist = Math.abs(chain[0].strikePrice - spotPrice);
    for (let i = 1; i < chain.length; i++) {
      const dist = Math.abs(chain[i].strikePrice - spotPrice);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  private sliceBand(
    chain: OptionsChainEntry[],
    atmIndex: number,
    bandStrikes: number,
  ): OptionsChainEntry[] {
    if (bandStrikes >= chain.length) {
      return chain;
    }
    const start = Math.max(0, atmIndex - bandStrikes);
    const end = Math.min(chain.length, atmIndex + bandStrikes + 1);
    return chain.slice(start, end);
  }

  private safeNum(v: number | null | undefined): number {
    if (v === null || v === undefined || Number.isNaN(v)) return 0;
    return v;
  }

  private round2(v: number): number {
    return Math.round(v * 100) / 100;
  }

  private round4(v: number): number {
    return Math.round(v * 10000) / 10000;
  }

  private buildReason(
    underlying: string,
    winner: ScoredCandidate,
    side: 'CE' | 'PE',
  ): string {
    const gamma = this.safeNum(winner.leg.gamma).toFixed(4);
    const volume = Math.round(this.safeNum(winner.leg.volume));
    const oiChangeRaw = this.safeNum(winner.leg.oiChange);
    const oiChange =
      (oiChangeRaw >= 0 ? '+' : '') + Math.round(oiChangeRaw).toString();
    return `Selected ${underlying} ${winner.strikePrice} ${side} — gamma=${gamma} vol=${volume} oiChange=${oiChange}`;
  }
}
