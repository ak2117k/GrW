import { DEFAULT_TUNING, type TuningReader } from '../../self-review/tuning/tunables';
import type { FactorScore } from '../scorecard.types';
import { assemble } from './scoring';
import { applyTuning } from './tuning';

const f = (name: FactorScore['name'], points: FactorScore['points'], available = true): FactorScore => ({
  name, points, value: 'v', reason: 'r', available,
});
const reader = (m: Record<string, number | boolean>): TuningReader => ({
  get: (t, d) => (t in m ? (m[t] as typeof d) : d),
});

describe('applyTuning (self-review overrides of the scorecard)', () => {
  it('returns factors unchanged with no overrides', () => {
    const fs = [f('oi', 2), f('news', 1)];
    expect(applyTuning(fs, DEFAULT_TUNING)).toEqual(fs);
  });

  it('multiplies points by the weight, rounds and clamps, keeping rawPoints + weight', () => {
    const out = applyTuning([f('oi', 2), f('vix', -1), f('mood', 2)], reader({ 'scorecard.factor.oi.weight': 0.5, 'scorecard.factor.vix.weight': 1.5, 'scorecard.factor.mood.weight': 1.5 }));
    expect(out[0]).toMatchObject({ points: 1, rawPoints: 2, weight: 0.5 });
    expect(out[1]).toMatchObject({ points: -1, rawPoints: -1, weight: 1.5 }); // Math.round(-1.5) = -1
    expect(out[2]).toMatchObject({ points: 2, rawPoints: 2, weight: 1.5 }); // 3 clamps to 2
  });

  it('a weight of 0 silences the factor; the total follows', () => {
    const out = applyTuning([f('oi', 2), f('news', 2)], reader({ 'scorecard.factor.news.weight': 0 }));
    expect(out[1].points).toBe(0);
    expect(assemble({ userId: null, symbol: 'X', exchange: 'NSE', underlying: 'X', side: 'BULLISH', window: 'OVERNIGHT', computedAt: new Date(), factors: out }).total).toBe(2);
  });

  it('ignores an out-of-bounds weight', () => {
    expect(applyTuning([f('oi', 2)], reader({ 'scorecard.factor.oi.weight': 9 }))[0].points).toBe(2);
  });

  it('requireConfirmation zeroes positive news unless indicators or oi is ≥ 0', () => {
    const on = reader({ 'scorecard.factor.news.requireConfirmation': true });
    const against = applyTuning([f('oi', -1), f('indicators', -2), f('news', 2)], on);
    expect(against[2]).toMatchObject({ points: 0, rawPoints: 2 });
    const confirmed = applyTuning([f('oi', -1), f('indicators', 0), f('news', 2)], on);
    expect(confirmed[2].points).toBe(2);
    const negative = applyTuning([f('oi', -1), f('indicators', -1), f('news', -1)], on);
    expect(negative[2].points).toBe(-1);
    const unavailable = applyTuning([f('oi', 0, false), f('indicators', 0, false), f('news', 1)], on);
    expect(unavailable[2].points).toBe(0);
  });
});
