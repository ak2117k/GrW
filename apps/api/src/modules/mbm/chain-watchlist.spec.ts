import { ChainWatchlistService, MAX_TTL_HOURS } from './chain-watchlist';
import { parseMbmConfig } from './mbm.config';

function build(positions: string[] | Error = [], env: NodeJS.ProcessEnv = { MBM_FEED_USER_ID: 'owner' }) {
  let now = Date.parse('2026-10-19T18:00:00Z');
  const repo = {
    openFnoUnderlyings: jest.fn(async () => {
      if (positions instanceof Error) throw positions;
      return positions;
    }),
  };
  const wl = new ChainWatchlistService(parseMbmConfig(env), repo as never, () => new Date(now));
  const advanceHours = (h: number) => {
    now += h * 3_600_000;
  };
  return { wl, repo, advanceHours };
}

const names = async (wl: ChainWatchlistService) => (await wl.symbols()).map((s) => s.symbol).sort();

describe('ChainWatchlistService', () => {
  it('lists the owner’s open NFO position underlyings, as NFO chains, NIFTY excluded (it has its own capture)', async () => {
    const { wl, repo } = build(['RELIANCE', 'NIFTY', 'banknifty']);
    expect(await wl.symbols()).toEqual([
      { symbol: 'RELIANCE', exchange: 'NFO' },
      { symbol: 'BANKNIFTY', exchange: 'NFO' },
    ]);
    expect(repo.openFnoUnderlyings).toHaveBeenCalledWith('owner');
  });

  it('adds registered symbols until their TTL lapses, deduped with positions', async () => {
    const { wl, advanceHours } = build(['RELIANCE']);
    expect(wl.add(['tcs-eq', { symbol: 'RELIANCE', exchange: 'NSE' }, { symbol: 'INFY' }, ''], 12)).toEqual(['TCS', 'RELIANCE', 'INFY']);
    expect(await names(wl)).toEqual(['INFY', 'RELIANCE', 'TCS']);
    advanceHours(11.9);
    expect(await names(wl)).toEqual(['INFY', 'RELIANCE', 'TCS']);
    advanceHours(0.2);
    expect(await names(wl)).toEqual(['RELIANCE']); // the position stays; the registrations lapsed
  });

  it('re-adding extends the TTL, never shortens it', async () => {
    const { wl, advanceHours } = build();
    wl.add(['TCS'], 24);
    wl.add(['TCS'], 1);
    advanceHours(10);
    expect(await names(wl)).toEqual(['TCS']);
    wl.add(['TCS'], 20); // now+20h > old expiry (now+14h) → extended
    advanceHours(18);
    expect(await names(wl)).toEqual(['TCS']);
  });

  it('clamps the TTL to MAX_TTL_HOURS and ignores a non-positive one', async () => {
    const { wl, advanceHours } = build();
    expect(wl.add(['SBIN'], 0)).toEqual([]);
    expect(wl.add(['SBIN'], Number.NaN)).toEqual([]);
    wl.add(['SBIN'], 10_000);
    advanceHours(MAX_TTL_HOURS - 0.1);
    expect(await names(wl)).toEqual(['SBIN']);
    advanceHours(0.2);
    expect(await names(wl)).toEqual([]);
  });

  it('a failed positions read degrades to the registered symbols (never throws)', async () => {
    const { wl } = build(new Error('db down'));
    wl.add(['TCS'], 5);
    expect(await names(wl)).toEqual(['TCS']);
  });

  it('without a feed user it reads no positions', async () => {
    const { wl, repo } = build(['RELIANCE'], {});
    wl.add(['TCS'], 5);
    expect(await names(wl)).toEqual(['TCS']);
    expect(repo.openFnoUnderlyings).not.toHaveBeenCalled();
  });
});
