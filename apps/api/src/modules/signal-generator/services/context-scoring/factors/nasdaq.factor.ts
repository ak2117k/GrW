import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';

/**
 * STUB. Will eventually score overnight Nasdaq direction as a leading
 * indicator for Indian-market tech / index setups. Real implementation
 * requires a Yahoo (or similar) snapshot of ^IXIC close vs prior close
 * captured pre-market — see follow-up spec.
 */
@Injectable()
export class NasdaqFactor implements ContextFactor {
  readonly name = 'nasdaq';
  readonly weight = FACTOR_WEIGHTS.nasdaq;

  async compute(_input: FactorInput): Promise<FactorResult> {
    return {
      value: 0,
      tier: 'NEUTRAL_STUB',
      isStub: true,
      detail: { reason: 'stub — separate spec required' },
    };
  }
}
