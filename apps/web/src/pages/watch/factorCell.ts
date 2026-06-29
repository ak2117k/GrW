/** Visual state of a score-factor cell relative to its buy-time value. */
export type FactorCellState = 'same' | 'decayed' | 'improved';

export interface FactorCell {
  /** What to render in the cell: a single mark, or a transition arrow. */
  text: string;
  /** Drives the highlight colour. */
  state: FactorCellState;
}

/**
 * Pure transition logic for a single score-factor column.
 *
 * Compares a factor's buy-time pass/fail against its live (current) value:
 * - unchanged          → the single ✓ / ✗ (state 'same')
 * - decayed (✓ → ✗)    → '✓→✗', flagged as a loss (state 'decayed')
 * - improved (✗ → ✓)   → '✗→✓', flagged as a gain (state 'improved')
 */
export function factorCell(initialPassed: boolean, currentPassed: boolean): FactorCell {
  if (initialPassed === currentPassed) {
    return { text: currentPassed ? '✓' : '✗', state: 'same' };
  }
  if (initialPassed && !currentPassed) {
    return { text: '✓→✗', state: 'decayed' };
  }
  return { text: '✗→✓', state: 'improved' };
}
