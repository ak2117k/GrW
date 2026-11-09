import { describe, expect, it } from 'vitest';
import { emaTrendChip } from './emaTrendChip';

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
