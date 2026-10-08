import { PriceBook } from './price-book';
import type { InstrumentRef } from './hub.types';

const A: InstrumentRef = { exchange: 'NSE', token: '1', symbol: 'A' };
const B: InstrumentRef = { exchange: 'NSE', token: '2', symbol: 'B' };
const C: InstrumentRef = { exchange: 'MCX', token: '1', symbol: 'C' }; // same token as A, other exchange
const open = () => true;
const closed = () => false;
const yes = () => true;
const no = () => false;

describe('PriceBook', () => {
  it('returns fresh within maxAge and stale (with age) beyond it', () => {
    const book = new PriceBook();
    book.set({ ref: A, ltp: 10, at: 1000, source: 'ws' });
    expect(book.get(A, { maxAgeMs: 5000, now: 4000, isOpen: open, watched: yes }).kind).toBe('fresh');
    expect(book.get(A, { maxAgeMs: 5000, now: 7000, isOpen: open, watched: yes })).toEqual({
      kind: 'stale',
      price: { ref: A, ltp: 10, at: 1000, source: 'ws' },
      ageMs: 6000,
    });
  });

  it('labels an old price as market-closed when the exchange is shut', () => {
    const book = new PriceBook();
    book.set({ ref: A, ltp: 10, at: 0, source: 'quote' });
    expect(book.get(A, { maxAgeMs: 5000, now: 40_000_000, isOpen: closed, watched: yes }).kind).toBe(
      'market-closed',
    );
  });

  it('distinguishes not-watched, never-priced and a recorded failure', () => {
    const book = new PriceBook();
    expect(book.get(A, { maxAgeMs: 1, now: 0, isOpen: open, watched: no })).toEqual({
      kind: 'unavailable',
      reason: 'not-watched',
    });
    expect(book.get(A, { maxAgeMs: 1, now: 0, isOpen: open, watched: yes })).toEqual({
      kind: 'unavailable',
      reason: 'never-priced',
    });
    book.markFailure('NSE:1', 'throttled');
    expect(book.get(A, { maxAgeMs: 1, now: 0, isOpen: open, watched: yes })).toEqual({
      kind: 'unavailable',
      reason: 'throttled',
    });
  });

  it('keeps the same token on two exchanges apart', () => {
    const book = new PriceBook();
    book.set({ ref: A, ltp: 10, at: 0, source: 'ws' });
    expect(book.get(C, { maxAgeMs: 10, now: 0, isOpen: open, watched: yes }).kind).toBe('unavailable');
  });

  it('is bounded: evicts the least recently set entry', () => {
    const book = new PriceBook(2);
    book.set({ ref: A, ltp: 1, at: 0, source: 'ws' });
    book.set({ ref: B, ltp: 2, at: 0, source: 'ws' });
    book.set({ ref: C, ltp: 3, at: 0, source: 'ws' });
    expect(book.size()).toBe(2);
    expect(book.ageMs('NSE:1', 0)).toBeUndefined();
    expect(book.ageMs('MCX:1', 5)).toBe(5);
  });
});
