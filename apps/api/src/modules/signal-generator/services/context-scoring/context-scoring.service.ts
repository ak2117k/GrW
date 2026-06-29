import { Injectable, Logger } from '@nestjs/common';
import type {
  ContextFactor,
  FactorInput,
  FactorResult,
  ContextScore,
  ContextFactorBreakdown,
} from './types';
import { tierFromScore } from './types';

/**
 * Aggregator for the v1 context-scoring engine. Pure compute — registers no
 * data of its own; receives a list of `ContextFactor` instances via the
 * constructor and asks each one for an alignment-with-side value (-1..+1).
 *
 * Combined score is `sum(weight × value) × 100`, clamped to [-100, +100].
 * Tier is derived from the bands documented in `tierFromScore`.
 *
 * A throwing factor is caught and treated as a stub for that call so a
 * single broken factor never blocks the score.
 */
@Injectable()
export class ContextScoringService {
  private readonly logger = new Logger(ContextScoringService.name);

  /**
   * Pass the registered factors via constructor. The NestJS module wires
   * each factor as a provider and the scoring service receives them as a
   * single array via a custom factory provider in
   * signal-generator.module.ts.
   */
  constructor(private readonly factors: ContextFactor[]) {}

  async score(input: FactorInput): Promise<ContextScore> {
    const results = await Promise.all(
      this.factors.map(async (factor): Promise<{ factor: ContextFactor; result: FactorResult }> => {
        try {
          const result = await factor.compute(input);
          return { factor, result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Factor ${factor.name} threw — treating as stub: ${message}`,
          );
          return {
            factor,
            result: {
              value: 0,
              tier: 'NEUTRAL_STUB',
              isStub: true,
              detail: { error: message },
            },
          };
        }
      }),
    );

    const totalWeight = results.reduce((s, r) => s + r.factor.weight, 0);
    const realWeight = results
      .filter((r) => !r.result.isStub)
      .reduce((s, r) => s + r.factor.weight, 0);

    const rawScore = results.reduce(
      (s, r) => s + r.factor.weight * r.result.value * 100,
      0,
    );
    const contextScore = clamp(Math.round(rawScore), -100, 100);
    const contextCoverage = totalWeight > 0 ? realWeight / totalWeight : 0;

    const contextFactors: ContextFactorBreakdown[] = results.map((r) => ({
      name: r.factor.name,
      weight: r.factor.weight,
      tier: r.result.tier,
      value: r.result.value,
      contribution: Math.round(r.factor.weight * r.result.value * 100),
      isStub: r.result.isStub,
      detail: r.result.detail,
    }));

    return {
      contextScore,
      contextTier: tierFromScore(contextScore),
      contextCoverage,
      contextFactors,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
