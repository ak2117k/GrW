import { AngelThrottleError } from '../../market-data/services/angel-throttle';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import type { ChainSnapshotRow } from '../domain/chain-snapshot';
import { parseMbmConfig } from '../mbm.config';
import { CALL_GAP_MS, QUOTE_BATCH_MAX } from './mbm-chain-capture.service';
import { MAX_ON_DEMAND_SYMBOLS, MbmStockChainCaptureService } from './mbm-stock-chain-capture.service';

const cal = new SessionClock({ holidays: MARKET_HOLIDAYS });
const TICK = '2026-10-19T04:00:55Z'; // Mon 09:30:55 IST
const EOD = '2026-10-19T10:00:55Z'; // Mon 15:30:55 IST
const ON = { MBM_CHAIN_CAPTURE_STOCKS: 'on', MBM_FEED_USER_ID: 'owner' };
const BANKNIFTY_TOKEN = '99926009';

/** name → [first strike, step, count, spot]; BADSYM has no expiry, NOCASH has no underlying row. */
const BOOK: Record<string, [number, number, number, number]> = {
  RELIANCE: [1000, 20, 61, 1497],
  TCS: [3000, 20, 51, 3511],
  INFY: [1200, 10, 61, 1480],
  BANKNIFTY: [50000, 100, 81, 54020],
  NOCASH: [100, 5, 40, 150],
};

function build(symbols: string[], opts: { nowIso?: string; env?: NodeJS.ProcessEnv } = {}) {
  const repo = {
    expiries: jest.fn(async (name: string) => (name === 'BADSYM' ? [] : ['2026-10-27', '2026-11-24'])),
    contracts: jest.fn(async (name: string, expiry: string) => {
      const [first, step, count] = BOOK[name];
      return Array.from({ length: count }, (_, i) => first + i * step).flatMap((s) => [
        { token: `${name}:${expiry}:${s}:CE`, strike: s, optionType: 'CE' as const },
        { token: `${name}:${expiry}:${s}:PE`, strike: s, optionType: 'PE' as const },
      ]);
    }),
    underlyingRef: jest.fn(async (name: string) => {
      if (name === 'NOCASH') return null;
      if (name === 'BANKNIFTY') return { exchange: 'NSE', token: BANKNIFTY_TOKEN, symbol: 'Nifty Bank' };
      return { exchange: 'NSE', token: `EQ:${name}`, symbol: `${name}-EQ` };
    }),
    strikesBefore: jest.fn().mockResolvedValue(null),
    insert: jest.fn(async (rows: ChainSnapshotRow[]) => rows.length),
  };
  const fns: Record<string, jest.Mock> = {
    fetchQuotes: jest.fn(async (_u: string, refs: Array<{ token: string }>) => {
      const m = new Map<string, { token: string; ltp: number; oi?: number; volume: number }>();
      for (const r of refs) {
        if (r.token === BANKNIFTY_TOKEN) continue; // Angel declines the index token in marketData
        if (r.token.startsWith('EQ:')) m.set(r.token, { token: r.token, ltp: BOOK[r.token.slice(3)][3], volume: 0 });
        else m.set(r.token, { token: r.token, ltp: 10, oi: 100, volume: 5 });
      }
      return m;
    }),
    fetchOptionGreeks: jest.fn().mockResolvedValue([]),
    fetchCandleWindow: jest.fn().mockResolvedValue([{ timestamp: new Date(TICK), open: 1, high: 1, low: 1, close: 54020, volume: 0 }]),
  };
  const touched: string[] = [];
  const feeds = new Proxy(fns, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      touched.push(prop);
      return () => {
        throw new Error(`unexpected UserFeedManager.${prop}`);
      };
    },
  });
  const watchlist = { symbols: jest.fn(async () => symbols.map((symbol) => ({ symbol, exchange: 'NFO' }))) };
  const sleep = jest.fn().mockResolvedValue(undefined);
  const svc = new MbmStockChainCaptureService(
    parseMbmConfig(opts.env ?? ON),
    cal,
    () => new Date(opts.nowIso ?? TICK),
    feeds as never,
    repo as never,
    watchlist,
    sleep,
  );
  const warn = jest.fn();
  (svc as unknown as { logger: { warn: jest.Mock; debug: jest.Mock } }).logger = { warn, debug: jest.fn() };
  return { svc, repo, fns, sleep, touched, watchlist, warn };
}

