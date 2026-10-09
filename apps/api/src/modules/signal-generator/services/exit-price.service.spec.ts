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

  it('tier 3 is NSE-only (H1): an NFO token is never priced from the token-only level book', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map());
    adapter.getLiveQuote.mockRejectedValue(new Error('no quote'));
    // The book is keyed by token alone: this is some NSE instrument that shares the token.
    levelBook.getLevels.mockReturnValue(makeBook({ spot: 305.75, lastTickAt: new Date() }));

    const out = await service.resolveExitPrices('NFO', ['T6']);

    expect(out.get('T6')).toEqual({ price: 0, fresh: false, source: 'none' });
    expect(levelBook.getLevels).not.toHaveBeenCalled();
  });

  it('tier 3 still serves an NSE token whatever the exchange string’s case', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map());
    adapter.getLiveQuote.mockRejectedValue(new Error('no quote'));
    levelBook.getLevels.mockReturnValue(makeBook({ spot: 305.75, lastTickAt: new Date() }));

    const out = await service.resolveExitPrices('nse', ['T7']);

    expect(out.get('T7')).toEqual({ price: 305.75, fresh: true, source: 'levelbook' });
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

  describe('a hub that silently stops serving is visible (I2)', () => {
    const hubZeroWarns = (warn: jest.SpyInstance) => warn.mock.calls.filter((c) => /hub served 0/.test(String(c[0])));

    it('10 consecutive legacy-only calls with the flag on → one warn, at most once per 10 min', async () => {
      adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2501]]));
      const svc = make();
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      for (let i = 0; i < 9; i++) await svc.resolveExitPrices('NSE', ['2885']);
      expect(hubZeroWarns(warn)).toHaveLength(0);
      await svc.resolveExitPrices('NSE', ['2885']); // the 10th in a row
      expect(hubZeroWarns(warn)).toHaveLength(1);

      for (let i = 0; i < 20; i++) await svc.resolveExitPrices('NSE', ['2885']);
      expect(hubZeroWarns(warn)).toHaveLength(1);
      jest.setSystemTime(Date.now() + 10 * 60_000);
      await svc.resolveExitPrices('NSE', ['2885']);
      expect(hubZeroWarns(warn)).toHaveLength(2);
    });

    it('a hub-served call resets the run', async () => {
      adapter.getLtpsBatch.mockResolvedValue(new Map([['1594', 1490]]));
      const svc = make();
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      for (let i = 0; i < 9; i++) await svc.resolveExitPrices('NSE', ['1594']);
      await svc.resolveExitPrices('NSE', ['2885']);
      await jest.advanceTimersByTimeAsync(0);
      broker.emitTick(FakeBroker.tick('2885', 2510, 'NSE'));
      await svc.resolveExitPrices('NSE', ['2885']); // hub-served
      for (let i = 0; i < 9; i++) await svc.resolveExitPrices('NSE', ['1594']);
      expect(hubZeroWarns(warn)).toHaveLength(0);
      await svc.resolveExitPrices('NSE', ['1594']); // the 10th since the reset
      expect(hubZeroWarns(warn)).toHaveLength(1);
    });

    it('a closed exchange is not a silent hub: market-closed answers for every token → no warn', async () => {
      adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2501]]));
      jest.setSystemTime(IST('2026-10-07T15:25:00'));
      const svc = make();
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      await svc.resolveExitPrices('NSE', ['2885']);
      await jest.advanceTimersByTimeAsync(0);
      broker.emitTick(FakeBroker.tick('2885', 2510, 'NSE'));
      await svc.resolveExitPrices('NSE', ['2885']); // hub-served: run starts at 0
      jest.setSystemTime(IST('2026-10-07T15:45:00')); // NSE shut

      for (let i = 0; i < 15; i++) {
        const out = await svc.resolveExitPrices('NSE', ['2885']);
        expect(out.get('2885')).toEqual({ price: 2501, fresh: true, source: 'rest-batch' });
      }

      expect(hubZeroWarns(warn)).toHaveLength(0);
    });

    it('a closed exchange with a never-priced token (overnight, after a restart) → no warn', async () => {
      adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2501]]));
      jest.setSystemTime(IST('2026-10-07T23:50:00'));
      const svc = make();
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      for (let i = 0; i < 15; i++) await svc.resolveExitPrices('NSE', ['2885']);

      expect(hubZeroWarns(warn)).toHaveLength(0);
    });

    it('closed-exchange calls neither extend nor reset the run: it warns after 10 OPEN hub=0 calls', async () => {
      // 15:45: NSE is shut, MCX trades until 23:30.
      jest.setSystemTime(IST('2026-10-07T15:45:00'));
      adapter.getLtpsBatch.mockImplementation(async (ex: string) =>
        ex === 'MCX' ? new Map([['445003', 6100]]) : new Map([['2885', 2501]]),
      );
      const svc = make();
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      for (let i = 0; i < 9; i++) {
        await svc.resolveExitPrices('MCX', ['445003']); // open, hub served 0
        await svc.resolveExitPrices('NSE', ['2885']); // closed: neutral
        await svc.resolveExitPrices('NSE', ['2885']);
      }
      expect(hubZeroWarns(warn)).toHaveLength(0);
      await svc.resolveExitPrices('MCX', ['445003']); // the 10th open hub=0 call
      expect(hubZeroWarns(warn)).toHaveLength(1);
    });

    it('never warns with the tracks flag off', async () => {
      adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2501]]));
      tracksOn = false;
      const svc = make();
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      for (let i = 0; i < 20; i++) await svc.resolveExitPrices('NSE', ['2885']);

      expect(hubZeroWarns(warn)).toHaveLength(0);
    });
  });

  describe('a throwing hub tier never costs the legacy price (H2)', () => {
    it('hub.prices throws → legacy still prices, no rejection, one rate-limited warn', async () => {
      adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2501]]));
      jest.spyOn(engine, 'prices').mockImplementation(() => {
        throw new Error('hub exploded');
      });
      const svc = make();
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      await expect(svc.resolveExitPrices('NSE', ['2885'])).resolves.toEqual(
        new Map([['2885', { price: 2501, fresh: true, source: 'rest-batch' }]]),
      );
      await expect(svc.resolveExitPrices('NSE', ['2885'])).resolves.toBeDefined();

      expect(adapter.getLtpsBatch).toHaveBeenCalledWith('NSE', ['2885']);
      expect(warn.mock.calls.filter((c) => /hub tier failed/.test(String(c[0])))).toHaveLength(1);
    });

    it('a throwing record() never rejects the exit price either', async () => {
      adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2501]]));
      record.mockImplementation(() => {
        throw new Error('counter exploded');
      });
      const svc = make();
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      const out = await svc.resolveExitPrices('NSE', ['2885']);

      expect(out.get('2885')).toEqual({ price: 2501, fresh: true, source: 'rest-batch' });
    });
  });

  it('an exchange the hub does not speak (CDS) stays on the legacy path', async () => {
    adapter.getLtpsBatch.mockResolvedValue(new Map([['1', 83.2]]));

    const out = await make().resolveExitPrices('CDS', ['1']);

    expect(out.get('1')).toEqual({ price: 83.2, fresh: true, source: 'rest-batch' });
    expect(engine.registry.size()).toBe(0);
  });
});
