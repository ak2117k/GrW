import { CARRY_ALIVE_MS, CloseProductBook, PRODUCT_STALE_MS } from './close-product-book';
import { parseCarryConfig } from './domain/carry-config';

describe('CloseProductBook — the cycle\'s product + carry window', () => {
  let now = 1_000_000;
  const clock = () => now;
  const entry = { userId: 'owner', trackerId: 't1', exchange: 'NFO' };
  const book = () => new CloseProductBook(parseCarryConfig({ INTRADAY_CARRY_USERS: 'owner' }), clock);

  it('unknown product → nothing (the pre-2026-11-04 behaviour)', () => {
    expect(book().closeContextFor(entry)).toEqual({ productType: null, carry: null });
  });

  it('known product; carry only for a live-allowed user while the carry service is alive', () => {
    const b = book();
    b.set('t1', 'intraday');
    expect(b.closeContextFor(entry)).toEqual({ productType: 'INTRADAY', carry: null });
    b.markAlive();
    expect(b.closeContextFor(entry)).toEqual({ productType: 'INTRADAY', carry: { leadMin: 15, windowMin: 10 } });
    b.set('t2', 'INTRADAY');
    expect(b.closeContextFor({ ...entry, trackerId: 't2', userId: 'tenant' }).carry).toBeNull();
    now += CARRY_ALIVE_MS + 1;
    b.set('t1', 'INTRADAY');
    expect(b.closeContextFor(entry).carry).toBeNull();
  });

  it('a stale product read is unknown again', () => {
    const b = book();
    b.set('t1', 'CARRYFORWARD');
    now += PRODUCT_STALE_MS + 1;
    expect(b.closeContextFor(entry).productType).toBeNull();
  });

  it('INTRADAY_CARRY=off → never a carry window', () => {
    const b = new CloseProductBook(parseCarryConfig({ INTRADAY_CARRY: 'off', INTRADAY_CARRY_USERS: 'owner' }), clock);
    b.set('t1', 'INTRADAY');
    b.markAlive();
    expect(b.closeContextFor(entry)).toEqual({ productType: 'INTRADAY', carry: null });
  });
});
