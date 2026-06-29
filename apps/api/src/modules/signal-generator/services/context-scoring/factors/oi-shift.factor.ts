import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';

/**
 * STUB. Will eventually read intraday OI deltas from MarketFeedService /
 * OptionsChainService to score whether smart money is building positions
 * in the trade direction. Real implementation requires periodic OI
 * snapshots + a baseline diff — see follow-up spec.
 */
@Injectable()
export class OiShiftFactor implements ContextFactor {
  readonly name = 'oiShift';
  readonly weight = FACTOR_WEIGHTS.oiShift;

  async compute(_input: FactorInput): Promise<FactorResult> {
    return {
      value: 0,
      tier: 'NEUTRAL_STUB',
      isStub: true,
      detail: { reason: 'stub — separate spec required' },
    };
  }
}
