import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import { strikesAround } from './chain-snapshot';
import { STOCK_STRIKES_AROUND, normaliseUnderlying, packBatches, stockChainTick } from './stock-chain';

const cal = new SessionClock({ holidays: MARKET_HOLIDAYS });
/** Monday 2026-10-19, HH:MM IST → instant (second 55, like the cron). */
const ist = (hhmm: string, ymd = '2026-10-19') => new Date(Date.parse(`${ymd}T${hhmm}:55+05:30`));

describe('stockChainTick (cadence + window)', () => {
  it.each([
    ['09:00', 'NONE'],
    ['09:14', 'NONE'],
    ['09:15', 'INTRADAY'],
    ['09:20', 'NONE'],
    ['09:30', 'INTRADAY'],
    ['12:45', 'INTRADAY'],
    ['15:15', 'INTRADAY'],
    ['15:30', 'EOD'],
    ['15:45', 'NONE'],
  ])('%s IST → %s', (t, want) => {
    expect(stockChainTick(cal, ist(t))).toBe(want);
  });

  it('every in-session 15-minute cron firing runs: 25 intraday + 1 EOD per session', () => {
    const kinds: string[] = [];
    for (let h = 9; h <= 15; h++) for (const m of [0, 15, 30, 45]) kinds.push(stockChainTick(cal, ist(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)));
    expect(kinds.filter((k) => k === 'INTRADAY')).toHaveLength(25);
    expect(kinds.filter((k) => k === 'EOD')).toHaveLength(1);
  });

  it('never runs on a weekend', () => {
    expect(stockChainTick(cal, ist('10:00', '2026-10-24'))).toBe('NONE'); // Saturday
    expect(stockChainTick(cal, ist('15:30', '2026-10-25'))).toBe('NONE'); // Sunday
  });
});

describe('strike selection (nearest expiry ATM ±10)', () => {
  const strikes = Array.from({ length: 61 }, (_, i) => 1000 + i * 20); // 1000 … 2200

  it('keeps ATM plus 10 listed strikes each side', () => {
    const got = strikesAround(strikes, 1497, STOCK_STRIKES_AROUND);
    expect(got).toHaveLength(21);
    expect(got[10]).toBe(1500);
    expect(got[0]).toBe(1300);
    expect(got[20]).toBe(1700);
  });

  it('clips at the edge of the listing and handles unsorted duplicates', () => {
    const got = strikesAround([...strikes].reverse().concat(1000), 1005, STOCK_STRIKES_AROUND);
    expect(got[0]).toBe(1000);
    expect(got).toHaveLength(11);
  });

  it('empty listing → nothing', () => {
    expect(strikesAround([], 1500, STOCK_STRIKES_AROUND)).toEqual([]);
  });
});

describe('normaliseUnderlying', () => {
  it('upper-cases, trims, drops a cash suffix', () => {
    expect(normaliseUnderlying(' reliance-eq ')).toBe('RELIANCE');
    expect(normaliseUnderlying('M&M')).toBe('M&M');
    expect(normaliseUnderlying('BAJAJ-AUTO')).toBe('BAJAJ-AUTO');
    expect(normaliseUnderlying('')).toBeNull();
    expect(normaliseUnderlying(null)).toBeNull();
  });
});

describe('packBatches', () => {
  it('packs groups into ≤max batches and records which keys each carries', () => {
    const groups = [
      { key: 'A', items: Array(42).fill('a') },
      { key: 'B', items: Array(42).fill('b') },
      { key: 'C', items: Array(10).fill('c') },
    ];
    const got = packBatches(groups, 50);
    expect(got.map((b) => b.items.length)).toEqual([50, 44]);
    expect(got.map((b) => [...b.keys])).toEqual([['A', 'B'], ['B', 'C']]);
  });

  it('no groups → no batches', () => {
    expect(packBatches([], 50)).toEqual([]);
  });
});
