import { noiseAwareFloor } from './floor';

const L = { side: 'LONG' as const, breakeven: 522.9, n: 4.5, armN: 1.5, trailN: 2, prevArmedLevel: null, latchedArmed: false };
const S = { side: 'SHORT' as const, breakeven: 100, n: 2, armN: 1.5, trailN: 2, prevArmedLevel: null, latchedArmed: false };

describe('noiseAwareFloor (R4, spec §4)', () => {
  it.each([
    ['LONG unarmed: excursion 5.1 < 6.75 ⇒ target = breakeven + 1.5N', { ...L, peak: 528 }, false, 529.65],
    ['LONG armed: trails the peak by 2N', { ...L, peak: 539.5 }, true, 530.5],
    ['LONG armed, trail below breakeven ⇒ breakeven', { ...L, peak: 530, latchedArmed: true }, true, 522.9],
    ['LONG tighten-only: previous 531 beats 530.5', { ...L, peak: 539.5, prevArmedLevel: 531 }, true, 531],
    ['LONG tighten-only: a looser previous never loosens', { ...L, peak: 539.5, prevArmedLevel: 529 }, true, 530.5],
    ['LONG no peak, not latched ⇒ unarmed target', { ...L, peak: null }, false, 529.65],
    ['LONG no peak, latched ⇒ breakeven', { ...L, peak: null, latchedArmed: true }, true, 522.9],
    ['SHORT armed: low 94 ⇒ 94 + 4 = 98', { ...S, peak: 94 }, true, 98],
    ['SHORT tighten-only: previous 97.5 beats 98', { ...S, peak: 94, prevArmedLevel: 97.5 }, true, 97.5],
    ['SHORT unarmed: target = breakeven − 1.5N', { ...S, peak: 98 }, false, 97],
  ])('%s', (_l, input, armed, level) => {
    const f = noiseAwareFloor(input);
    expect(f).toMatchObject({ basis: 'noise', armed, level, n: input.n });
  });
  it('armPrice is always breakeven ± armN·N', () => {
    expect(noiseAwareFloor({ ...L, peak: 539.5 }).armPrice).toBe(529.65);
    expect(noiseAwareFloor({ ...S, peak: 94 }).armPrice).toBe(97);
  });
});
