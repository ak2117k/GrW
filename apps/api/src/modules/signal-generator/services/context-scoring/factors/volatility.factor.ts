import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';
import { tierFromValue } from '../types';
import { MarketContextService } from '../../../../market-data/services/market-context.service';

/**
 * Volatility factor. Reads VIX today + yesterday from MarketContextService
 * and classifies the day-on-day change into 5 bands per Mama's spec:
 *
 *   change ≥ +5%   → +1.0  (STRONG_BULL)
 *   change ≥ +2%   → +0.5  (BULL)
 *   |change| < 2%  →  0    (NEUTRAL)
 *   change ≤ -2%   → -0.5  (BEAR)
 *   change ≤ -5%   → -1.0  (STRONG_BEAR)
 *
 * Direction-symmetric: "vol up" is supportive for both BUY and SELL setups,
 * so `input.side` is intentionally unused.
 */
@Injectable()
export class VolatilityFactor implements ContextFactor {
  readonly name = 'volatility';
  readonly weight = FACTOR_WEIGHTS.volatility;

  constructor(private readonly marketContext: MarketContextService) {}

  async compute(_input: FactorInput): Promise<FactorResult> {
    const history = await this.marketContext.getVixHistory();
    if (!history || !history.today || !history.yesterday) {
      return {
        value: 0,
        tier: 'NEUTRAL',
        isStub: false,
        detail: { reason: 'no VIX data' },
      };
    }

    const change = (history.today - history.yesterday) / history.yesterday;
    let value: number;
    if (change >= 0.05) value = 1.0;
    else if (change >= 0.02) value = 0.5;
    else if (change <= -0.05) value = -1.0;
    else if (change <= -0.02) value = -0.5;
    else value = 0;

    return {
      value,
      tier: tierFromValue(value),
      isStub: false,
      detail: {
        vix: history.today,
        vixYesterday: history.yesterday,
        vixChange: Number(change.toFixed(4)),
      },
    };
  }
}
