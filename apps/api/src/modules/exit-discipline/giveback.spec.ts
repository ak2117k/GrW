import { noiseGiveback } from './giveback';

const L = { side: 'LONG' as const, entryPrice: 521.9, n: 4.5, armN: 1.5, givebackN: 1.5 };
describe('noiseGiveback (spec §5)', () => {
  it.each([
    ['excursion 12.7, pullback 9.0 ⇒ fires', { ...L, peak: 534.6, ltp: 525.6 }, true],
    ['pullback 6.6 < 6.75 ⇒ quiet (ordinary chop)', { ...L, peak: 534.6, ltp: 528 }, false],
    ['excursion 5.1 < 6.75 ⇒ quiet even on a deep pullback', { ...L, peak: 527, ltp: 518 }, false],
    ['SHORT: low 90 from 100, back to 94 ⇒ fires', { side: 'SHORT' as const, entryPrice: 100, n: 2, armN: 1.5, givebackN: 1.5, peak: 90, ltp: 94 }, true],
  ])('%s', (_l, input, fire) => expect(noiseGiveback(input)!.fire).toBe(fire));
  it('non-finite inputs or no peak ⇒ null', () => {
    expect(noiseGiveback({ ...L, peak: null, ltp: 1 })).toBeNull();
    expect(noiseGiveback({ ...L, peak: 530, ltp: NaN })).toBeNull();
    expect(noiseGiveback({ ...L, peak: 530, ltp: 525, n: 0 })).toBeNull();
  });
});
