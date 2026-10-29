import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import { LANE, refKey, type InstrumentRef } from '../hub.types';
import type { QuoteOutcome } from '../quote-batcher';
import { SessionClock } from '../session-clock';
import { MemoryChainRepo } from '../testing/memory-chain-repo';
import type { FutureContract } from './chain.types';
import { FUTURES_CALL_GAP_MS, FUTURES_QUOTE_MAX, FuturesOiJob, futuresRows, selectFutures, type FuturesOiJobDeps } from './futures-oi-job';

const IST = (local: string) => Date.parse(`${local}Z`) - 5.5 * 3600_000;
const fut = (name: string, expiry: string, token = `${name}-${expiry}`): FutureContract => ({
  instrumentId: `i-${token}`,
  ref: { exchange: 'NFO', token, symbol: `${name}${expiry}FUT` },
  name,
  expiry,
});
const tick = (token: string, over: Partial<TickData> = {}): TickData => ({
  token, symbol: '', ltp: 100, open: 0, high: 0, low: 0, close: 0, volume: 7, oi: 1000, timestamp: new Date(), ...over,
});
const ok = (t: TickData): QuoteOutcome => ({ kind: 'ok', tick: t });

describe('selectFutures', () => {
  it('keeps each name’s nearest future; on its expiry day also the next; never an expired one', () => {
    const rows = [
      fut('RELIANCE', '2026-11-24'), fut('RELIANCE', '2026-10-27'), fut('RELIANCE', '2026-12-29'),
      fut('TCS', '2026-10-27'), fut('TCS', '2026-11-24'),
      fut('OLD', '2026-09-29'),
    ];
    expect(selectFutures(rows, '2026-10-12').map((f) => `${f.name}:${f.expiry}`)).toEqual(['RELIANCE:2026-10-27', 'TCS:2026-10-27']);
    expect(selectFutures(rows, '2026-10-27').map((f) => `${f.name}:${f.expiry}`)).toEqual([
      'RELIANCE:2026-10-27', 'RELIANCE:2026-11-24', 'TCS:2026-10-27', 'TCS:2026-11-24',
    ]);
  });
});

describe('futuresRows', () => {
  const at = new Date(IST('2026-10-12T10:00:00'));
  const a = fut('A', '2026-10-27', 'TA');
  const b = fut('B', '2026-10-27', 'TB');
  const c = fut('C', '2026-10-27', 'TC');
  const d = fut('D', '2026-10-27', 'TD');

  it('maps OI, change vs baseline (null without one), volume and LTP; anything without an OI is missing', () => {
    const quotes = new Map<string, QuoteOutcome>([
      [refKey(a.ref), ok(tick('TA', { oi: 1500, ltp: 2450.5, volume: 900 }))],
      [refKey(b.ref), ok(tick('TB', { oi: 800, ltp: 0, volume: Number.NaN }))],
      [refKey(c.ref), ok(tick('TC', { oi: undefined }))],
      // D: no entry at all (the SDK's empty answer)
    ]);
    const { rows, missing } = futuresRows([a, b, c, d], quotes, new Map([[a.instrumentId, 1200]]), at);
    expect(rows).toEqual([
      { instrumentId: a.instrumentId, oi: 1500, oiChange: 300, volume: 900, ltp: 2450.5, at },
      { instrumentId: b.instrumentId, oi: 800, oiChange: null, volume: 0, ltp: null, at },
    ]);
    expect(missing).toBe(2);
  });

  it('a throttled / busy / errored outcome is missing, never a row', () => {
    const quotes = new Map<string, QuoteOutcome>([
      [refKey(a.ref), { kind: 'throttled', retryAfterMs: 1000 }],
      [refKey(b.ref), { kind: 'busy' }],
      [refKey(c.ref), { kind: 'error', error: new Error('x') }],
    ]);
    expect(futuresRows([a, b, c], quotes, new Map(), at)).toEqual({ rows: [], missing: 3 });
  });
});

