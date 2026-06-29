import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';

/**
 * STUB. Will eventually score sector strength relative to the broader index
 * (e.g. NIFTY IT vs NIFTY 50 for IT-stock setups). Real implementation
 * requires a sector-mapping table + a relative-strength feed — see follow-up
 * spec. Returns neutral so the engine can register it and report coverage
 * correctly without it skewing the score.
 */
@Injectable()
export class SectorFactor implements ContextFactor {
  readonly name = 'sector';
  readonly weight = FACTOR_WEIGHTS.sector;

  async compute(_input: FactorInput): Promise<FactorResult> {
    return {
      value: 0,
      tier: 'NEUTRAL_STUB',
      isStub: true,
      detail: { reason: 'stub — separate spec required' },
    };
  }
}
