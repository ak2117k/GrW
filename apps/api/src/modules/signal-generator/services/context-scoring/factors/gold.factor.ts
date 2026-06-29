import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';

/**
 * STUB. Will eventually score gold direction as a risk-on / risk-off
 * counter-tell (gold up = risk-off, often bearish for equities). Real
 * implementation requires a gold spot or MCX gold-future feed — see
 * follow-up spec.
 */
@Injectable()
export class GoldFactor implements ContextFactor {
  readonly name = 'gold';
  readonly weight = FACTOR_WEIGHTS.gold;

  async compute(_input: FactorInput): Promise<FactorResult> {
    return {
      value: 0,
      tier: 'NEUTRAL_STUB',
      isStub: true,
      detail: { reason: 'stub — separate spec required' },
    };
  }
}
