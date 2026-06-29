import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';
import { tierFromValue } from '../types';

/**
 * Greeks factor. Reads `setupContext.recommendedStrike?.delta` and checks
 * sign agreement with the trade side (positive delta supports BUY, negative
 * supports SELL). Magnitude is `|delta| / 0.6` clamped to ±1.0 — deeper-ITM
 * strikes (|delta| ≥ 0.6) score full magnitude, ATM-ish strikes score
 * smaller. Low explicit weight in the framework because the option-strike
 * picker already optimises around delta — this factor is a sanity check on
 * sign agreement.
 */
@Injectable()
export class GreeksFactor implements ContextFactor {
  readonly name = 'greeks';
  readonly weight = FACTOR_WEIGHTS.greeks;

  async compute(input: FactorInput): Promise<FactorResult> {
    const strike = input.setupContext.recommendedStrike;
    if (!strike) {
      return {
        value: 0,
        tier: 'NEUTRAL',
        isStub: false,
        detail: { reason: 'no strike recommendation' },
      };
    }

    const expectedSign = input.side === 'BUY' ? 1 : -1;
    const actualSign = strike.delta >= 0 ? 1 : -1;
    const aligned = actualSign === expectedSign;

    // Magnitude scaled by 0.6 — deeper-ITM (|delta| ≥ 0.6) → ±1.0; ATM-ish → smaller.
    const magnitude = Math.min(1.0, Math.abs(strike.delta) / 0.6);
    const value = aligned ? magnitude : -magnitude;

    return {
      value,
      tier: tierFromValue(value),
      isStub: false,
      detail: {
        strike: strike.strike,
        side: strike.side,
        delta: strike.delta,
        gamma: strike.gamma,
      },
    };
  }
}
