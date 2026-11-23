import { NewsRelevanceService, UNIVERSE_TTL_MS, parseWatchlist } from './news-relevance.service';
import type { NewsFilterInput } from './news-relevance';

const OWNER = 'owner-1';

function harness(env: Record<string, string | undefined>, opts: { fno?: string[]; trackers?: Array<{ symbol: string; exchange: string }>; fail?: boolean } = {}) {
  const prisma = {
    instrument: {
      findMany: jest.fn(async () => {
        if (opts.fail) throw new Error('db down');
        return (opts.fno ?? ['SBIN', 'NIFTY', 'TATASTEEL']).map((name) => ({ name }));
      }),
    },
    tradeTracker: { findMany: jest.fn(async () => opts.trackers ?? [{ symbol: 'AZAD-EQ', exchange: 'NSE' }, { symbol: 'M&M25NOV253500PE', exchange: 'NFO' }]) },
  };
  const svc = new NewsRelevanceService(prisma as never);
  svc.env = { HUB_OWNER_USER_ID: OWNER, ...env };
  let t = 1_800_000_000_000;
  svc.now = () => t;
  return { svc, prisma, advance: (ms: number) => (t += ms) };
}

const filing = (symbol: string, subject: string): NewsFilterInput => ({
  source: 'NSE Announcements', title: `${symbol}: ${subject} — ${symbol} Limited has informed the Exchange about ${subject}`, summary: '',
  instruments: [symbol], sectors: [], indices: [], markets: [], tagged: true,
});

describe('NewsRelevanceService', () => {
  it('off: {} and no DB read at all (the insert is exactly as before)', async () => {
    const { svc, prisma } = harness({ NEWS_FILTER: 'off' });
    await expect(svc.columnsFor(filing('UNKNOWNCO', 'Trading Window'))).resolves.toEqual({});
    expect(prisma.instrument.findMany).not.toHaveBeenCalled();
  });

  it('observe: records the would-be reason, never sets filtered', async () => {
    const { svc } = harness({ NEWS_FILTER: 'observe' });
    await expect(svc.columnsFor(filing('UNKNOWNCO', 'Outcome of Board Meeting'))).resolves.toEqual({ filterReason: 'nse_not_in_universe' });
    await expect(svc.columnsFor(filing('SBIN', 'Outcome of Board Meeting'))).resolves.toEqual({ filterReason: null });
  });

  it('on: filtered + reason', async () => {
    const { svc } = harness({ NEWS_FILTER: 'on' });
    await expect(svc.columnsFor(filing('SBIN', 'Trading Window'))).resolves.toEqual({ filtered: true, filterReason: 'nse_routine:trading_window' });
    await expect(svc.columnsFor(filing('SBIN', 'Buyback'))).resolves.toEqual({ filtered: false, filterReason: null });
  });

  it('the universe = live F&O names + the owner’s OPEN trackers (underlying) + NEWS_FILTER_WATCHLIST', async () => {
    const { svc, prisma } = harness({ NEWS_FILTER: 'on', NEWS_FILTER_WATCHLIST: 'ofss, hfcl-be' });
    const u = await svc.universe();
    expect([...(u ?? [])].sort()).toEqual(['AZAD', 'HFCL', 'M&M', 'NIFTY', 'OFSS', 'SBIN', 'TATASTEEL']);
    expect(prisma.instrument.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ exchange: 'NFO' }) }));
    expect(prisma.tradeTracker.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: OWNER, status: 'OPEN' } }));
    // a holding and a watchlist name are in; a stranger is not
    await expect(svc.columnsFor(filing('AZAD', 'Acquisition'))).resolves.toEqual({ filtered: false, filterReason: null });
    await expect(svc.columnsFor(filing('OFSS', 'Acquisition'))).resolves.toEqual({ filtered: false, filterReason: null });
    await expect(svc.columnsFor(filing('STRANGER', 'Acquisition'))).resolves.toEqual({ filtered: true, filterReason: 'nse_not_in_universe' });
  });

  it('no owner id: F&O + watchlist only', async () => {
    const { svc, prisma } = harness({ NEWS_FILTER: 'on', HUB_OWNER_USER_ID: '' });
    expect([...((await svc.universe()) ?? [])].sort()).toEqual(['NIFTY', 'SBIN', 'TATASTEEL']);
    expect(prisma.tradeTracker.findMany).not.toHaveBeenCalled();
  });

  it('is cached for the TTL, then rebuilt', async () => {
    const { svc, prisma, advance } = harness({ NEWS_FILTER: 'on' });
    await svc.universe();
    await svc.universe();
    expect(prisma.instrument.findMany).toHaveBeenCalledTimes(1);
    advance(UNIVERSE_TTL_MS + 1);
    await svc.universe();
    expect(prisma.instrument.findMany).toHaveBeenCalledTimes(2);
  });

  it('fail open: a DB error or an empty F&O list skips the universe rule (type rules still apply)', async () => {
    const down = harness({ NEWS_FILTER: 'on' }, { fail: true });
    await expect(down.svc.columnsFor(filing('STRANGER', 'Acquisition'))).resolves.toEqual({ filtered: false, filterReason: null });
    await expect(down.svc.columnsFor(filing('STRANGER', 'Trading Window'))).resolves.toEqual({ filtered: true, filterReason: 'nse_routine:trading_window' });
    const stale = harness({ NEWS_FILTER: 'on' }, { fno: [] });
    await expect(stale.svc.columnsFor(filing('STRANGER', 'Acquisition'))).resolves.toEqual({ filtered: false, filterReason: null });
  });

  it('RSS rows never load the universe', async () => {
    const { svc, prisma } = harness({ NEWS_FILTER: 'on' });
    const r = await svc.columnsFor({ source: 'Google News US Macro', title: '5 Best American Stocks to Buy for 2027 - Yahoo Finance', instruments: [], sectors: [], indices: [], markets: ['GLOBAL'], tagged: true });
    expect(r).toEqual({ filtered: true, filterReason: 'listicle' });
    expect(prisma.instrument.findMany).not.toHaveBeenCalled();
  });

  it('parses the watchlist env', () => {
    expect(parseWatchlist({ NEWS_FILTER_WATCHLIST: ' reliance , tcs-eq,,' })).toEqual(['RELIANCE', 'TCS']);
    expect(parseWatchlist({})).toEqual([]);
  });
});
