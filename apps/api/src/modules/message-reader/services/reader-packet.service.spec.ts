import { ReaderPacketService } from './reader-packet.service';
import type { ReaderPacketSources } from './reader-packet.sources';
import type { MessageReaderConfig } from '../message-reader.config';

const NOW = new Date('2026-11-25T05:00:00Z'); // 10:30 IST

const quote = (token: string, ltp: number) => ({ token, symbol: token, exchange: 'NSE', ltp, open: ltp, high: ltp, low: ltp, close: ltp, volume: 0, change: 1, changePercent: 0.5, timestamp: NOW });

function setup(over: { getBreadth?: jest.Mock; contextBuild?: jest.Mock } = {}) {
  const breadth = {
    getBreadth: over.getBreadth ?? jest.fn().mockResolvedValue({ advances: 30, declines: 20, unchanged: 0, adRatio: 1.5, total: 50 }),
    getSectorPerformance: jest.fn().mockResolvedValue([{ sector: 'IT', symbol: 'NIFTY IT', token: '1', changePercent: 1.2, ltp: 100 }]),
  };
  const quotes = {
    resolveQuotes: jest.fn().mockImplementation(async (_u: string, refs: { token: string }[]) => new Map(refs.map((r) => [r.token, quote(r.token, 100)]))),
  };
  const context = { build: over.contextBuild ?? jest.fn().mockResolvedValue({ market: { status: 'present', source: 'x', value: 1 } }) };
  const sources: ReaderPacketSources = {
    recentChannelPosts: jest.fn().mockResolvedValue([{ at: NOW.toISOString(), text: 'nifty looks weak' }]),
    todayMarketNotes: jest.fn().mockResolvedValue([{ claim: 'market bearish', verdict: 'CONFIRMED' }]),
  };
  const readerCfg = { packetMs: 3_000 } as MessageReaderConfig;
  const svc = new ReaderPacketService(breadth as never, quotes, context as never, sources, readerCfg, { ownerUserId: 'owner-1' } as never);
  return { svc, breadth, quotes, context, sources };
}

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

  it('time-boxes a hanging source', async () => {
    const { svc } = setup({ getBreadth: jest.fn(() => new Promise(() => undefined)) });
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
    expect(quotes.resolveQuotes).toHaveBeenCalledTimes(1);
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
    expect(packet.instruments.NIFTY).toEqual({ context: { status: 'unavailable', source: expect.any(String), reason: expect.stringMatching(/boom/) } });
  });

  it('reads the channel’s last 30 min and today’s notes, at most 10 each', async () => {
    const { svc, sources } = setup();
    (sources.recentChannelPosts as jest.Mock).mockResolvedValue(Array.from({ length: 15 }, (_, i) => ({ at: NOW.toISOString(), text: `p${i}` })));
    const { packet } = await svc.build(input());
    expect(sources.recentChannelPosts).toHaveBeenCalledWith('ch-1', new Date(NOW.getTime() - 30 * 60_000));
    expect(sources.todayMarketNotes).toHaveBeenCalledWith('2026-11-25');
    expect(packet.channelRecent.status === 'present' && (packet.channelRecent.value as unknown[]).length).toBe(10);
  });
});
