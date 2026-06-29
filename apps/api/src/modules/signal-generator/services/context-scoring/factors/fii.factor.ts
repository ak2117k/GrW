import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';

/**
 * STUB. Will eventually score FII (foreign institutional investor) net
 * positioning — typically a daily NSDL/CDSL feed published end-of-day.
 * Real implementation requires a scheduled scrape + persistence layer —
 * see follow-up spec.
 */
@Injectable()
export class FiiFactor implements ContextFactor {
  readonly name = 'fii';
  readonly weight = FACTOR_WEIGHTS.fii;

  async compute(_input: FactorInput): Promise<FactorResult> {
    return {
      value: 0,
      tier: 'NEUTRAL_STUB',
      isStub: true,
      detail: { reason: 'stub — separate spec required' },
    };
  }
}
