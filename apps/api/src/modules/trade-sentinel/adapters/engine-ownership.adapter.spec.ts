import { Logger } from '@nestjs/common';
import { EngineOwnershipAdapter } from './engine-ownership.adapter';

function make() {
  const watchEntry = jest.fn().mockResolvedValue([]);
  const ungated = jest.fn().mockResolvedValue([]);
  const adaptive = jest.fn().mockResolvedValue([]);
  const sellFutures = jest.fn().mockResolvedValue([]);
  const prisma = {
    watchEntry: { findMany: watchEntry },
    ungatedWatchEntry: { findMany: ungated },
    adaptiveStopWatchEntry: { findMany: adaptive },
    sellFuturesWatchEntry: { findMany: sellFutures },
  };
  const svc = new EngineOwnershipAdapter(prisma as never);
  return { svc, watchEntry, ungated, adaptive, sellFutures };
}

describe('EngineOwnershipAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('asks all four engines, so no engine can quietly go unrepresented', async () => {
    const t = make();
    await t.svc.symbolsOwnedByOtherEngines('u1');
    for (const q of [t.watchEntry, t.ungated, t.adaptive, t.sellFutures]) {
      expect(q).toHaveBeenCalledTimes(1);
    }
  });

  it('claims only TRADED entries — a WATCHING alert is not a position', async () => {
    const t = make();
    await t.svc.symbolsOwnedByOtherEngines('u1');
    for (const q of [t.watchEntry, t.ungated, t.adaptive, t.sellFutures]) {
      expect(q.mock.calls[0][0].where).toEqual({ status: 'TRADED' });
    }
  });

  it('normalises what it returns, because the roster compares against normalised', async () => {
    const t = make();
    // The watch tables mostly hold base symbols, but nothing enforces it — a
    // suffixed row must not produce a set member the roster can never match.
    t.watchEntry.mockResolvedValue([{ symbol: 'SUZLON-EQ' }, { symbol: 'INFY' }]);

    const owned = await t.svc.symbolsOwnedByOtherEngines('u1');

    expect(owned).toEqual(new Set(['SUZLON', 'INFY']));
  });

  it('unions the engines rather than letting one overwrite another', async () => {
    const t = make();
    t.watchEntry.mockResolvedValue([{ symbol: 'A' }]);
    t.ungated.mockResolvedValue([{ symbol: 'B' }]);
    t.adaptive.mockResolvedValue([{ symbol: 'C' }]);
    t.sellFutures.mockResolvedValue([{ symbol: 'D', futTradingsymbol: null }]);

    await expect(t.svc.symbolsOwnedByOtherEngines('u1')).resolves.toEqual(
      new Set(['A', 'B', 'C', 'D']),
    );
  });

  it('claims BOTH spellings the futures engine can appear under', async () => {
    const t = make();
    // It signals on the equity and trades the futures contract, so either can
    // show up on the broker book.
    t.sellFutures.mockResolvedValue([
      { symbol: 'RELIANCE', futTradingsymbol: 'RELIANCE28AUG25FUT' },
    ]);

    await expect(t.svc.symbolsOwnedByOtherEngines('u1')).resolves.toEqual(
      new Set(['RELIANCE', 'RELIANCE28AUG25FUT']),
    );
  });

  it('drops null and empty symbols instead of seeding a matchable empty key', async () => {
    const t = make();
    t.watchEntry.mockResolvedValue([{ symbol: '' }]);
    t.sellFutures.mockResolvedValue([{ symbol: 'X', futTradingsymbol: null }]);

    await expect(t.svc.symbolsOwnedByOtherEngines('u1')).resolves.toEqual(new Set(['X']));
  });

  it('degrades to an empty set on a query failure, and says so LOUDLY', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const t = make();
    t.ungated.mockRejectedValue(new Error('db down'));

    // Rethrowing would fail the whole roster (`runForUser` rejects on that) and
    // blind the sentinel to every position over an attribution read.
    await expect(t.svc.symbolsOwnedByOtherEngines('u1')).resolves.toEqual(new Set());

    // But the consequence is that every position now looks unowned, which a
    // Stage 1 executor would act on — so it must never be silent.
    const logged = error.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('db down');
    expect(logged).toContain('u1');
    expect(logged).toMatch(/unowned/i);
  });
});
