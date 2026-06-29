import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';

/**
 * Multi-timeframe trend factor. Reads `setupContext.higherTimeframeTrend.bias`
 * which the SignalGeneratorService computes from the next-higher TF EMA9/EMA21
 * (e.g. 1H bias when working on 15m). Returns +1.0 when the bias aligns with
 * the trade side, -1.0 when it opposes, and 0.0 when neutral or unavailable.
 */
@Injectable()
export class MtfTrendFactor implements ContextFactor {
  readonly name = 'mtfTrend';
  readonly weight = FACTOR_WEIGHTS.mtfTrend;

  async compute(input: FactorInput): Promise<FactorResult> {
    const mtf = input.setupContext.higherTimeframeTrend;
    if (!mtf) {
      return {
        value: 0,
        tier: 'NEUTRAL',
        isStub: false,
        detail: { reason: 'higher TF unavailable' },
      };
    }

    const aligned =
      (input.side === 'BUY' && mtf.bias === 'bullish') ||
      (input.side === 'SELL' && mtf.bias === 'bearish');
    const opposed =
      (input.side === 'BUY' && mtf.bias === 'bearish') ||
      (input.side === 'SELL' && mtf.bias === 'bullish');

    const value = aligned ? 1.0 : opposed ? -1.0 : 0;
    const tier = aligned ? 'STRONG_BULL' : opposed ? 'STRONG_BEAR' : 'NEUTRAL';

    return {
      value,
      tier,
      isStub: false,
      detail: { tf: mtf.tf, bias: mtf.bias, ema9: mtf.ema9, ema21: mtf.ema21 },
    };
  }
}
