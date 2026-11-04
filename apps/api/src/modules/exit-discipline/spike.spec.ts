import { SPIKE_BANK_RISE_N } from './config';
import { spikeBankReading, type SpikeInput } from './spike';

/** Long NIFTY 23650 PE, 2026-11-04: window low 141.7 (12:12) → new best 155.45 (12:16), N ≈ 5.1. */
const PE: SpikeInput = { side: 'LONG', prevBest: 147.95, best: 155.45, windowWorst: 141.7, n: 5.1 };

describe('spikeBankReading (SPIKE_BANK, 2026-11-04)', () => {
  it('the threshold is 2.5 N', () => expect(SPIKE_BANK_RISE_N).toBe(2.5));

  it('2026-11-04 23650 PE: a new best 13.75 above the 3-minute low with N 5.1 (2.7 N) is a spike', () => {
    expect(spikeBankReading(PE)).toEqual({ spike: true, newBest: true, rise: 13.75, riseInN: 2.7, vetoed: false });
  });

  it('just under 2.5 N is not; exactly 2.5 N is', () => {
    expect(spikeBankReading({ ...PE, n: 5.6 }).spike).toBe(false);
    expect(spikeBankReading({ ...PE, n: 5.5 }).spike).toBe(true);
  });

  it('only on a NEW best: an old best or an unknown previous best is never a spike', () => {
    expect(spikeBankReading({ ...PE, prevBest: 155.45 })).toMatchObject({ spike: false, newBest: false });
    expect(spikeBankReading({ ...PE, prevBest: null })).toMatchObject({ spike: false, newBest: false });
  });

  it('unmeasurable (no N, no window) is never a spike', () => {
    expect(spikeBankReading({ ...PE, n: null }).spike).toBe(false);
    expect(spikeBankReading({ ...PE, n: 0 }).spike).toBe(false);
    expect(spikeBankReading({ ...PE, windowWorst: null }).spike).toBe(false);
  });

  it('SHORT: a new LOW far under the window HIGH', () => {
    const s: SpikeInput = { side: 'SHORT', prevBest: 100, best: 92, windowWorst: 104, n: 4 };
    expect(spikeBankReading(s)).toMatchObject({ spike: true, rise: 12, riseInN: 3 });
    expect(spikeBankReading({ ...s, best: 101 }).spike).toBe(false);
  });

  it('noise opinion: REAL vetoes (let a real move run); NOISE / UNKNOWN / null keep the code rule', () => {
    expect(spikeBankReading({ ...PE, noise: { verdict: 'REAL', source: 'test' } })).toMatchObject({ spike: false, vetoed: true });
    expect(spikeBankReading({ ...PE, noise: { verdict: 'NOISE', source: 'test' } }).spike).toBe(true);
    expect(spikeBankReading({ ...PE, noise: { verdict: 'UNKNOWN', source: 'test' } }).spike).toBe(true);
    expect(spikeBankReading({ ...PE, noise: null }).spike).toBe(true);
  });
});
