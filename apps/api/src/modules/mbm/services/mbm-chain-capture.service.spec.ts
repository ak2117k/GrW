import { readFileSync } from 'fs';
import { join } from 'path';
import { AngelThrottleError } from '../../market-data/services/angel-throttle';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { SessionClock } from '../../market-hub/session-clock';
import type { ChainSnapshotRow } from '../domain/chain-snapshot';
import { parseMbmConfig } from '../mbm.config';
import { CALL_GAP_MS, MbmChainCaptureService, QUOTE_BATCH_MAX } from './mbm-chain-capture.service';

const cal = new SessionClock({ holidays: MARKET_HOLIDAYS });
const TICK = '2026-10-19T04:00:40Z'; // Mon 09:30:40 IST
const EXPIRIES = ['2026-10-20', '2026-10-27', '2026-11-03'];
const STRIKES = Array.from({ length: 81 }, (_, i) => 23000 + i * 50); // 23000 … 27000
const INDEX_TOKEN = '99926000';
const ON = { MBM_CHAIN_CAPTURE: 'on', MBM_FEED_USER_ID: 'owner', MBM_CHAIN_CAPTURE_INSTRUMENTS: 'NIFTY' };

const contractsOf = (expiry: string) =>
  STRIKES.flatMap((s) => [
    { token: `${expiry}:${s}:CE`, strike: s, optionType: 'CE' as const },
    { token: `${expiry}:${s}:PE`, strike: s, optionType: 'PE' as const },
  ]);

function build(nowIso = TICK, env: NodeJS.ProcessEnv = ON) {
  const repo = {
    expiries: jest.fn().mockResolvedValue(EXPIRIES),
    contracts: jest.fn(async (_n: string, e: string) => contractsOf(e)),
    latestClose: jest.fn().mockResolvedValue(25012),
    insert: jest.fn(async (rows: ChainSnapshotRow[]) => rows.length),
    strikesBefore: jest.fn().mockResolvedValue(null),
    nearestFutureToken: jest.fn().mockResolvedValue(null),
    captureCounts: jest.fn().mockResolvedValue([]),
  };
  const quoteFn = jest.fn(async (_u: string, refs: Array<{ token: string }>) => {
    const m = new Map<string, { token: string; ltp: number; oi?: number; volume: number }>();
    for (const r of refs) {
      m.set(r.token, r.token === INDEX_TOKEN ? { token: r.token, ltp: 25020, volume: 0 } : { token: r.token, ltp: 50, oi: 1000, volume: 5 });
    }
    return m;
  });
  const fns: Record<string, jest.Mock> = {
    fetchQuotes: quoteFn,
    fetchOptionGreeks: jest.fn().mockResolvedValue([{ strike: 25000, optionType: 'CE', iv: 11, delta: 0.5, gamma: 0.001, theta: -8, vega: 10 }]),
    fetchCandleWindow: jest.fn().mockResolvedValue([{ timestamp: new Date('2026-10-19T03:59:00Z'), open: 1, high: 1, low: 1, close: 25012, volume: 0 }]),
  };
  // Every OTHER UserFeedManager member (subscribe, reloginUser, warmRestClient, …) is recorded and fails the test.
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
  const sleep = jest.fn().mockResolvedValue(undefined);
  const svc = new MbmChainCaptureService(parseMbmConfig(env), cal, () => new Date(nowIso), feeds as never, repo as never, sleep);
  return { svc, repo, fns, sleep, touched };
}

