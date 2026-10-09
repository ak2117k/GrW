import { EXIT_WATCH_OWNER, ExitPriceService } from './exit-price.service';
import { HubEngine } from '../../market-hub/hub-engine';
import { engineHubPrices, type HubPriceSource } from '../../market-hub/hub-prices';
import { SessionClock } from '../../market-hub/session-clock';
import { FakeBroker } from '../../market-hub/testing/fake-broker';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
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

describe('ExitPriceService — hub tier (HUB_PRICES_TRACKS)', () => {
  const IST = (local: string) => Date.parse(`${local}+05:30`);
  let engine: HubEngine;
  let broker: FakeBroker;
  let adapter: { getLtpsBatch: jest.Mock; getLiveQuote: jest.Mock };
  let levelBook: { getLevels: jest.Mock };
  let record: jest.Mock;
  let tracksOn: boolean;
  let source: HubPriceSource;

  const make = (moduleRef: unknown = { get: jest.fn(() => source) }) =>
    new ExitPriceService(adapter as unknown as AngelOneAdapterService, levelBook as unknown as LevelBookService, moduleRef as never);

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(IST('2026-10-07T10:00:00'));
    broker = new FakeBroker();
    engine = new HubEngine({ broker, clock: new SessionClock({ holidays: MARKET_HOLIDAYS }), cap: 50, defaults: [] });
    await engine.start();
    broker.emitState('live'); // socket up: prices only arrive when a test emits them
    adapter = {
      getLtpsBatch: jest.fn().mockResolvedValue(new Map()),
      getLiveQuote: jest.fn().mockRejectedValue(new Error('Not authenticated (no feed account)')),
    };
    levelBook = { getLevels: jest.fn().mockReturnValue(null) };
    record = jest.fn();
    tracksOn = true;
    source = {
      hubFor: jest.fn((userId: string | null, consumer: string) =>
        tracksOn && userId === null && consumer === 'tracks' ? engineHubPrices(engine) : null,
      ),
      record,
    };
  });

  afterEach(() => {
    engine.stop();
    jest.useRealTimers();
  });

  it('a never-priced ref is watched at priority 3 and falls back to the legacy tiers — never a hub price of 0', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2501]]));
    const svc = make();

    const out = await svc.resolveExitPrices('NSE', ['2885'], new Map([['2885', 'RELIANCE']]));
    await jest.advanceTimersByTimeAsync(0);

    expect(out.get('2885')).toEqual({ price: 2501, fresh: true, source: 'rest-batch' });
    expect(adapter.getLtpsBatch).toHaveBeenCalledWith('NSE', ['2885']);
    const entry = engine.registry.entries().find((e) => e.ref.token === '2885');
    expect(entry).toMatchObject({ priority: 3, ref: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE' } });
    expect(broker.subscribed.has('NSE:2885')).toBe(true);
    expect(record).toHaveBeenCalledWith('tracks', 'legacy', 1);
    expect(record).toHaveBeenCalledWith('tracks', 'hub', 0);
  });

  it('serves a fresh hub price with source hub and spends no legacy call on it', async () => {
    const svc = make();
    await svc.resolveExitPrices('NSE', ['2885']);
    await jest.advanceTimersByTimeAsync(0);
    broker.emitTick(FakeBroker.tick('2885', 2510, 'NSE'));
    adapter.getLtpsBatch.mockClear();

    const out = await svc.resolveExitPrices('NSE', ['2885']);

    expect(out.get('2885')).toEqual({ price: 2510, fresh: true, source: 'hub' });
    expect(adapter.getLtpsBatch).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith('tracks', 'hub', 1);
  });

  it('asks the legacy batch only for the tokens the hub could not serve, and keeps input order', async () => {
    const svc = make();
    await svc.resolveExitPrices('NSE', ['2885', '1594']);
    await jest.advanceTimersByTimeAsync(0);
    broker.emitTick(FakeBroker.tick('2885', 2510, 'NSE'));
    adapter.getLtpsBatch.mockReset().mockResolvedValue(new Map([['1594', 1490]]));

    const out = await svc.resolveExitPrices('NSE', ['1594', '2885']);

    expect(adapter.getLtpsBatch).toHaveBeenCalledWith('NSE', ['1594']);
    expect([...out.keys()]).toEqual(['1594', '2885']);
    expect(out.get('1594')).toEqual({ price: 1490, fresh: true, source: 'rest-batch' });
    expect(out.get('2885')).toEqual({ price: 2510, fresh: true, source: 'hub' });
  });

  it('at 15:25 a hub price older than 10 s is not fresh; with no legacy price the answer is none', async () => {
    jest.setSystemTime(IST('2026-10-07T15:25:00'));
    const svc = make();
    await svc.resolveExitPrices('NSE', ['2885']);
    await jest.advanceTimersByTimeAsync(0);
    broker.emitTick(FakeBroker.tick('2885', 2510, 'NSE'));
    jest.setSystemTime(Date.now() + 11_000);

    const out = await svc.resolveExitPrices('NSE', ['2885']);

    expect(out.get('2885')).toEqual({ price: 0, fresh: false, source: 'none' });
    expect(adapter.getLiveQuote).toHaveBeenCalledWith('2885', 'NSE');
    expect(record).toHaveBeenCalledWith('tracks', 'unpriced', 1);
  });

  it('the watch expires 2 min after the last call, and every call renews it', async () => {
    const svc = make();
    const t0 = Date.now();
    await svc.resolveExitPrices('NSE', ['2885']);
    jest.setSystemTime(t0 + 90_000);
    await svc.resolveExitPrices('NSE', ['2885']); // renews until t0 + 210 s
    jest.setSystemTime(t0 + 150_000);
    await jest.advanceTimersByTimeAsync(30_000); // maintenance runs at ≤ t0 + 180 s
    expect(engine.registry.has('NSE:2885')).toBe(true);

    jest.setSystemTime(t0 + 210_001);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(engine.registry.has('NSE:2885')).toBe(false);
    expect(EXIT_WATCH_OWNER).toBe('track:exit');
  });

  it('takes the legacy path untouched when the tracks flag is off, the hub is absent, or the lookup throws', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2501]]));
    tracksOn = false;
    const flagOff = await make().resolveExitPrices('NSE', ['2885']);
    const noHub = await new ExitPriceService(adapter as unknown as AngelOneAdapterService, levelBook as unknown as LevelBookService).resolveExitPrices('NSE', ['2885']);
    const throws = await make({ get: jest.fn(() => { throw new Error('Nest could not find HUB_PRICE_SOURCE'); }) }).resolveExitPrices('NSE', ['2885']);

    for (const out of [flagOff, noHub, throws]) {
      expect(out.get('2885')).toEqual({ price: 2501, fresh: true, source: 'rest-batch' });
    }
    expect(engine.registry.size()).toBe(0); // nothing was watched
  });

  it('an exchange the hub does not speak (CDS) stays on the legacy path', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map([['1', 83.2]]));

    const out = await make().resolveExitPrices('CDS', ['1']);

    expect(out.get('1')).toEqual({ price: 83.2, fresh: true, source: 'rest-batch' });
    expect(engine.registry.size()).toBe(0);
  });
});
