import { Prisma } from '@prisma/client';
import type { LedgerType } from './execution.types';
import {
  applyPositionFill,
  balances,
  dailyMtfInterest,
  FLAT,
  istDate,
  money,
  mtfInterestDays,
  positionFromFills,
} from './ledger-math';
import { NOW } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);
const row = (type: LedgerType, amount: string) => ({ type, amount: D(amount) });
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('money and balances (spec §4.4)', () => {
  it('rounds half-up to the paisa', () => {
    expect(money('1.005').toFixed(2)).toBe('1.01');
    expect(money('-1.005').toFixed(2)).toBe('-1.01');
    expect(money('2.4669').toFixed(2)).toBe('2.47');
  });

  it('cash, blocked margin and free cash; free cash is the sum of every row', () => {
    const rows = [
      row('DEPOSIT', '1000000.00'),
      row('MARGIN_BLOCK', '-10000.00'),
      row('MARGIN_RELEASE', '10000.00'),
      row('MARGIN_BLOCK', '-10014.00'),
      row('CHARGES', '-26.92'),
    ];
    const open = balances(rows);
    expect(open.blockedMargin.toFixed(2)).toBe('10014.00');
    expect(open.cash.toFixed(2)).toBe('999973.08');
    expect(open.freeCash.toFixed(2)).toBe('989959.08');
    const closed = balances([...rows, row('REALISED_PNL', '430.00'), row('CHARGES', '-38.05'), row('MARGIN_RELEASE', '10014.00'), row('MTF_INTEREST', '-2.47')]);
    expect(closed.blockedMargin.toFixed(2)).toBe('0.00');
    expect(closed.charges.toFixed(2)).toBe('64.97');
    expect(closed.mtfInterest.toFixed(2)).toBe('2.47');
    expect(closed.cash.toFixed(2)).toBe('1000362.56');
    expect(closed.freeCash.toFixed(2)).toBe('1000362.56');
  });
});

describe('position from fills', () => {
  it('averages the entry price and books realised P&L on the exit', () => {
    const s1 = applyPositionFill(FLAT, { side: 'BUY', qty: 60, price: D('500.5'), at: at(0) });
    const s2 = applyPositionFill(s1.state, { side: 'BUY', qty: 40, price: D('501'), at: at(1) });
    expect(s2.state.netQty).toBe(100);
    expect(s2.state.avgPrice?.toFixed(4)).toBe('500.7000');
    expect(s2.state.openedAt).toEqual(at(0));
    const exit = applyPositionFill(s2.state, { side: 'SELL', qty: 100, price: D('505'), at: at(2) });
    expect(exit.realised?.toFixed(2)).toBe('430.00');
    expect(exit.state.netQty).toBe(0);
    expect(exit.state.avgPrice).toBeNull();
    expect(exit.state.openedAt).toBeNull();
    expect(exit.state.realised.toFixed(2)).toBe('430.00');
  });

  it('a short realises (entry − exit) × qty', () => {
    const s = positionFromFills([
      { side: 'SELL', qty: 10, price: D('200'), at: at(0) },
      { side: 'BUY', qty: 4, price: D('190'), at: at(1) },
    ]);
    expect(s.netQty).toBe(-6);
    expect(s.realised.toFixed(2)).toBe('40.00');
    expect(s.avgPrice?.toFixed(2)).toBe('200.00');
  });

  it('refuses a fill that would flip the position', () => {
    const long = applyPositionFill(FLAT, { side: 'BUY', qty: 5, price: D('10'), at: at(0) }).state;
    expect(() => applyPositionFill(long, { side: 'SELL', qty: 6, price: D('11'), at: at(1) })).toThrow('flip');
  });
});

describe('MTF interest days (spec §4.4)', () => {
  it('counts calendar days and catches up a weekend', () => {
    expect(mtfInterestDays('2026-10-09', '2026-10-09', '2026-10-12')).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
  });

  it('charges the opening day on the first run, and nothing twice', () => {
    expect(mtfInterestDays('2026-10-12', null, '2026-10-12')).toEqual(['2026-10-12']);
    expect(mtfInterestDays('2026-10-09', '2026-10-12', '2026-10-12')).toEqual([]);
  });

  it('ignores a posting from an earlier holding of the same token, and crosses a month end', () => {
    expect(mtfInterestDays('2026-10-30', '2026-10-01', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('a day of interest is funded × rate ÷ 100 ÷ 365, to the paisa', () => {
    expect(dailyMtfInterest(D('5002.50'), D('18')).toFixed(2)).toBe('2.47');
  });

  it('IST dates roll at 18:30 UTC', () => {
    expect(istDate(new Date('2026-10-11T18:29:59.999Z'))).toBe('2026-10-11');
    expect(istDate(new Date('2026-10-11T18:30:00.000Z'))).toBe('2026-10-12');
  });
});
