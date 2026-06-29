import { describe, it, expect } from 'vitest';
import { factorCell } from './factorCell';

describe('factorCell — transition logic', () => {
  it('returns "same" with ✓ when a factor passed at entry and still passes', () => {
    expect(factorCell(true, true)).toEqual({ text: '✓', state: 'same' });
  });

  it('returns "same" with ✗ when a factor failed at entry and still fails', () => {
    expect(factorCell(false, false)).toEqual({ text: '✗', state: 'same' });
  });

  it('returns "decayed" with ✓→✗ when a factor passed at entry but now fails', () => {
    expect(factorCell(true, false)).toEqual({ text: '✓→✗', state: 'decayed' });
  });

  it('returns "improved" with ✗→✓ when a factor failed at entry but now passes', () => {
    expect(factorCell(false, true)).toEqual({ text: '✗→✓', state: 'improved' });
  });
});
