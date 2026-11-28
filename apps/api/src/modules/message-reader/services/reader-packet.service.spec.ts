import { ReaderPacketService } from './reader-packet.service';
import { SignalContextService } from '../../signal-trader/services/signal-context.service';
import type { ReaderPacketSources } from './reader-packet.sources';
import { parseMessageReaderConfig, type MessageReaderConfig } from '../message-reader.config';

const NOW = new Date('2026-11-25T05:00:00Z'); // 10:30 IST

const quote = (token: string, ltp: number) => ({ token, symbol: token, exchange: 'NSE', ltp, open: ltp, high: ltp, low: ltp, close: ltp, volume: 0, change: 1, changePercent: 0.5, timestamp: NOW });

function setup(
  over: {
    getBreadth?: jest.Mock;
    contextBuild?: jest.Mock;
    underlyingQuote?: jest.Mock;
    context?: unknown;
    cfg?: Partial<MessageReaderConfig>;
    resolveQuotes?: jest.Mock;
    bars?: { daily: jest.Mock; intraday15m?: jest.Mock };
    master?: unknown[] | null;
    vocab?: unknown;
  } = {},
) {
  const breadth = {
    getBreadth: over.getBreadth ?? jest.fn().mockResolvedValue({ advances: 30, declines: 20, unchanged: 0, adRatio: 1.5, total: 50 }),
    getSectorPerformance: jest.fn().mockResolvedValue([{ sector: 'IT', symbol: 'NIFTY IT', token: '1', changePercent: 1.2, ltp: 100 }]),
  };
  const quotes = {
    resolveQuotes: over.resolveQuotes ?? jest.fn().mockImplementation(async (_u: string, refs: { token: string }[]) => new Map(refs.map((r) => [r.token, quote(r.token, 100)]))),
  };
  const bars = over.bars ?? { daily: jest.fn().mockResolvedValue([]), intraday15m: jest.fn().mockResolvedValue([]) };
  const master = { rows: jest.fn().mockResolvedValue(over.master === undefined ? MASTER : over.master) };
  const vocab = { get: jest.fn().mockResolvedValue(over.vocab ?? { names: new Map(), classOf: new Map([['DABUR', 'STOCK'], ['CRUDEOIL', 'COMMODITY']]) }) };
  const context = {
    build: over.contextBuild ?? jest.fn().mockResolvedValue({ market: { status: 'present', source: 'x', value: 1 } }),
    underlyingQuote: over.underlyingQuote ?? jest.fn().mockResolvedValue(6_500),
  };
  const sources: ReaderPacketSources = {
    recentChannelPosts: jest.fn().mockResolvedValue([{ at: NOW.toISOString(), text: 'nifty looks weak' }]),
    todayMarketNotes: jest.fn().mockResolvedValue([{ claim: 'market bearish', verdict: 'CONFIRMED' }]),
  };
  const readerCfg = { packetMs: 3_000, ...over.cfg } as MessageReaderConfig;
  const svc = new ReaderPacketService(breadth as never, quotes, (over.context ?? context) as never, sources, readerCfg, { ownerUserId: 'owner-1' } as never, bars as never, master, vocab as never);
  return { svc, breadth, quotes, context, sources, bars, master };
}

const MASTER = [{ exch_seg: 'NSE', symbol: 'DABUR-EQ', token: '772', name: 'DABUR' }];
const DAY_MS = 86_400_000;
/** 65 prior sessions (oldest first) + today's forming daily bar, which the quote must ignore. */
function daburDaily() {
  const out: Array<{ day: string; high: number; low: number; close: number; volume: number }> = [];
  for (let i = 0; i < 65; i++) {
    const day = new Date(Date.UTC(2026, 7, 1) + i * DAY_MS).toISOString().slice(0, 10);
    out.push({ day, high: 390, low: 370, close: 380, volume: i >= 45 ? 2_100_000 : 1_000_000 });
  }
  out[0].high = 500; // outside the 60-session window
  out[0].low = 300; // outside the 60-session window
  out[54].high = 403; // the 60-session high
  out[64] = { ...out[64], high: 401, low: 396, close: 400 }; // previous session
  out.push({ day: '2026-11-25', high: 433, low: 404, close: 431, volume: 14_500_000 });
  return out;
}
/** Yesterday's last five 15m bars + today's six (the 10:30 IST one is still forming at NOW). */
function dabur15m() {
  const starts = ['2026-11-24T08:45:00Z', '2026-11-24T09:00:00Z', '2026-11-24T09:15:00Z', '2026-11-24T09:30:00Z', '2026-11-24T09:45:00Z'];
  for (let m = 0; m <= 75; m += 15) starts.push(new Date(Date.parse('2026-11-25T03:45:00Z') + m * 60_000).toISOString());
  return starts.map((t, i) => ({ ts: Date.parse(t), open: 400 + i, high: 402 + i, low: 399 + i, close: 401 + i }));
}
const daburQuote = { token: '772', symbol: 'DABUR-EQ', exchange: 'NSE', ltp: 431.3, open: 405, high: 433, low: 404, close: 400, volume: 14_500_000, change: 31.3, changePercent: 7.8, timestamp: NOW };
const dabur = (over: { resolveQuotes?: jest.Mock; daily?: jest.Mock } = {}) =>
  setup({
    resolveQuotes:
      over.resolveQuotes ??
      jest.fn().mockImplementation(async (_u: string, refs: { token: string }[]) => new Map(refs.map((r) => [r.token, r.token === '772' ? daburQuote : quote(r.token, 100)]))),
    bars: { daily: over.daily ?? jest.fn().mockResolvedValue(daburDaily()), intraday15m: jest.fn().mockResolvedValue(dabur15m()) },
  });

