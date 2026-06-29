import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';

/**
 * STUB. Will eventually score crude-oil direction as a sector-rotation
 * input (energy / paint / aviation). Real implementation requires a
 * Brent or WTI feed snapshot relative to a recent baseline — see
 * follow-up spec.
 */
@Injectable()
export class CrudeOilFactor implements ContextFactor {
  readonly name = 'crudeOil';
  readonly weight = FACTOR_WEIGHTS.crudeOil;

  async compute(_input: FactorInput): Promise<FactorResult> {
    return {
      value: 0,
      tier: 'NEUTRAL_STUB',
      isStub: true,
      detail: { reason: 'stub — separate spec required' },
    };
  }
}
