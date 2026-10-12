import { canMove, reducePosition } from './position-state';
import { order } from './testing/lifecycle-fixtures';

const exitOrder = (over: Parameters<typeof order>[0] = {}) => order({ purpose: 'EXIT', side: 'SELL', ...over });

describe('reducePosition (spec §7.1)', () => {
  it('an entry not yet filled is PENDING_ENTRY', () => {
    const f = reducePosition('PENDING_ENTRY', [order()]);
    expect(f).toMatchObject({ status: 'PENDING_ENTRY', entryFilledQty: 0, openQty: 0, entryAvgPrice: null });
    expect(f.openEntry?.purpose).toBe('ENTRY');
  });

  it('a filled entry is OPEN with its average price', () => {
    expect(reducePosition('PENDING_ENTRY', [order({ state: 'FILLED', filledQty: 100, avgFillPrice: 500.25 })])).toMatchObject({
      status: 'OPEN',
      entryFilledQty: 100,
      openQty: 100,
      entryAvgPrice: 500.25,
      openEntry: null,
    });
  });

  it('a partly filled entry that is still open is OPEN for the filled part', () => {
    const f = reducePosition('PENDING_ENTRY', [order({ state: 'PARTIAL', filledQty: 40, avgFillPrice: 500 })]);
    expect(f).toMatchObject({ status: 'OPEN', openQty: 40 });
    expect(f.openEntry?.filledQty).toBe(40);
  });

  it('an entry rejected or cancelled with nothing filled is CANCELLED', () => {
    expect(reducePosition('PENDING_ENTRY', [order({ state: 'REJECTED', rejectReason: 'no fresh price' })]).status).toBe('CANCELLED');
    expect(reducePosition('PENDING_ENTRY', [order({ state: 'CANCELLED' })]).status).toBe('CANCELLED');
  });

  it('a partly filled exit makes it PARTIAL; all exits filled and nothing open is CLOSED', () => {
    const entry = order({ state: 'FILLED', filledQty: 100, avgFillPrice: 500 });
    const half = exitOrder({ qty: 50, state: 'FILLED', filledQty: 50, avgFillPrice: 505 });
    expect(reducePosition('OPEN', [entry, half])).toMatchObject({ status: 'PARTIAL', openQty: 50, exitFilledQty: 50, pendingExitQty: 0 });
    const rest = exitOrder({ qty: 50, state: 'FILLED', filledQty: 50, avgFillPrice: 503 });
    expect(reducePosition('PARTIAL', [entry, half, rest])).toMatchObject({ status: 'CLOSED', openQty: 0 });
  });

  it('counts the unfilled quantity of open exit orders as pending', () => {
    const entry = order({ state: 'FILLED', filledQty: 100, avgFillPrice: 500 });
    const f = reducePosition('EXITING', [entry, exitOrder({ qty: 100, state: 'PARTIAL', filledQty: 30 })]);
    expect(f).toMatchObject({ status: 'EXITING', openQty: 70, pendingExitQty: 70 });
    expect(f.openExits).toHaveLength(1);
  });

  it('EXITING stays EXITING until flat, then CLOSED; an EXITING position whose entry never filled becomes CANCELLED', () => {
    const entry = order({ state: 'FILLED', filledQty: 100, avgFillPrice: 500 });
    expect(reducePosition('EXITING', [entry]).status).toBe('EXITING');
    expect(reducePosition('EXITING', [entry, exitOrder({ state: 'FILLED', filledQty: 100 })]).status).toBe('CLOSED');
    expect(reducePosition('EXITING', [order()]).status).toBe('EXITING');
    expect(reducePosition('EXITING', [order({ state: 'CANCELLED' })]).status).toBe('CANCELLED');
  });

  it('is not flat while the entry remainder is still open', () => {
    const entry = order({ state: 'PARTIAL', filledQty: 40, avgFillPrice: 500 });
    expect(reducePosition('EXITING', [entry, exitOrder({ qty: 40, state: 'FILLED', filledQty: 40 })]).status).toBe('EXITING');
  });

  it('a closed or cancelled position never moves', () => {
    expect(reducePosition('CLOSED', [order({ state: 'OPEN' })]).status).toBe('CLOSED');
    expect(reducePosition('CANCELLED', [order({ state: 'FILLED', filledQty: 100, avgFillPrice: 500 })]).status).toBe('CANCELLED');
  });

  it('exits filled beyond the entry are an error', () => {
    expect(() =>
      reducePosition('OPEN', [order({ state: 'FILLED', filledQty: 10, avgFillPrice: 500 }), exitOrder({ state: 'FILLED', filledQty: 20 })]),
    ).toThrow('exits filled 20 > entry filled 10');
  });
});

describe('canMove', () => {
  it('follows spec §7.1 and never leaves a terminal status', () => {
    expect(canMove('PENDING_ENTRY', 'OPEN')).toBe(true);
    expect(canMove('PENDING_ENTRY', 'CANCELLED')).toBe(true);
    expect(canMove('OPEN', 'PARTIAL')).toBe(true);
    expect(canMove('PARTIAL', 'EXITING')).toBe(true);
    expect(canMove('EXITING', 'CLOSED')).toBe(true);
    expect(canMove('OPEN', 'PENDING_ENTRY')).toBe(false);
    expect(canMove('PARTIAL', 'OPEN')).toBe(false);
    expect(canMove('CLOSED', 'OPEN')).toBe(false);
    expect(canMove('CANCELLED', 'OPEN')).toBe(false);
    expect(canMove('OPEN', 'OPEN')).toBe(true);
  });
});