describe('FuturesOiJob', () => {
  const OPEN = IST('2026-10-12T10:00:00');

  function job(contracts: FutureContract[], over: Partial<FuturesOiJobDeps> = {}) {
    const repo = new MemoryChainRepo();
    const calls: Array<{ refs: InstrumentRef[]; lane: number }> = [];
    const sleeps: number[] = [];
    const futures = jest.fn(async () => contracts);
    const baseline = jest.spyOn(repo, 'baseline');
    let now = OPEN;
    const log = jest.fn();
    const j = new FuturesOiJob({
      repo: { futures, baseline: (i, b) => repo.baseline(i, b), writeOi: (r) => repo.writeOi(r) },
      quoteNow: async (refs, lane) => {
        calls.push({ refs: [...refs], lane });
        return new Map(refs.map((r) => [refKey(r), ok(tick(r.token))] as const));
      },
      clock: new SessionClock({ holidays: MARKET_HOLIDAYS }),
      log,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...over,
    });
    return { j, repo, calls, sleeps, futures, baseline, log, set: (t: number) => (now = t) };
  }

  const many = (n: number) => Array.from({ length: n }, (_, i) => fut(`S${i}`, '2026-10-27', `T${i}`));

  it('quotes ~215 futures in ≤ 50-token Routine calls spaced apart, and writes one row each', async () => {
    const h = job(many(215));
    await h.j.tick(OPEN);
    expect(h.calls.map((c) => c.refs.length)).toEqual([50, 50, 50, 50, 15]);
    expect(h.calls.every((c) => c.lane === LANE.ROUTINE)).toBe(true);
    expect(Math.max(...h.calls.map((c) => c.refs.length))).toBeLessThanOrEqual(FUTURES_QUOTE_MAX);
    expect(h.sleeps).toEqual([FUTURES_CALL_GAP_MS, FUTURES_CALL_GAP_MS, FUTURES_CALL_GAP_MS, FUTURES_CALL_GAP_MS]);
    expect(h.repo.oiRows).toHaveLength(215);
    expect(h.j.status(OPEN)).toEqual({ enabled: true, contracts: 215, rowsToday: 215, callsToday: 5, failures: 0, missingToday: 0, lastAt: OPEN });
  });

  it('runs every 3 minutes while NFO is open, once more at the close, then not at all', async () => {
    const h = job(many(2));
    await h.j.tick(OPEN);
    await h.j.tick(OPEN + 60_000);
    expect(h.calls).toHaveLength(1);
    await h.j.tick(OPEN + 180_000);
    expect(h.calls).toHaveLength(2);
    const after = IST('2026-10-12T15:31:00');
    await h.j.tick(after);
    expect(h.calls).toHaveLength(3); // the closing snapshot
    await h.j.tick(after + 180_000);
    expect(h.calls).toHaveLength(3);
  });

  it('never runs on a closed day', async () => {
    const h = job(many(2));
    await h.j.tick(IST('2026-10-11T10:00:00')); // Sunday
    expect(h.calls).toHaveLength(0);
    expect(h.futures).not.toHaveBeenCalled();
  });

  it('reads the contract list and baseline once per IST day; oiChange comes from the previous session', async () => {
    const [a] = many(1);
    const h = job([a]);
    h.repo.oiRows.push({ instrumentId: a.instrumentId, oi: 900, oiChange: null, volume: 0, at: new Date(IST('2026-10-09T15:29:00')) });
    await h.j.tick(OPEN);
    await h.j.tick(OPEN + 180_000);
    expect(h.futures).toHaveBeenCalledTimes(1);
    expect(h.baseline).toHaveBeenCalledTimes(1);
    expect(h.baseline.mock.calls[0][1]).toEqual(new Date(IST('2026-10-12T00:00:00')));
    expect(h.repo.oiRows.slice(1).map((r) => r.oiChange)).toEqual([100, 100]);
    const nextDay = IST('2026-10-13T10:00:00');
    await h.j.tick(nextDay);
    expect(h.futures).toHaveBeenCalledTimes(2);
    expect(h.j.status(nextDay).rowsToday).toBe(1);
  });

  it('an all-empty broker answer writes nothing and counts a failure (logged once a day), never throws', async () => {
    const h = job(many(60), { quoteNow: async () => new Map() });
    await h.j.tick(OPEN);
    await h.j.tick(OPEN + 180_000);
    expect(h.repo.oiRows).toHaveLength(0);
    expect(h.j.status(OPEN + 180_000)).toEqual(expect.objectContaining({ failures: 2, missingToday: 120, callsToday: 4, rowsToday: 0, lastAt: null }));
    expect(h.log).toHaveBeenCalledTimes(1);
  });

  it('a partial answer writes what came back and counts the rest as missing', async () => {
    const contracts = many(3);
    const h = job(contracts, {
      quoteNow: async () => new Map([[refKey(contracts[0].ref), ok(tick(contracts[0].ref.token))]]),
    });
    await h.j.tick(OPEN);
    expect(h.repo.oiRows).toHaveLength(1);
    expect(h.j.status(OPEN)).toEqual(expect.objectContaining({ failures: 0, missingToday: 2, rowsToday: 1 }));
  });

  it('no futures in the master, a failing master read or a failing write is counted, not thrown, and retried', async () => {
    const empty = job([]);
    await empty.j.tick(OPEN);
    expect(empty.j.status(OPEN).failures).toBe(1);

    const futures = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(many(1));
    const flaky = job([], { repo: { futures, baseline: async () => new Map(), writeOi: async (r) => r.length } });
    await expect(flaky.j.tick(OPEN)).resolves.toBeUndefined();
    expect(flaky.j.status(OPEN).failures).toBe(1);
    await flaky.j.tick(OPEN + 180_000);
    expect(flaky.j.status(OPEN + 180_000)).toEqual(expect.objectContaining({ failures: 1, rowsToday: 1 }));

    const badWrite = job(many(1), { repo: { futures: async () => many(1), baseline: async () => new Map(), writeOi: async () => { throw new Error('write'); } } });
    await badWrite.j.tick(OPEN);
    expect(badWrite.j.status(OPEN).failures).toBe(1);
  });

  it('a failing baseline read still writes rows, with a NULL oiChange', async () => {
    const h = job(many(1));
    h.repo.failBaseline = true;
    await h.j.tick(OPEN);
    expect(h.repo.oiRows.map((r) => r.oiChange)).toEqual([null]);
  });

  it('overlapping ticks do not start a second run', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const contracts = many(1);
    const h = job(contracts, {
      quoteNow: async (refs) => {
        await gate;
        return new Map(refs.map((r) => [refKey(r), ok(tick(r.token))] as const));
      },
    });
    const first = h.j.tick(OPEN);
    await h.j.tick(OPEN + 200_000);
    release();
    await first;
    expect(h.repo.oiRows).toHaveLength(1);
  });
});
