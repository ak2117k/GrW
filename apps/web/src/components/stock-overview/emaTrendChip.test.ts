import { describe, expect, it } from 'vitest';
import { emaTrendChip, macdChip } from './emaTrendChip';

describe('emaTrendChip', () => {
  it('green, red and mixed, with the side of the lines', () => {
    expect(emaTrendChip({ ema20: 110, ema80: 100, trend: 1 })).toEqual({ value: '↑ green', alignment: 1 });
    expect(emaTrendChip({ ema20: 90, ema80: 100, trend: -1 })).toEqual({ value: '↓ red', alignment: -1 });
    expect(emaTrendChip({ ema20: 110, ema80: 100, trend: 0 })).toEqual({ value: '↑ mixed', alignment: 0 });
    expect(emaTrendChip({ ema20: 90, ema80: 100, trend: 0 })).toEqual({ value: '↓ mixed', alignment: 0 });
  });
  it('a dash when there are not enough bars for the EMA80', () => {
    expect(emaTrendChip({ ema20: 110, ema80: null, trend: null })).toEqual({ value: '—', alignment: 0 });
    expect(emaTrendChip({})).toEqual({ value: '—', alignment: 0 });
  });
});

describe('macdChip', () => {
  it('shows the Heikin Ashi histogram, green above zero and red below', () => {
    expect(macdChip({ trendMacdHistogram: 2.14, macdHistogram: 9 })).toEqual({ value: '+2.14', alignment: 1 });
    expect(macdChip({ trendMacdHistogram: -3, macdHistogram: 9 })).toEqual({ value: '-3.00', alignment: -1 });
  });
  it('uses the plain histogram when there is no Heikin Ashi one, and a dash for neither', () => {
    expect(macdChip({ macdHistogram: 1 })).toEqual({ value: '+1.00', alignment: 1 });
    expect(macdChip({ macdHistogram: null })).toEqual({ value: '—', alignment: 0 });
  });
});
