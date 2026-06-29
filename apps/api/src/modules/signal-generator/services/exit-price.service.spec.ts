import { ExitPriceService } from './exit-price.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { LevelBookService } from './level-book.service';
import { LevelBook } from '../types/level-book.types';

/**
 * Risk-critical: the resolver must return a FRESH price when possible,
 * never treat a stale level-book seed as fresh, and surface (not silently
 * drop) tokens with no fresh price so the caller does not fire a stop on
 * stale data.
 */
describe('ExitPriceService', () => {
  let service: ExitPriceService;
  let adapter: {
    getLtpsBatch: jest.Mock;
    getLiveQuote: jest.Mock;
  };
  let levelBook: {
    getLevels: jest.Mock;
  };

  const EXCHANGE = 'NSE';

  const makeBook = (over: Partial<LevelBook>): LevelBook =>
    ({
      token: 'X',
      symbol: 'SYM',
      exchange: EXCHANGE,
      asOf: new Date(),
      pdh: 0,
      pdl: 0,
      prevClose: 100,
      spot: 0,
      vwap: 0,
      lastTickAt: new Date(0),
      ...over,
    }) as LevelBook;

  beforeEach(() => {
    adapter = {
      getLtpsBatch: jest.fn().mockResolvedValue(new Map<string, number>()),
      getLiveQuote: jest.fn(),
      levelBook,
    } as any;
    levelBook = {
      getLevels: jest.fn().mockReturnValue(null),
    };
    service = new ExitPriceService(
      adapter as unknown as AngelOneAdapterService,
      levelBook as unknown as LevelBookService,
    );
  });

  it('tier 1: token returned by getLtpsBatch is fresh rest-batch (getLiveQuote not called)', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map([['T1', 250.5]]));

    const out = await service.resolveExitPrices(EXCHANGE, ['T1']);

    expect(out.get('T1')).toEqual({ price: 250.5, fresh: true, source: 'rest-batch' });
    expect(adapter.getLiveQuote).not.toHaveBeenCalled();
  });

  it('tier 2: token missing from batch but getLiveQuote returns ltp>0 is fresh rest-single', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map());
    adapter.getLiveQuote.mockResolvedValue({ token: 'T2', ltp: 99.25 } as any);

    const out = await service.resolveExitPrices(EXCHANGE, ['T2']);

    expect(out.get('T2')).toEqual({ price: 99.25, fresh: true, source: 'rest-single' });
    expect(adapter.getLiveQuote).toHaveBeenCalledWith('T2', EXCHANGE);
  });

  it('tier 3: batch+single fail, level book spot>0 with recent lastTickAt is fresh levelbook', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map());
    adapter.getLiveQuote.mockRejectedValue(new Error('no quote'));
    levelBook.getLevels.mockReturnValue(
      makeBook({ spot: 305.75, lastTickAt: new Date() }),
    );

    const out = await service.resolveExitPrices(EXCHANGE, ['T3']);

    expect(out.get('T3')).toEqual({ price: 305.75, fresh: true, source: 'levelbook' });
  });

  it('tier 3 SAFETY: stale level book (lastTickAt 10 min ago) must NOT be treated as fresh', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map());
    adapter.getLiveQuote.mockRejectedValue(new Error('no quote'));
    levelBook.getLevels.mockReturnValue(
      makeBook({ spot: 305.75, lastTickAt: new Date(Date.now() - 10 * 60_000) }),
    );

    const out = await service.resolveExitPrices(EXCHANGE, ['T4']);

    expect(out.get('T4')).toEqual({ price: 0, fresh: false, source: 'none' });
  });

  it('all tiers miss: no batch, getLiveQuote throws, no level book is none', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map());
    adapter.getLiveQuote.mockRejectedValue(new Error('no quote'));
    levelBook.getLevels.mockReturnValue(null);

    const out = await service.resolveExitPrices(EXCHANGE, ['T5']);

    expect(out.get('T5')).toEqual({ price: 0, fresh: false, source: 'none' });
  });

  it('returns an entry for every input token', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map([['A', 10]]));
    adapter.getLiveQuote.mockRejectedValue(new Error('no quote'));
    levelBook.getLevels.mockReturnValue(null);

    const out = await service.resolveExitPrices(EXCHANGE, ['A', 'B']);

    expect(out.size).toBe(2);
    expect(out.get('A')).toEqual({ price: 10, fresh: true, source: 'rest-batch' });
    expect(out.get('B')).toEqual({ price: 0, fresh: false, source: 'none' });
  });
});