describe('MbmChainCaptureService', () => {
  it('captures the nearest two expiries × ATM ±15 strikes in 3 quote batches + 2 greek calls', async () => {
    const { svc, repo, fns, sleep, touched } = build();
    const r = await svc.onTick();
    expect(r).toEqual({ ran: true, stored: 2, calls: 5 });
    expect(repo.contracts.mock.calls.map((c) => c[1])).toEqual(['2026-10-20', '2026-10-27']);

    // 1 index + 2 × 31 strikes × 2 sides = 125 tokens → 50 + 50 + 25.
    expect(fns.fetchQuotes.mock.calls.map((c) => c[1].length)).toEqual([50, 50, 25]);
    for (const c of fns.fetchQuotes.mock.calls) {
      expect(c[0]).toBe('owner');
      expect(c[1].length).toBeLessThanOrEqual(QUOTE_BATCH_MAX);
      expect(c[2]).toEqual({ throwOnThrottle: true });
    }
    expect(fns.fetchQuotes.mock.calls[0][1][0]).toEqual({ token: INDEX_TOKEN, exchange: 'NSE' });
    expect(fns.fetchOptionGreeks.mock.calls).toEqual([['owner', 'NIFTY', '2026-10-20'], ['owner', 'NIFTY', '2026-10-27']]);
    expect(fns.fetchCandleWindow).not.toHaveBeenCalled(); // the stored 1m close centred the window
    expect(sleep.mock.calls).toEqual(Array(4).fill([CALL_GAP_MS]));
    expect(touched).toEqual([]);

    const rows: ChainSnapshotRow[] = repo.insert.mock.calls[0][0];
    expect(rows.map((x) => x.expiry)).toEqual(['2026-10-20', '2026-10-27']);
    for (const x of rows) {
      expect(x.instrument).toBe('NIFTY');
      expect(x.spot).toBe(25020); // the index quote, when Angel gives one
      expect(x.capturedAt).toEqual(new Date('2026-10-19T04:00:40Z'));
      expect(x.strikes).toHaveLength(31);
      expect(x.strikes[0].strike).toBe(24250);
      expect(x.strikes[30].strike).toBe(25750);
      expect(x.pcr).toBe(1);
    }
    expect(rows[0].strikes[15].ce).toMatchObject({ ltp: 50, oi: 1000, vol: 5, iv: 11, delta: 0.5 });
  });

  it('without a fresh stored bar the window is centred by ONE index 1m candle call; spot falls back to it', async () => {
    const { svc, repo, fns } = build();
    repo.latestClose.mockResolvedValue(null);
    fns.fetchQuotes.mockImplementation(async (_u: string, refs: Array<{ token: string }>) =>
      new Map(refs.filter((x) => x.token !== INDEX_TOKEN).map((x) => [x.token, { token: x.token, ltp: 50, oi: 10, volume: 1 }])),
    ); // Angel declines the index token
    const r = await svc.onTick();
    expect(r).toMatchObject({ ran: true, stored: 2, calls: 6 });
    expect(fns.fetchCandleWindow).toHaveBeenCalledTimes(1);
    expect(fns.fetchCandleWindow.mock.calls[0].slice(0, 3)).toEqual(['owner', { token: INDEX_TOKEN, exchange: 'NSE' }, 'ONE_MINUTE']);
    expect(repo.insert.mock.calls[0][0][0].spot).toBe(25012);
  });

  it('runs only with MBM_CHAIN_CAPTURE=on, a feed user, inside 09:15–15:30 IST on trading days', async () => {
    for (const iso of ['2026-10-20T05:00:40Z', '2026-10-18T05:00:40Z', '2026-10-19T10:05:40Z', '2026-10-19T03:40:40Z']) {
      const { svc, fns } = build(iso);
      expect((await svc.onTick()).ran).toBe(false);
      expect(fns.fetchQuotes).not.toHaveBeenCalled();
    }
    for (const env of [{ MBM_FEED_USER_ID: 'owner' }, { MBM_CHAIN_CAPTURE: 'on' }, { MBM_CHAIN_CAPTURE: 'off', MBM_ENABLED: 'observe', MBM_FEED_USER_ID: 'owner' }]) {
      const { svc, repo } = build(TICK, env);
      expect((await svc.onTick()).ran).toBe(false);
      expect(repo.expiries).not.toHaveBeenCalled();
    }
    expect((await build('2026-10-19T10:00:40Z').svc.onTick()).ran).toBe(true); // 15:30:40 IST, last tick
    expect((await build(TICK, { ...ON, MBM_ENABLED: 'off' }).svc.onTick()).stored).toBe(2); // independent of MBM_ENABLED
  });

  it('a throttled quote batch skips the whole tick (logged, nothing stored, never throws); the next tick runs', async () => {
    const { svc, repo, fns } = build();
    fns.fetchQuotes.mockImplementationOnce(fns.fetchQuotes.getMockImplementation()!).mockRejectedValueOnce(new AngelThrottleError('AB1004'));
    const r = await svc.onTick();
    expect(r).toMatchObject({ ran: true, stored: 0, error: 'AB1004' });
    expect(repo.insert).not.toHaveBeenCalled();
    expect(fns.fetchOptionGreeks).not.toHaveBeenCalled();
    expect((await svc.onTick()).stored).toBe(2);
  });

  it('isolates every other failure: greeks blank only IV/Greeks; DB, master and spot failures skip the tick', async () => {
    const g = build();
    g.fns.fetchOptionGreeks.mockRejectedValue(new Error('greeks down'));
    expect((await g.svc.onTick()).stored).toBe(2);
    expect(g.repo.insert.mock.calls[0][0][0].strikes[15].ce).toMatchObject({ oi: 1000, iv: null, delta: null });

    const db = build();
    db.repo.insert.mockRejectedValue(new Error('db down'));
    await expect(db.svc.onTick()).resolves.toMatchObject({ ran: true, stored: 0, error: 'db down' });

    const none = build();
    none.repo.expiries.mockResolvedValue([]);
    await expect(none.svc.onTick()).resolves.toMatchObject({ stored: 0, calls: 0 });
    expect(none.fns.fetchQuotes).not.toHaveBeenCalled();

    const noSpot = build();
    noSpot.repo.latestClose.mockResolvedValue(null);
    noSpot.fns.fetchCandleWindow.mockResolvedValue([]);
    await expect(noSpot.svc.onTick()).resolves.toMatchObject({ stored: 0, error: expect.stringMatching(/no NIFTY spot/) });
    expect(noSpot.fns.fetchQuotes).not.toHaveBeenCalled();
  });

  it('oi_chg is against the previous session’s last snapshot, read once per expiry per day', async () => {
    const { svc, repo } = build();
    repo.strikesBefore.mockResolvedValue([{ strike: 25000, ce: { oi: 400 }, pe: { oi: 1500 } }]);
    await svc.onTick();
    await svc.onTick();
    expect(repo.strikesBefore).toHaveBeenCalledTimes(2); // 2 expiries, not re-read on the second tick
    expect(repo.strikesBefore.mock.calls[0]).toEqual(['NIFTY', '2026-10-20', new Date('2026-10-18T18:30:00Z')]);
    const atm = repo.insert.mock.calls[0][0][0].strikes[15];
    expect(atm.ce?.oi_chg).toBe(600);
    expect(atm.pe?.oi_chg).toBe(-500);
    expect(repo.insert.mock.calls[0][0][0].strikes[14].ce?.oi_chg).toBeNull();
  });

  it('does not overlap a tick that is still pacing through', async () => {
    const { svc, fns } = build();
    let release!: () => void;
    const impl = fns.fetchQuotes.getMockImplementation()!;
    fns.fetchQuotes.mockImplementationOnce((...a: unknown[]) => new Promise((res) => (release = () => res(impl(...(a as [string, never[]]))))));
    const first = svc.onTick();
    await new Promise((r) => setImmediate(r));
    expect((await svc.onTick()).ran).toBe(false);
    release();
    expect((await first).stored).toBe(2);
  });

  it('NIFTY + BANKNIFTY: the future rides in the quote batches (no extra call), each instrument stored with fut', async () => {
    const { svc, repo, fns } = build(TICK, { ...ON, MBM_CHAIN_CAPTURE_INSTRUMENTS: 'NIFTY,BANKNIFTY' });
    repo.nearestFutureToken.mockImplementation(async (n: string) => `${n}-FUT`);
    const impl = fns.fetchQuotes.getMockImplementation()!;
    fns.fetchQuotes.mockImplementation(async (u: string, refs: Array<{ token: string }>) => {
      const m = (await impl(u, refs)) as Map<string, { token: string; ltp: number; volume: number }>;
      for (const r of refs) if (r.token.endsWith('-FUT')) m.set(r.token, { token: r.token, ltp: 25100, volume: 9 });
      return m;
    });
    const r = await svc.onTick();
    // per instrument: 1 index + 1 future + 124 legs = 126 tokens → 3 batches; + 2 greek calls.
    expect(r).toEqual({ ran: true, stored: 4, calls: 10 });
    expect(fns.fetchQuotes.mock.calls.map((c) => c[1].length)).toEqual([50, 50, 26, 50, 50, 26]);
    expect(fns.fetchQuotes.mock.calls[0][1][1]).toEqual({ token: 'NIFTY-FUT', exchange: 'NFO' });
    expect(fns.fetchQuotes.mock.calls[3][1][0]).toEqual({ token: '99926009', exchange: 'NSE' });
    expect(fns.fetchOptionGreeks.mock.calls.map((c) => c[1])).toEqual(['NIFTY', 'NIFTY', 'BANKNIFTY', 'BANKNIFTY']);
    const rows: ChainSnapshotRow[] = repo.insert.mock.calls.flatMap((c) => c[0]);
    expect(rows.map((x) => [x.instrument, x.fut])).toEqual([['NIFTY', 25100], ['NIFTY', 25100], ['BANKNIFTY', 25100], ['BANKNIFTY', 25100]]);
    await svc.onTick();
    expect(repo.nearestFutureToken).toHaveBeenCalledTimes(2); // once per instrument per day
  });

  it('one instrument failing does not cost the other; a throttle leaves the rest of the tick', async () => {
    const both = { ...ON, MBM_CHAIN_CAPTURE_INSTRUMENTS: 'NIFTY,BANKNIFTY' };
    const a = build(TICK, both);
    a.repo.expiries.mockImplementation(async (n: string) => (n === 'NIFTY' ? [] : EXPIRIES));
    const ra = await a.svc.onTick();
    expect(ra).toMatchObject({ ran: true, stored: 2, error: 'no NIFTY option expiries in the instrument master' });

    const b = build(TICK, both);
    b.fns.fetchQuotes.mockRejectedValueOnce(new AngelThrottleError('AB1004'));
    expect(await b.svc.onTick()).toMatchObject({ stored: 0, calls: 1, error: 'AB1004' });
    expect(b.fns.fetchQuotes).toHaveBeenCalledTimes(1);
  });

  it('day summary: ticks stored vs 76 per instrument, WARN when short, never throws', async () => {
    const { svc, repo } = build('2026-10-19T10:10:00Z', { ...ON, MBM_CHAIN_CAPTURE_INSTRUMENTS: 'NIFTY,BANKNIFTY' }); // 15:40 IST
    repo.captureCounts.mockResolvedValue([{ instrument: 'NIFTY', ticks: 76, rows: 152, newest: new Date() }]);
    const lines = await svc.daySummary();
    expect(repo.captureCounts.mock.calls[0]).toEqual([new Date('2026-10-18T18:30:00Z'), new Date('2026-10-19T18:30:00Z')]);
    expect(lines).toEqual([
      '[mbm] chain capture 2026-10-19 NIFTY: 76/76 ticks, 152 rows stored (this process: 0 ok, 0 failed)',
      '[mbm] chain capture 2026-10-19 BANKNIFTY: 0/76 ticks, 0 rows stored (this process: 0 ok, 0 failed)',
    ]);
    repo.captureCounts.mockRejectedValue(new Error('db down'));
    await expect(svc.daySummary()).resolves.toEqual([]);
    expect(await build('2026-10-18T10:10:00Z').svc.daySummary()).toEqual([]); // Sunday
    expect(await build('2026-10-19T10:10:00Z', { MBM_FEED_USER_ID: 'owner' }).svc.daySummary()).toEqual([]); // capture off
  });

  it('never logs in: only the per-user fetch methods are used, and the source has no login path', () => {
    const src = readFileSync(join(__dirname, 'mbm-chain-capture.service.ts'), 'utf8');
    for (const banned of ['withAngelLogin', 'generateSession', 'SmartAPI', 'smartapi', 'reloginUser', 'relogin(', 'AngelOneAdapter', 'BrokerCredential']) {
      expect(src).not.toContain(banned);
    }
    const used = [...src.matchAll(/this\.feeds\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(used)].sort()).toEqual(['fetchCandleWindow', 'fetchOptionGreeks', 'fetchQuotes']);
  });
});
