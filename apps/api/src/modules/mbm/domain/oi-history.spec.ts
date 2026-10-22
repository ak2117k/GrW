import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { mapOiRows } from '../../market-data/services/oi-data.util';
import { SessionClock } from '../../market-hub/session-clock';
import {
  inBlackout,
  lastCompletedSession,
  parseOiHistoryConfig,
  selectContracts,
  sessionsIn,
  windowCovered,
  type OiContract,
} from './oi-history';

const cal = new SessionClock({ holidays: MARKET_HOLIDAYS });

const opt = (expiry: string, strike: number, kind: 'CE' | 'PE'): OiContract => ({ token: `${expiry}-${strike}-${kind}`, symbol: `N${strike}${kind}`, kind, expiry, strike });

describe('oi-history domain', () => {
  it('config: on by default, OI_BACKFILL_ENABLED=off disables, numbers clamp', () => {
    const d = parseOiHistoryConfig({});
    expect(d).toMatchObject({ enabled: true, maxCalls: 2000, strikesAround: 10, maxChunkDays: 30 });
    expect(parseOiHistoryConfig({ OI_BACKFILL_ENABLED: 'off' }).enabled).toBe(false);
    expect(parseOiHistoryConfig({ OI_BACKFILL_MAX_CALLS: '0', OI_BACKFILL_CHUNK_DAYS: 'x' })).toMatchObject({ maxCalls: 1, maxChunkDays: 30 });
  });

  it('blackout: 08:30–15:45 IST on NSE trading days only (holiday-aware)', () => {
    expect(inBlackout(cal, new Date('2026-10-22T05:00:00Z'))).toBe(true); // Thu 10:30 IST
    expect(inBlackout(cal, new Date('2026-10-22T03:00:00Z'))).toBe(true); // 08:30 IST
    expect(inBlackout(cal, new Date('2026-10-22T02:59:00Z'))).toBe(false); // 08:29 IST
    expect(inBlackout(cal, new Date('2026-10-22T10:15:00Z'))).toBe(false); // 15:45 IST
    expect(inBlackout(cal, new Date('2026-10-20T05:00:00Z'))).toBe(false); // Dussehra holiday
    expect(inBlackout(cal, new Date('2026-10-24T05:00:00Z'))).toBe(false); // Saturday
  });

  it('sessionsIn counts overlapping NSE sessions, skipping weekends and holidays', () => {
    // Fri 16 Oct 16:00 IST → Fri 23 Oct 01:30 IST: Mon 19, Wed 21, Thu 22 (Tue 20 = Dussehra).
    expect(sessionsIn(cal, new Date('2026-10-16T10:30:00Z'), new Date('2026-10-22T20:00:00Z'))).toEqual(['2026-10-19', '2026-10-21', '2026-10-22']);
    expect(sessionsIn(cal, new Date('2026-10-23T20:00:00Z'), new Date('2026-10-25T20:00:00Z'))).toEqual([]); // the weekend
  });

  it('lastCompletedSession is the newest closed session', () => {
    expect(lastCompletedSession(cal, new Date('2026-10-23T20:00:00Z'))?.day).toBe('2026-10-23'); // Sat 01:30 IST
    const s = lastCompletedSession(cal, new Date('2026-10-23T05:00:00Z')); // Fri 10:30 IST → Thu
    expect(s).toEqual({ day: '2026-10-22', from: new Date('2026-10-22T03:45:00Z'), to: new Date('2026-10-22T10:00:00Z') });
  });

  it('windowCovered tolerates one missing session only', () => {
    expect(windowCovered(21, 21)).toBe(true);
    expect(windowCovered(21, 20)).toBe(true);
    expect(windowCovered(21, 1)).toBe(false);
    expect(windowCovered(0, 0)).toBe(false);
  });

  it('selectContracts: futures first, strikes from ATM(low)−n to ATM(high)+n, nearest-ATM first, capped', () => {
    const strikes = Array.from({ length: 41 }, (_, i) => 24000 + i * 50); // 24000..26000
    const options = new Map<string, OiContract[]>([
      ['2026-10-27', strikes.flatMap((s) => [opt('2026-10-27', s, 'CE'), opt('2026-10-27', s, 'PE')])],
    ]);
    const fut: OiContract = { token: 'F1', symbol: 'NIFTY26OCTFUT', kind: 'FUT', expiry: '2026-10-27', strike: null };
    const all = selectContracts({ futures: [fut], options, low: 24800, high: 25000, last: 24900, strikesAround: 2, maxContracts: 100 });
    const ks = [...new Set(all.contracts.filter((c) => c.kind === 'CE').map((c) => c.strike))].sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(ks).toEqual([24700, 24750, 24800, 24850, 24900, 24950, 25000, 25050, 25100]);
    expect(all.contracts[0]).toBe(fut);
    expect(all.contracts[1]).toMatchObject({ strike: 24900, kind: 'CE' });
    expect(all.capped).toBe(0);
    const capped = selectContracts({ futures: [fut], options, low: 24800, high: 25000, last: 24900, strikesAround: 2, maxContracts: 5 });
    expect(capped.contracts).toHaveLength(5);
    expect(capped.capped).toBe(18 - 4);
    expect(capped.contracts.slice(1).every((c) => Math.abs((c.strike ?? 0) - 24900) <= 50)).toBe(true);
  });

  it('mapOiRows accepts {time, oi} objects and [time, oi] arrays, drops junk', () => {
    expect(
      mapOiRows([{ time: '2026-10-22T09:15:00+05:30', oi: 10 }, ['2026-10-22T09:16:00+05:30', 11], { time: 'bad', oi: 1 }, { time: '2026-10-22T09:17:00+05:30', oi: null }]),
    ).toEqual([
      { ts: new Date('2026-10-22T03:45:00Z'), oi: 10 },
      { ts: new Date('2026-10-22T03:46:00Z'), oi: 11 },
    ]);
    expect(mapOiRows(null)).toEqual([]);
  });
});