const input = (underlyings: string[] = ['NIFTY']) => ({ text: 'nifty looks weak', channelId: 'ch-1', underlyings, now: NOW });

describe('ReaderPacketService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('breadth gets its own 6000 ms box (MESSAGE_READER_BREADTH_MS), separate from packetMs', async () => {
    expect(parseMessageReaderConfig({}).breadthMs).toBe(6_000);
    expect(parseMessageReaderConfig({}).packetMs).toBe(3_000);
    expect(parseMessageReaderConfig({ MESSAGE_READER_BREADTH_MS: '8000' }).breadthMs).toBe(8_000);
    expect(parseMessageReaderConfig({ MESSAGE_READER_BREADTH_MS: 'x' }).breadthMs).toBe(6_000);
    let settle!: (v: unknown) => void;
    const slow = new Promise((r) => (settle = r));
    const { svc } = setup({ getBreadth: jest.fn(() => slow), cfg: { breadthMs: 6_000 } });
    const p = svc.build(input());
    await jest.advanceTimersByTimeAsync(4_000); // past the 3 s packet box: breadth still waits
    settle({ advances: 31, declines: 19, unchanged: 0, adRatio: 1.63, total: 50 });
    const { packet } = await p;
    expect(packet.marketPulse.breadth).toMatchObject({ status: 'present', value: { advances: 31 } });
    // A breadth that never answers is cut at 6 s, not 3 s.
    const hung = setup({ getBreadth: jest.fn(() => new Promise(() => undefined)), cfg: { breadthMs: 6_000 } });
    const q = hung.svc.build(input());
    await jest.advanceTimersByTimeAsync(6_000);
    expect((await q).packet.marketPulse.breadth).toEqual({ status: 'unavailable', source: expect.any(String), reason: expect.stringMatching(/timed out after 6000/) });
  });

  it('addInstruments quotes AI-named instruments the packet lacks (at most 3, existing ones untouched)', async () => {
    const { svc, context } = setup();
    const { packet } = await svc.build(input(['NIFTY']));
    context.build.mockClear();
    const more = await svc.addInstruments(packet, ['nifty', 'BANKNIFTY', 'CRUDEOIL', 'FINNIFTY', 'SENSEX'], NOW);
    expect(Object.keys(more.packet.instruments)).toEqual(['NIFTY', 'BANKNIFTY', 'CRUDEOIL', 'FINNIFTY']);
    expect(context.build).toHaveBeenCalledTimes(3);
    expect(more.packet.instruments.NIFTY).toBe(packet.instruments.NIFTY);
    expect(more.packet.marketPulse).toBe(packet.marketPulse);
    expect(more.packet.instruments.BANKNIFTY).toHaveProperty('quote');
  });

  it('time-boxes a hanging source', async () => {
    const { svc } = setup({ getBreadth: jest.fn(() => new Promise(() => undefined)), cfg: { breadthMs: 3_000 } });
    let done = false;
    const p = svc.build(input()).then((r) => {
      done = true;
      return r;
    });
    await jest.advanceTimersByTimeAsync(2_999);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const { packet, ms } = await p;
    expect(packet.marketPulse.breadth).toEqual({ status: 'unavailable', source: expect.any(String), reason: expect.stringMatching(/timed out after 3000/) });
    expect(packet.marketPulse.indices.status).toBe('present');
    expect(packet.marketPulse.sectors.status).toBe('present');
    expect(packet.channelRecent.status).toBe('present');
    expect(packet.todayNotes.status).toBe('present');
    expect(packet.instruments.NIFTY).toBeDefined();
    expect(ms).toBe(3_000);
  });

  it('shares one market-pulse fetch across 5 concurrent builds', async () => {
    const { svc, breadth, quotes } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => svc.build(input())));
    expect(breadth.getBreadth).toHaveBeenCalledTimes(1);
    expect(breadth.getSectorPerformance).toHaveBeenCalledTimes(1);
    // One pulse batch (the NIFTY quote block is its own, also shared, call).
    expect(quotes.resolveQuotes.mock.calls.filter(([, refs]: [string, unknown[]]) => refs.length === 3)).toHaveLength(1);
    expect(breadth.getBreadth).toHaveBeenCalledWith('owner-1');
    for (const { packet } of results) expect(packet.marketPulse.breadth.status).toBe('present');
  });

  it('refetches the market pulse after 60 s', async () => {
    const { svc, breadth } = setup();
    await svc.build(input());
    jest.setSystemTime(NOW.getTime() + 59_000);
    await svc.build(input());
    expect(breadth.getBreadth).toHaveBeenCalledTimes(1);
    jest.setSystemTime(NOW.getTime() + 60_001);
    await svc.build(input());
    expect(breadth.getBreadth).toHaveBeenCalledTimes(2);
  });

  it('builds at most 3 named instruments', async () => {
    const { svc, context } = setup();
    const { packet } = await svc.build(input(['NIFTY', 'BANKNIFTY', 'CRUDEOIL', 'RELIANCE']));
    expect(context.build).toHaveBeenCalledTimes(3);
    expect(Object.keys(packet.instruments)).toEqual(['NIFTY', 'BANKNIFTY', 'CRUDEOIL']);
    expect(context.build).toHaveBeenCalledWith(expect.objectContaining({ underlying: 'NIFTY', kind: 'FUT', exchange: 'NFO', ownerUserId: 'owner-1', now: NOW }));
    expect(context.build).toHaveBeenCalledWith(expect.objectContaining({ underlying: 'CRUDEOIL', kind: 'FUT', exchange: 'MCX' }));
  });

  it('a failing instrument build is unavailable, not a throw', async () => {
    const { svc } = setup({ contextBuild: jest.fn().mockRejectedValue(new Error('boom')) });
    const { packet } = await svc.build(input(['NIFTY']));
    expect(packet.instruments.NIFTY.context).toEqual({ status: 'unavailable', source: expect.any(String), reason: expect.stringMatching(/boom/) });
  });

  it('reads the channel’s last 30 min and today’s notes, at most 10 each', async () => {
    const { svc, sources } = setup();
    (sources.recentChannelPosts as jest.Mock).mockResolvedValue(Array.from({ length: 15 }, (_, i) => ({ at: NOW.toISOString(), text: `p${i}` })));
    const { packet } = await svc.build(input());
    expect(sources.recentChannelPosts).toHaveBeenCalledWith('ch-1', new Date(NOW.getTime() - 30 * 60_000));
    expect(sources.todayMarketNotes).toHaveBeenCalledWith('2026-11-25');
    expect(packet.channelRecent.status === 'present' && (packet.channelRecent.value as unknown[]).length).toBe(10);
  });

  it('passes the packet time box to the judge packet as deadlineMs', async () => {
    const { svc, context } = setup();
    await svc.build(input(['NIFTY']));
    expect(context.build).toHaveBeenCalledWith(expect.objectContaining({ underlying: 'NIFTY', deadlineMs: 3_000 }));
    expect(context.build.mock.calls[0][0]).not.toHaveProperty('ltp');
  });

  it('one hung sub-block of an instrument is unavailable; its other blocks are still present', async () => {
    const chain = { latestChain: jest.fn(() => new Promise(() => undefined)) };
    const mbm = { behaviour: jest.fn().mockResolvedValue({ status: 'ok', horizons: {} }) };
    const real = new SignalContextService(chain as never, undefined, undefined, undefined, mbm as never, { instruments: ['NIFTY'], packet: 'on' } as never);
    const { svc } = setup({ context: real });
    const p = svc.build(input(['NIFTY']));
    await jest.advanceTimersByTimeAsync(3_000);
    const { packet } = await p;
    expect(packet.instruments.NIFTY.chain).toEqual({ status: 'unavailable', reason: expect.stringContaining('timed out after 3000 ms') });
    expect((packet.instruments.NIFTY.mbm as { status: string }).status).toBe('present');
  });

  it('two concurrent builds naming the same underlying build its context once', async () => {
    const { svc, context } = setup();
    await Promise.all([svc.build(input(['NIFTY'])), svc.build(input(['NIFTY', 'BANKNIFTY']))]);
    expect(context.build).toHaveBeenCalledTimes(2); // NIFTY once, BANKNIFTY once
    expect(context.build.mock.calls.filter(([a]: [{ underlying: string }]) => a.underlying === 'NIFTY')).toHaveLength(1);
    jest.setSystemTime(NOW.getTime() + 60_001);
    await svc.build(input(['NIFTY']));
    expect(context.build).toHaveBeenCalledTimes(3);
  });

  it('an MCX underlying passes the front-month future LTP as ltp', async () => {
    const { svc, context } = setup();
    const { packet } = await svc.build(input(['CRUDEOIL']));
    expect(context.underlyingQuote).toHaveBeenCalledWith('CRUDEOIL', 'MCX', 'owner-1', NOW);
    expect(context.build).toHaveBeenCalledWith(expect.objectContaining({ underlying: 'CRUDEOIL', exchange: 'MCX', ltp: 6_500 }));
    expect(packet.instruments.CRUDEOIL.frontFuture).toEqual({ status: 'present', source: expect.any(String), value: { ltp: 6_500 } });
  });

  it('an MCX front-future miss builds without ltp and says so', async () => {
    const { svc, context } = setup({ underlyingQuote: jest.fn().mockResolvedValue(null) });
    const { packet } = await svc.build(input(['CRUDEOIL']));
    expect(context.build.mock.calls[0][0]).not.toHaveProperty('ltp');
    expect(packet.instruments.CRUDEOIL.frontFuture).toEqual({ status: 'unavailable', source: expect.any(String), reason: expect.stringContaining('without a spot') });
  });

  it('a hung MCX front-future lookup gives up at half the box; the judge packet gets the rest', async () => {
    const { svc, context } = setup({ underlyingQuote: jest.fn(() => new Promise(() => undefined)) });
    const p = svc.build(input(['CRUDEOIL']));
    await jest.advanceTimersByTimeAsync(1_500);
    const { packet } = await p;
    expect(context.build).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 1_500 }));
    expect((packet.instruments.CRUDEOIL.frontFuture as { status: string }).status).toBe('unavailable');
  });

  describe('final review #2 / #8: broker sharing and short cache for unavailable results', () => {
    it('skips the structure block by default; MESSAGE_READER_SKIP_STRUCTURE=false builds it', async () => {
      const a = setup();
      await a.svc.build(input(['NIFTY']));
      expect(a.context.build).toHaveBeenCalledWith(expect.objectContaining({ skip: ['structure'] }));
      const b = setup({ cfg: { skipStructure: false } });
      await b.svc.build(input(['NIFTY']));
      expect(b.context.build.mock.calls[0][0]).not.toHaveProperty('skip');
    });

    it('at most 2 instrument builds in flight; an extra underlying waits for a free permit', async () => {
      let inFlight = 0;
      let max = 0;
      const contextBuild = jest.fn(async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 1_000));
        inFlight--;
        return { market: { status: 'present', source: 'x', value: 1 } };
      });
      const { svc } = setup({ contextBuild });
      const p = svc.build(input(['NIFTY', 'BANKNIFTY', 'RELIANCE']));
      await jest.advanceTimersByTimeAsync(0);
      expect(contextBuild).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(contextBuild).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(1_000);
      const { packet } = await p;
      expect(max).toBe(2);
      expect(packet.instruments.RELIANCE.market).toEqual({ status: 'present', source: 'x', value: 1 });
    });

    it('a build still waiting at the packet deadline is unavailable "reader build limit"', async () => {
      const contextBuild = jest.fn(() => new Promise(() => undefined));
      const { svc } = setup({ contextBuild, cfg: { maxInstrumentBuilds: 2 } });
      const p = svc.build(input(['NIFTY', 'BANKNIFTY', 'RELIANCE']));
      await jest.advanceTimersByTimeAsync(3_500);
      const { packet } = await p;
      expect(contextBuild).toHaveBeenCalledTimes(2);
      expect(packet.instruments.RELIANCE.context).toEqual({ status: 'unavailable', source: expect.any(String), reason: expect.stringContaining('reader build limit') });
      // Hung builds keep their permits: a later post's build is refused at its own deadline too.
      const q = svc.build({ ...input(['SBIN']), now: NOW });
      await jest.advanceTimersByTimeAsync(3_500);
      expect((await q).packet.instruments.SBIN.context).toMatchObject({ reason: expect.stringContaining('reader build limit') });
      expect(contextBuild).toHaveBeenCalledTimes(2);
    });

    it('an unavailable market pulse is refetched after ~10 s, not 60 s', async () => {
      const getBreadth = jest.fn().mockRejectedValue(new Error('session expired'));
      const { svc } = setup({ getBreadth });
      await svc.build(input());
      jest.setSystemTime(NOW.getTime() + 9_000);
      await svc.build(input());
      expect(getBreadth).toHaveBeenCalledTimes(1);
      jest.setSystemTime(NOW.getTime() + 10_001);
      await svc.build(input());
      expect(getBreadth).toHaveBeenCalledTimes(2);
    });

    it('an unavailable instrument is rebuilt after ~10 s; a present one is kept 60 s', async () => {
      const contextBuild = jest
        .fn()
        .mockResolvedValueOnce({ chain: { status: 'unavailable', reason: 'no snapshot' } })
        .mockResolvedValue({ market: { status: 'present', source: 'x', value: 1 } });
      const { svc } = setup({ contextBuild });
      await svc.build(input(['NIFTY']));
      jest.setSystemTime(NOW.getTime() + 10_001);
      await svc.build(input(['NIFTY']));
      expect(contextBuild).toHaveBeenCalledTimes(2);
      jest.setSystemTime(NOW.getTime() + 50_000);
      await svc.build(input(['NIFTY']));
      expect(contextBuild).toHaveBeenCalledTimes(2);
    });
  });

  describe('quote block (named stocks)', () => {
    it('a DABUR post gets its LTP, day range, previous session, 20-day volume, 60-day range and closed 15m bars', async () => {
      const { svc, quotes, bars } = dabur();
      const { packet } = await svc.build(input(['DABUR']));
      expect(quotes.resolveQuotes).toHaveBeenCalledWith('owner-1', [{ token: '772', exchange: 'NSE', symbol: 'DABUR' }]);
      expect(bars.daily).toHaveBeenCalledWith('NSE', '772', expect.any(Date), NOW);
      expect(bars.intraday15m).toHaveBeenCalledWith('NSE', '772', expect.any(Date), NOW);
      const q = packet.instruments.DABUR.quote as { status: string; value: Record<string, unknown> };
      expect(q.status).toBe('present');
      expect(q.value).toMatchObject({
        exchange: 'NSE',
        ltp: 431.3,
        open: 405,
        dayHigh: 433,
        dayLow: 404,
        volume: 14_500_000,
        prevClose: 400,
        prevHigh: 401,
        prevLow: 396,
        avgVolume20d: 2_100_000,
        high60d: 403,
        low60d: 370,
      });
      const b15 = q.value.bars15m as Array<{ at: string }>;
      expect(b15).toHaveLength(8);
      expect(b15[0].at).toBe('2026-11-24T09:15:00.000Z');
      // The forming 10:30 IST bar is left out.
      expect(b15[7]).toEqual({ at: '2026-11-25T04:45:00.000Z', open: 409, high: 411, low: 408, close: 410 });
    });

    it('a hung quote source is unavailable at the packet deadline', async () => {
      const resolveQuotes = jest.fn().mockImplementation((_u: string, refs: { token: string }[]) =>
        refs.some((r) => r.token === '772') ? new Promise(() => undefined) : Promise.resolve(new Map(refs.map((r) => [r.token, quote(r.token, 100)]))),
      );
      const { svc } = dabur({ resolveQuotes });
      let done = false;
      const p = svc.build(input(['DABUR'])).then((r) => {
        done = true;
        return r;
      });
      await jest.advanceTimersByTimeAsync(2_999);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const { packet, ms } = await p;
      expect(ms).toBe(3_000);
      expect(packet.instruments.DABUR.quote).toEqual({ status: 'unavailable', source: expect.any(String), reason: expect.stringMatching(/timed out after 3000/) });
    });

    it('concurrent posts on one stock share one quote; daily bars are kept for the session, the rest for 60 s', async () => {
      const { svc, quotes, bars } = dabur();
      const of772 = (m: jest.Mock) => m.mock.calls.filter((c: unknown[]) => c[1] === '772').length;
      const quoteCalls = () => quotes.resolveQuotes.mock.calls.filter(([, refs]: [string, Array<{ token: string }>]) => refs[0].token === '772').length;
      await Promise.all([svc.build(input(['DABUR'])), svc.build(input(['DABUR', 'NIFTY']))]);
      expect(quoteCalls()).toBe(1);
      expect(of772(bars.daily)).toBe(1);
      expect(of772(bars.intraday15m!)).toBe(1);
      jest.setSystemTime(NOW.getTime() + 59_000);
      await svc.build(input(['DABUR']));
      expect(quoteCalls()).toBe(1);
      jest.setSystemTime(NOW.getTime() + 60_001);
      await svc.build(input(['DABUR']));
      expect(quoteCalls()).toBe(2);
      expect(of772(bars.intraday15m!)).toBe(2);
      expect(of772(bars.daily)).toBe(1);
    });

    it('failed daily bars keep the LTP block present with null previous-session fields and say why', async () => {
      const { svc } = dabur({ daily: jest.fn().mockRejectedValue(new Error('historical gate busy')) });
      const { packet } = await svc.build(input(['DABUR']));
      const q = packet.instruments.DABUR.quote as { status: string; value: Record<string, unknown> };
      expect(q.status).toBe('present');
      expect(q.value).toMatchObject({ ltp: 431.3, prevHigh: null, prevLow: null, avgVolume20d: null, high60d: null, low60d: null, prevClose: 400 });
      expect(q.value.missing).toEqual([expect.stringContaining('historical gate busy')]);
    });

    it('a name the master does not know is unavailable, and retried after ~10 s', async () => {
      const { svc, master } = setup({ master: [] });
      const { packet } = await svc.build(input(['ZZZCO']));
      expect(packet.instruments.ZZZCO.quote).toEqual({ status: 'unavailable', source: expect.any(String), reason: expect.stringContaining('no instrument') });
      jest.setSystemTime(NOW.getTime() + 10_001);
      await svc.build(input(['ZZZCO']));
      expect(master.rows).toHaveBeenCalledTimes(2);
    });

    it('an index gets its quote from the index token without the master', async () => {
      const { svc, quotes, master } = setup();
      const { packet } = await svc.build(input(['NIFTY']));
      expect(quotes.resolveQuotes).toHaveBeenCalledWith('owner-1', [{ token: '99926000', exchange: 'NSE', symbol: 'NIFTY' }]);
      expect((packet.instruments.NIFTY.quote as { status: string }).status).toBe('present');
      expect(master.rows).not.toHaveBeenCalled();
    });

    it('an index or MCX future gets no 15m fetch (its context block has the 15m view)', async () => {
      const { svc, bars } = setup({ master: [...MASTER, { exch_seg: 'MCX', symbol: 'CRUDEOILDEC26FUT', name: 'CRUDEOIL', token: '500', instrumenttype: 'FUTCOM', expiry: '18DEC2026' }] });
      const { packet } = await svc.build(input(['NIFTY', 'CRUDEOIL']));
      expect(bars.daily).toHaveBeenCalledWith('MCX', '500', expect.any(Date), NOW); // the MCX future did resolve
      expect(bars.intraday15m).not.toHaveBeenCalled();
      for (const u of ['NIFTY', 'CRUDEOIL']) {
        expect((packet.instruments[u].quote as { value: { missing: string[] } }).value.missing).toContainEqual(expect.stringContaining('15m bars: not fetched'));
      }
    });

    describe('review fix: broker lane caps and stale quotes', () => {
      const STOCKS = Array.from({ length: 10 }, (_, i) => ({ exch_seg: 'NSE', symbol: `S${i}-EQ`, token: String(100 + i), name: `S${i}` }));
      const stockCalls = (m: jest.Mock, idx: number) => m.mock.calls.filter((c: unknown[]) => c[1] === String(100 + idx)).length;
      const quoted = (m: jest.Mock, idx: number) => m.mock.calls.filter(([, refs]: [string, Array<{ token: string }>]) => refs[0]?.token === String(100 + idx)).length;
      const reasonOf = (b: unknown) => (b as { reason?: string }).reason ?? '';

      it('a burst of 10 new stocks fetches at most 6 in the minute; the rest are "reader quote budget" with no broker call', async () => {
        const { svc, quotes, bars } = setup({ master: STOCKS, bars: { daily: jest.fn().mockResolvedValue(daburDaily()), intraday15m: jest.fn().mockResolvedValue(dabur15m()) } });
        const posts = [['S0', 'S1', 'S2'], ['S3', 'S4', 'S5'], ['S6', 'S7', 'S8'], ['S9']];
        const results = await Promise.all(posts.map((u) => svc.build(input(u))));
        const blocks = results.flatMap((r) => Object.values(r.packet.instruments).map((x) => x.quote as { status: string; reason?: string }));
        expect(blocks.filter((b) => b.status === 'present')).toHaveLength(6);
        const refused = blocks.filter((b) => b.status === 'unavailable');
        expect(refused).toHaveLength(4);
        for (const b of refused) expect(b.reason).toContain('reader quote budget');
        let fetched = 0;
        for (let i = 0; i < 10; i++) {
          const name = `S${i}`;
          const block = results.find((r) => r.packet.instruments[name])!.packet.instruments[name].quote as { status: string };
          const calls = quoted(quotes.resolveQuotes, i) + stockCalls(bars.daily, i) + stockCalls(bars.intraday15m!, i);
          if (block.status === 'present') {
            fetched++;
            expect(calls).toBe(3);
          } else {
            expect(calls).toBe(0); // no quote and no historical lane work for an over-budget underlying
          }
        }
        expect(fetched).toBe(6);
        // The budget rolls: a minute later a refused name is fetched.
        const refusedName = Array.from({ length: 10 }, (_, i) => `S${i}`).find((n) => (results.find((r) => r.packet.instruments[n])!.packet.instruments[n].quote as { status: string }).status === 'unavailable')!;
        jest.setSystemTime(NOW.getTime() + 60_001);
        const later = await svc.build(input([refusedName]));
        expect((later.packet.instruments[refusedName].quote as { status: string }).status).toBe('present');
      });

      it('at most 2 quote fetches in flight; a third still waiting at the deadline is "reader quote limit" and never reaches the broker; permits free at the timeout', async () => {
        let hang = true;
        const resolveQuotes = jest.fn().mockImplementation((_u: string, refs: { token: string }[]) =>
          hang && refs.length === 1 ? new Promise(() => undefined) : Promise.resolve(new Map(refs.map((r) => [r.token, quote(r.token, 100)]))),
        );
        const { svc, bars } = setup({ master: STOCKS, resolveQuotes, bars: { daily: jest.fn().mockResolvedValue(daburDaily()), intraday15m: jest.fn().mockResolvedValue(dabur15m()) } });
        const p = svc.build(input(['S0', 'S1', 'S2']));
        await jest.advanceTimersByTimeAsync(0);
        expect(resolveQuotes.mock.calls.filter(([, refs]: [string, unknown[]]) => refs.length === 1)).toHaveLength(2);
        await jest.advanceTimersByTimeAsync(3_000);
        const { packet } = await p;
        expect(reasonOf(packet.instruments.S0.quote)).toMatch(/timed out after 3000/);
        expect(reasonOf(packet.instruments.S1.quote)).toMatch(/timed out after 3000/);
        expect(reasonOf(packet.instruments.S2.quote)).toContain('reader quote limit');
        expect(quoted(resolveQuotes, 2) + stockCalls(bars.daily, 2) + stockCalls(bars.intraday15m!, 2)).toBe(0);
        // Both permits were released at the timeout: a new name is fetched at once.
        hang = false;
        const q = await svc.build(input(['S3']));
        expect((q.packet.instruments.S3.quote as { status: string }).status).toBe('present');
      });

      it('a failed quote frees its permit at once for the next underlying', async () => {
        const resolveQuotes = jest.fn().mockImplementation(async (_u: string, refs: { token: string }[]) => {
          if (refs.length === 1 && (refs[0].token === '100' || refs[0].token === '101')) throw new Error('session expired');
          return new Map(refs.map((r) => [r.token, quote(r.token, 100)]));
        });
        const daily = jest.fn(() => new Promise(() => undefined)); // would hold a permit to the deadline if it were not failure-released
        const { svc } = setup({ master: STOCKS, resolveQuotes, bars: { daily, intraday15m: jest.fn().mockResolvedValue([]) } });
        const p = svc.build(input(['S0', 'S1', 'S2']));
        await jest.advanceTimersByTimeAsync(3_000);
        const { packet } = await p;
        expect(reasonOf(packet.instruments.S0.quote)).toContain('session expired');
        // A failed quote enqueues no historical-lane read.
        expect(stockCalls(daily as jest.Mock, 0) + stockCalls(daily as jest.Mock, 1)).toBe(0);
        // S2 got a permit (it made its quote call) rather than being refused as over the limit.
        expect(quoted(resolveQuotes, 2)).toBe(1);
        expect(reasonOf(packet.instruments.S2.quote)).not.toContain('reader quote limit');
      });

      it('a quote more than 5 min old during the session (the daily-candle fallback) is "stale quote"', async () => {
        const old = { ...daburQuote, timestamp: new Date(NOW.getTime() - 6 * 60_000) };
        const { svc } = dabur({ resolveQuotes: jest.fn().mockImplementation(async (_u: string, refs: { token: string }[]) => new Map(refs.map((r) => [r.token, r.token === '772' ? old : quote(r.token, 100)]))) });
        const { packet } = await svc.build(input(['DABUR']));
        expect(packet.instruments.DABUR.quote).toEqual({ status: 'unavailable', source: expect.any(String), reason: expect.stringContaining('stale quote') });

        const fallback = { ...daburQuote, timestamp: new Date('2026-11-24T18:30:00Z') }; // a daily candle's 00:00 IST
        const b = dabur({ resolveQuotes: jest.fn().mockImplementation(async (_u: string, refs: { token: string }[]) => new Map(refs.map((r) => [r.token, r.token === '772' ? fallback : quote(r.token, 100)]))) });
        expect(reasonOf((await b.svc.build(input(['DABUR']))).packet.instruments.DABUR.quote)).toContain('stale quote');
      });

      it('after the close an old quote timestamp is normal, not stale', async () => {
        const after = new Date('2026-11-25T10:30:00Z'); // 16:00 IST
        jest.setSystemTime(after);
        const closeQuote = { ...daburQuote, timestamp: new Date('2026-11-25T10:00:00Z') }; // 15:30 IST
        const { svc } = dabur({ resolveQuotes: jest.fn().mockImplementation(async (_u: string, refs: { token: string }[]) => new Map(refs.map((r) => [r.token, r.token === '772' ? closeQuote : quote(r.token, 100)]))) });
        const { packet } = await svc.build({ ...input(['DABUR']), now: after });
        expect((packet.instruments.DABUR.quote as { status: string }).status).toBe('present');
      });
    });
  });
  describe('option block (a post naming an option contract)', () => {
    const optRow = (expiry: string, strike: number, type: 'CE' | 'PE', token: string) => ({
      exch_seg: 'NFO', name: 'NIFTY', instrumenttype: 'OPTIDX', symbol: `NIFTY${expiry.slice(0, 5)}${expiry.slice(7)}${strike}${type}`, token, expiry, strike: String(strike * 100),
    });
    /** NIFTY 25300..26100 every 50, CE token 5<strike>, PE token 6<strike>; two weekly series. */
    const niftyOptions = () => {
      const rows: unknown[] = [];
      for (const [exp, pre] of [['02DEC2026', ''], ['09DEC2026', '9']] as const) {
        for (let k = 25300; k <= 26100; k += 50) rows.push(optRow(exp, k, 'CE', `${pre}5${k}`), optRow(exp, k, 'PE', `${pre}6${k}`));
      }
      return rows;
    };
    const live = (token: string, ltp: number, over: Record<string, unknown> = {}) => ({ ...quote(token, ltp), exchange: 'NFO', close: ltp - 10, change: 10, changePercent: (10 / (ltp - 10)) * 100, oi: 1_000 + Number(token.slice(-5)), timestamp: NOW, ...over });
    /** NIFTY index at 25540; every option quoted live at 330. `over` returning null drops a token. */
    const resolver = (over: (token: string) => unknown = () => undefined) =>
      jest.fn().mockImplementation(async (_u: string, refs: { token: string }[]) => {
        const m = new Map<string, unknown>();
        for (const r of refs) {
          const o = over(r.token);
          if (o === null) continue;
          m.set(r.token, o ?? (r.token === '99926000' ? { ...quote(r.token, 25_540), timestamp: NOW } : /^9?[56]\d{5}$/.test(r.token) ? live(r.token, 330) : quote(r.token, 100)));
        }
        return m;
      });
    const post = (text: string, underlyings = ['NIFTY']) => ({ text, channelId: 'ch-1', underlyings, now: NOW });
    const optionCalls = (m: jest.Mock) => m.mock.calls.filter(([, refs]: [string, { token: string }[]]) => refs.some((r) => /^9?[56]\d{5}$/.test(r.token)));
    const reasonOfBlock = (b: unknown) => (b as { reason?: string }).reason ?? '';

    it('"NIFTY 25700 PE above 330": the contract (nearest expiry), its LTP / prev close / change / OI and an ATM +-3 slice', async () => {
      const resolveQuotes = resolver();
      const { svc } = setup({ resolveQuotes, master: [...MASTER, ...niftyOptions()] });
      const { packet } = await svc.build(post('NIFTY 25700 PE above 330 sl 300'));
      const block = packet.instruments.NIFTY.option as { status: string; source: string; value: Record<string, unknown> };
      expect(block.status).toBe('present');
      expect(block.value).toMatchObject({
        contract: { symbol: 'NIFTY02DEC2625700PE', exchange: 'NFO', token: '625700', underlying: 'NIFTY', strike: 25700, optionType: 'PE', expiry: '2026-12-02', expirySource: 'master' },
        ltp: 330,
        prevClose: 320,
        change: 10,
        oi: 1_000 + 25_700,
        oiChange: null,
        spot: 25_540,
        atmStrike: 25_550,
        sliceCentre: 'ATM',
      });
      const chain = block.value.chain as Array<{ strike: number; ce: { ltp: number; oi: number } | null; pe: { ltp: number; oi: number } | null }>;
      expect(chain.map((r) => r.strike)).toEqual([25400, 25450, 25500, 25550, 25600, 25650, 25700]);
      expect(chain[3]).toEqual({ strike: 25550, ce: { ltp: 330, oi: 1_000 + 25_550 }, pe: { ltp: 330, oi: 1_000 + 25_550 } });
      expect(block.value.missing).toEqual([expect.stringContaining('oiChange')]);
      // One probe for the named contract, then ONE batch for the slice (the named contract not asked twice).
      const calls = optionCalls(resolveQuotes);
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toEqual([{ token: '625700', exchange: 'NFO', symbol: 'NIFTY02DEC2625700PE' }]);
      expect(calls[1][1]).toHaveLength(13);
      expect(calls[1][1].map((r: { token: string }) => r.token)).not.toContain('625700');
    });

    it('a stated expiry picks that series; a second leg on the same underlying gets its own key', async () => {
      const { svc } = setup({ resolveQuotes: resolver(), master: [...MASTER, ...niftyOptions()] });
      const { packet } = await svc.build(post('NIFTY 9 DEC 25700 PE above 330, 25900 CE below 120'));
      expect((packet.instruments.NIFTY.option as { value: { contract: { symbol: string } } }).value.contract.symbol).toBe('NIFTY09DEC2625700PE');
      expect((packet.instruments.NIFTY.option_25900CE as { value: { contract: { symbol: string } } }).value.contract.symbol).toBe('NIFTY09DEC2625900CE');
    });

    it('an unlisted strike is unavailable with the listed range, and makes no broker call', async () => {
      const resolveQuotes = resolver();
      const { svc } = setup({ resolveQuotes, master: [...MASTER, ...niftyOptions()] });
      const { packet } = await svc.build(post('NIFTY 25710 PE above 330'));
      expect(packet.instruments.NIFTY.option).toEqual({ status: 'unavailable', source: expect.any(String), reason: expect.stringContaining('NIFTY 25710 PE is not listed for expiry 2026-12-02 (listed strikes 25300 to 26100)') });
      expect(optionCalls(resolveQuotes)).toHaveLength(0);
    });

    it('a candle-fallback contract quote keeps its numbers but fetches no slice (no candle calls for 13 more tokens)', async () => {
      const after = new Date('2026-11-25T12:30:00Z'); // 18:00 IST: an old timestamp is not "stale"
      jest.setSystemTime(after);
      const resolveQuotes = resolver((t) => (t === '625700' ? live(t, 330, { timestamp: new Date('2026-11-24T18:30:00Z') }) : undefined));
      const { svc } = setup({ resolveQuotes, master: [...MASTER, ...niftyOptions()] });
      const { packet } = await svc.build({ ...post('NIFTY 25700 PE above 330'), now: after });
      const block = packet.instruments.NIFTY.option as { status: string; value: Record<string, unknown> };
      expect(block.status).toBe('present');
      expect(block.value).toMatchObject({ ltp: 330, chain: null });
      expect(block.value.missing).toEqual(expect.arrayContaining([expect.stringContaining('daily-candle fallback')]));
      expect(optionCalls(resolveQuotes)).toHaveLength(1);
    });

    it('in session a stale contract quote is unavailable; no quote at all is unavailable', async () => {
      const stale = setup({ resolveQuotes: resolver((t) => (t === '625700' ? live(t, 330, { timestamp: new Date(NOW.getTime() - 6 * 60_000) }) : undefined)), master: [...MASTER, ...niftyOptions()] });
      expect(reasonOfBlock((await stale.svc.build(post('NIFTY 25700 PE above 330'))).packet.instruments.NIFTY.option)).toContain('stale quote');
      const none = setup({ resolveQuotes: resolver((t) => (t === '625700' ? null : undefined)), master: [...MASTER, ...niftyOptions()] });
      expect(reasonOfBlock((await none.svc.build(post('NIFTY 25700 PE above 330'))).packet.instruments.NIFTY.option)).toContain('no live quote');
    });

    it('no spot: the slice is centred on the named strike and says so', async () => {
      const resolveQuotes = resolver((t) => (t === '99926000' ? null : undefined));
      const { svc } = setup({ resolveQuotes, master: [...MASTER, ...niftyOptions()] });
      const { packet } = await svc.build(post('NIFTY 25700 PE above 330'));
      const v = (packet.instruments.NIFTY.option as { value: Record<string, unknown> }).value;
      expect(v).toMatchObject({ spot: null, atmStrike: null, sliceCentre: 'named strike' });
      expect((v.chain as Array<{ strike: number }>).map((r) => r.strike)).toEqual([25550, 25600, 25650, 25700, 25750, 25800, 25850]);
    });

    it('the option block is cached 60 s (a repeat post makes no new option call)', async () => {
      const resolveQuotes = resolver();
      const { svc } = setup({ resolveQuotes, master: [...MASTER, ...niftyOptions()] });
      await svc.build(post('NIFTY 25700 PE above 330'));
      await svc.build(post('NIFTY 25700 PE above 330'));
      expect(optionCalls(resolveQuotes)).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(61_000);
      await svc.build({ ...post('NIFTY 25700 PE above 330'), now: new Date(NOW.getTime() + 61_000) });
      expect(optionCalls(resolveQuotes)).toHaveLength(4);
    });

    it('a post with no option contract adds no option block and no option call', async () => {
      const resolveQuotes = resolver();
      const { svc } = setup({ resolveQuotes, master: [...MASTER, ...niftyOptions()] });
      const { packet } = await svc.build(post('nifty looks weak below 25500'));
      expect(packet.instruments.NIFTY).not.toHaveProperty('option');
      expect(optionCalls(resolveQuotes)).toHaveLength(0);
    });
  });
});