describe('MbmStockChainCaptureService', () => {
  it('3 stocks: 1 spot batch + 3 packed leg batches + 3 greek calls, nearest expiry ATM ±10', async () => {
    const { svc, repo, fns, sleep, touched } = build(['RELIANCE', 'TCS', 'INFY']);
    const r = await svc.onTick();
    expect(r).toMatchObject({ ran: true, tick: 'INTRADAY', stored: 3, calls: 7, captured: ['RELIANCE', 'TCS', 'INFY'], skipped: [] });

    // spots first (3 tokens), then 3 × 21 strikes × 2 sides = 126 legs → 50 + 50 + 26
    expect(fns.fetchQuotes.mock.calls.map((c) => c[1].length)).toEqual([3, 50, 50, 26]);
    for (const c of fns.fetchQuotes.mock.calls) {
      expect(c[0]).toBe('owner');
      expect(c[1].length).toBeLessThanOrEqual(QUOTE_BATCH_MAX);
      expect(c[2]).toEqual({ throwOnThrottle: true });
    }
    expect(fns.fetchOptionGreeks.mock.calls).toEqual([
      ['owner', 'RELIANCE', '2026-10-27'],
      ['owner', 'TCS', '2026-10-27'],
      ['owner', 'INFY', '2026-10-27'],
    ]);
    expect(fns.fetchCandleWindow).not.toHaveBeenCalled();
    expect(sleep.mock.calls).toEqual(Array(6).fill([CALL_GAP_MS]));
    expect(touched).toEqual([]); // no login, no subscribe — only the owner-session quote/greek reads

    const rows: ChainSnapshotRow[] = repo.insert.mock.calls[0][0];
    expect(rows.map((x) => [x.instrument, x.expiry, x.strikes.length])).toEqual([
      ['RELIANCE', '2026-10-27', 21],
      ['TCS', '2026-10-27', 21],
      ['INFY', '2026-10-27', 21],
    ]);
    expect(rows[0].strikes[10].strike).toBe(1500);
    expect(rows[0].spot).toBe(1497);
    expect(repo.contracts.mock.calls.every((c) => c[1] === '2026-10-27')).toBe(true);
  });

  it('runs the 15:30 EOD snapshot', async () => {
    const { svc } = build(['RELIANCE'], { nowIso: EOD });
    expect(await svc.onTick()).toMatchObject({ ran: true, tick: 'EOD', stored: 1 });
  });

  it('is idle when off, off-cadence or out of session — no watchlist read, no broker call', async () => {
    for (const [nowIso, env] of [
      [TICK, { MBM_FEED_USER_ID: 'owner' }],
      [TICK, { MBM_CHAIN_CAPTURE_STOCKS: 'on' }], // no owner session to use
      ['2026-10-19T04:05:55Z', ON], // 09:35
      ['2026-10-19T10:15:55Z', ON], // 15:45
      ['2026-10-24T04:00:55Z', ON], // Saturday
    ] as Array<[string, NodeJS.ProcessEnv]>) {
      const { svc, fns, watchlist } = build(['RELIANCE'], { nowIso, env });
      expect((await svc.onTick()).ran).toBe(false);
      expect(watchlist.symbols).not.toHaveBeenCalled();
      expect(fns.fetchQuotes).not.toHaveBeenCalled();
    }
  });

  it('skips an unresolvable symbol (no expiry / no underlying) and logs it once across ticks', async () => {
    const { svc, fns, warn } = build(['BADSYM', 'RELIANCE', 'NOCASH']);
    const r1 = await svc.onTick();
    expect(r1).toMatchObject({ stored: 1, captured: ['RELIANCE'], skipped: ['BADSYM', 'NOCASH'] });
    expect(fns.fetchQuotes.mock.calls[0][1]).toEqual([{ token: 'EQ:RELIANCE', exchange: 'NSE' }]);
    const r2 = await svc.onTick();
    expect(r2.skipped).toEqual(['BADSYM', 'NOCASH']);
    const skipLogs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('skipped ('));
    expect(skipLogs).toHaveLength(2);
    expect(skipLogs[0]).toContain('BADSYM');
    expect(skipLogs[1]).toContain('NOCASH');
  });

  it('a failed leg batch blanks only the symbols it carried', async () => {
    const { svc, fns, repo } = build(['RELIANCE', 'TCS', 'INFY']);
    const impl = fns.fetchQuotes.getMockImplementation()!;
    fns.fetchQuotes
      .mockImplementationOnce(impl) // spots
      .mockImplementationOnce(impl) // RELIANCE 42 + TCS 8
      .mockRejectedValueOnce(new Error('socket hang up')); // TCS 34 + INFY 16
    const r = await svc.onTick();
    expect(r).toMatchObject({ ran: true, stored: 1, captured: ['RELIANCE'] });
    expect(r.skipped.sort()).toEqual(['INFY', 'TCS']);
    expect(fns.fetchQuotes).toHaveBeenCalledTimes(4); // the last batch still ran
    expect(fns.fetchOptionGreeks.mock.calls.map((c) => c[1])).toEqual(['RELIANCE']);
    expect(repo.insert.mock.calls[0][0].map((x: ChainSnapshotRow) => x.instrument)).toEqual(['RELIANCE']);
  });

  it('a throttle stops every further broker call this tick', async () => {
    const { svc, fns } = build(['RELIANCE', 'TCS', 'INFY']);
    const impl = fns.fetchQuotes.getMockImplementation()!;
    fns.fetchQuotes.mockImplementationOnce(impl).mockRejectedValueOnce(new AngelThrottleError('AB1004'));
    const r = await svc.onTick();
    expect(r).toMatchObject({ ran: true, stored: 0, calls: 2, captured: [] });
    expect(fns.fetchOptionGreeks).not.toHaveBeenCalled();
  });

  it('a failed greek call only blanks IV/Greeks', async () => {
    const { svc, fns, repo } = build(['RELIANCE', 'TCS']);
    fns.fetchOptionGreeks.mockRejectedValueOnce(new Error('greeks down'));
    const r = await svc.onTick();
    expect(r).toMatchObject({ stored: 2, captured: ['RELIANCE', 'TCS'] });
    const rows: ChainSnapshotRow[] = repo.insert.mock.calls[0][0];
    expect(rows[0].strikes[10].ce?.iv).toBeNull();
    expect(rows[0].strikes[10].ce?.oi).toBe(100);
  });

  it('a non-NIFTY index whose quote has no LTP is centred by one 1m candle call', async () => {
    const { svc, fns, repo } = build(['BANKNIFTY']);
    const r = await svc.onTick();
    expect(r).toMatchObject({ stored: 1, captured: ['BANKNIFTY'], calls: 4 }); // spot + candle + 42 legs + greeks
    expect(fns.fetchCandleWindow.mock.calls[0][1]).toEqual({ token: BANKNIFTY_TOKEN, exchange: 'NSE' });
    expect(repo.insert.mock.calls[0][0][0].strikes[10].strike).toBe(54000);
  });

  it('a stock with no spot quote is skipped, the rest captured', async () => {
    const { svc, fns } = build(['RELIANCE', 'TCS']);
    fns.fetchQuotes.mockImplementationOnce(async () => new Map([['EQ:TCS', { token: 'EQ:TCS', ltp: 3511, volume: 0 }]]));
    const r = await svc.onTick();
    expect(r).toMatchObject({ stored: 1, captured: ['TCS'], skipped: ['RELIANCE'] });
    expect(fns.fetchCandleWindow).not.toHaveBeenCalled(); // only indices fall back to a candle
  });

  it('an empty watchlist makes no broker call', async () => {
    const { svc, fns } = build([]);
    expect(await svc.onTick()).toMatchObject({ ran: true, stored: 0, calls: 0 });
    expect(fns.fetchQuotes).not.toHaveBeenCalled();
  });

  describe('captureNow(symbols): on-demand capture of given symbols (news-idea candidates)', () => {
    const NIGHT = '2026-10-19T18:00:00Z'; // 23:30 IST, out of session

    it('captures exactly those symbols (normalised, de-duplicated, NIFTY excluded), not the watchlist', async () => {
      const { svc, watchlist } = build(['RELIANCE'], { nowIso: NIGHT });
      const r = await svc.captureNow(['tcs-EQ', 'TCS', 'NIFTY', 'INFY']);
      expect(r).toMatchObject({ ran: true, stored: 2, captured: ['TCS', 'INFY'], skipped: [] });
      expect(watchlist.symbols).not.toHaveBeenCalled();
    });

    it('caps the list at MAX_ON_DEMAND_SYMBOLS', async () => {
      const { svc, repo } = build([], { nowIso: NIGHT });
      const many = Array.from({ length: MAX_ON_DEMAND_SYMBOLS + 5 }, (_, i) => `BADSYM${i}`);
      await svc.captureNow(many);
      expect(repo.expiries).toHaveBeenCalledTimes(MAX_ON_DEMAND_SYMBOLS);
    });

    it('same flag rule: off ⇒ idle, no broker call; an empty list ⇒ idle', async () => {
      const off = build([], { nowIso: NIGHT, env: {} });
      expect(await off.svc.captureNow(['TCS'])).toMatchObject({ ran: false });
      expect(off.fns.fetchQuotes).not.toHaveBeenCalled();
      const on = build([], { nowIso: NIGHT });
      expect(await on.svc.captureNow(['NIFTY'])).toMatchObject({ ran: false });
      expect(on.fns.fetchQuotes).not.toHaveBeenCalled();
    });

    it('no argument keeps the watchlist behaviour', async () => {
      const { svc, watchlist } = build(['RELIANCE'], { nowIso: NIGHT });
      expect(await svc.captureNow()).toMatchObject({ ran: true, captured: ['RELIANCE'] });
      expect(watchlist.symbols).toHaveBeenCalled();
    });
  });
});
