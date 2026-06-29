import type {
  SetupContext,
  Tier,
  CombinedTier,
  ContextFactorBreakdown,
} from '../../types/setup-context.types';

// Re-export the shared tier/breakdown types so context-scoring code can
// import everything from one place.
export type { Tier, CombinedTier, ContextFactorBreakdown } from '../../types/setup-context.types';
export { tierFromValue, tierFromScore } from '../../types/setup-context.types';

export interface FactorInput {
  side: 'BUY' | 'SELL';
  token: string;
  symbol: string;
  exchange: string;
  setupContext: SetupContext;
}

export interface FactorResult {
  /** -1.0 (counter-aligned) to +1.0 (supportive of side). */
  value: number;
  tier: Tier;
  isStub: boolean;
  detail?: Record<string, unknown>;
}

export interface ContextFactor {
  readonly name: string;
  readonly weight: number;
  compute(input: FactorInput): Promise<FactorResult>;
}

export interface ContextScore {
  contextScore: number;        // -100 to +100, alignment with side
  contextTier: CombinedTier;
  contextCoverage: number;     // 0.0 to 1.0
  contextFactors: ContextFactorBreakdown[];
}
