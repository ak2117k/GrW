import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import {
  atmStrike,
  baselineFrom,
  buildChainSnapshot,
  isChainCaptureTick,
  maxPain,
  pcrByOi,
  strikesAround,
  wall,
  type CaptureContract,
  type ChainLeg,
  type ChainStrikeRow,
} from './chain-snapshot';

const cal = new SessionClock({ holidays: MARKET_HOLIDAYS });
const leg = (oi: number): ChainLeg => ({ ltp: 1, oi, oi_chg: null, vol: 0, iv: null, delta: null, gamma: null, theta: null, vega: null });
const row = (strike: number, ceOi: number, peOi: number): ChainStrikeRow => ({ strike, ce: leg(ceOi), pe: leg(peOi) });
const STRIKES = Array.from({ length: 41 }, (_, i) => 24000 + i * 50); // 24000 … 26000

describe('isChainCaptureTick', () => {
  it('runs 09:15–15:30 IST on NSE trading days only', () => {
    expect(isChainCaptureTick(cal, new Date('2026-10-19T03:45:40Z'))).toBe(true); // Mon 09:15:40
    expect(isChainCaptureTick(cal, new Date('2026-10-19T10:00:40Z'))).toBe(true); // 15:30:40
    expect(isChainCaptureTick(cal, new Date('2026-10-19T03:40:40Z'))).toBe(false); // 09:10:40
    expect(isChainCaptureTick(cal, new Date('2026-10-19T10:05:40Z'))).toBe(false); // 15:35:40
    expect(isChainCaptureTick(cal, new Date('2026-10-18T05:00:40Z'))).toBe(false); // Sunday
    expect(isChainCaptureTick(cal, new Date('2026-10-20T05:00:40Z'))).toBe(false); // Dussehra holiday
  });
});

describe('ATM and the ±15 strike window', () => {
  it('ATM is the nearest listed strike, the lower one on a tie', () => {
    expect(atmStrike(STRIKES, 25012)).toBe(25000);
    expect(atmStrike(STRIKES, 25038)).toBe(25050);
    expect(atmStrike(STRIKES, 25025)).toBe(25000);
    expect(atmStrike([], 25000)).toBeNull();
  });

  it('keeps ATM ±15 strikes (31), unsorted / duplicated input included', () => {
    const s = strikesAround([...STRIKES].reverse().concat(STRIKES), 25012);
    expect(s).toHaveLength(31);
    expect(s[0]).toBe(24250);
    expect(s[15]).toBe(25000);
    expect(s[30]).toBe(25750);
  });

  it('clips at the edge of the listing', () => {
    const s = strikesAround(STRIKES, 24010);
    expect(s[0]).toBe(24000);
    expect(s).toHaveLength(16);
  });
});

describe('PCR, max pain and the walls', () => {
  const rows = [row(100, 0, 30), row(200, 10, 10), row(300, 50, 0)];

  it('PCR is Σ PE OI / Σ CE OI', () => {
    expect(pcrByOi(rows)).toBeCloseTo(40 / 60);
    expect(pcrByOi([row(100, 0, 5)])).toBeNull();
  });

  it('max pain minimises the holders’ payout at expiry', () => {
    // K=100: PE 10·100 = 1000 · K=200: 0 · K=300: CE 10·100 = 1000
    expect(maxPain(rows)).toBe(200);
    expect(maxPain([row(100, 0, 0)])).toBeNull();
  });

  it('call wall = max CE OI strike, put wall = max PE OI strike', () => {
    expect(wall(rows, 'ce')).toBe(300);
    expect(wall(rows, 'pe')).toBe(100);
    expect(wall([row(100, 0, 0)], 'ce')).toBeNull();
  });
});

describe('buildChainSnapshot', () => {
  const contracts: CaptureContract[] = [];
  for (const s of strikesAround(STRIKES, 25012)) {
    contracts.push({ token: `c${s}`, strike: s, optionType: 'CE' }, { token: `p${s}`, strike: s, optionType: 'PE' });
  }
  // CE OI peaks at 25500, PE OI at 24500; everything quoted except the 25750 PE.
  const quotes = new Map(
    contracts
      .filter((c) => c.token !== 'p25750')
      .map((c) => {
        const peak = c.optionType === 'CE' ? 25500 : 24500;
        return [c.token, { ltp: 10, oi: 1000 + (c.strike === peak ? 9000 : 0), volume: 7 }] as const;
      }),
  );

  it('builds 31 ascending rows with walls, PCR, max pain, greeks and oi_chg', () => {
    const snap = buildChainSnapshot({
      instrument: 'NIFTY',
      expiry: '2026-10-27',
      capturedAt: new Date('2026-10-19T04:00:41Z'),
      spot: 25012,
      contracts,
      quotes,
      greeks: [{ strike: 25000, optionType: 'CE', iv: 12.5, delta: 0.52, gamma: 0.001, theta: -9, vega: 12 }],
      baseline: new Map([['25000:CE', 800]]),
    });
    expect(snap.strikes).toHaveLength(31);
    expect(snap.strikes.map((r) => r.strike)).toEqual([...snap.strikes.map((r) => r.strike)].sort((a, b) => a - b));
    expect(snap.callWall).toBe(25500);
    expect(snap.putWall).toBe(24500);
    expect(snap.pcr).toBeCloseTo((30 * 1000 + 9000) / (31 * 1000 + 9000));
    expect(snap.maxPain).not.toBeNull();
    const atm = snap.strikes[15];
    expect(atm.strike).toBe(25000);
    expect(atm.ce).toEqual({ ltp: 10, oi: 1000, oi_chg: 200, vol: 7, iv: 12.5, delta: 0.52, gamma: 0.001, theta: -9, vega: 12 });
    expect(atm.pe).toMatchObject({ oi_chg: null, iv: null, delta: null });
    expect(snap.strikes[30].pe).toBeNull(); // not quoted
  });

  it('baselineFrom maps a stored snapshot to strike:side → OI', () => {
    const b = baselineFrom([row(25000, 5, 6), { strike: 25050, ce: null, pe: leg(9) }]);
    expect([...b.entries()]).toEqual([['25000:CE', 5], ['25000:PE', 6], ['25050:PE', 9]]);
    expect(baselineFrom(null).size).toBe(0);
  });
});
