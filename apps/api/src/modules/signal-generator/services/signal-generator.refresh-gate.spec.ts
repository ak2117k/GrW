import { SignalGeneratorService } from './signal-generator.service';

/**
 * PERF gate: analyze() is polled ~every 60s by the chart Setup card. Each
 * poll used to call levelBookService.refreshFromBroker, which issues a fresh
 * Angel getHistoricalData('1d', …) REST call. These tests pin the gate that
 * makes the broker refresh a no-op while the cached daily statics are fresh.
 */
describe('SignalGeneratorService — refreshFromBroker staleness gate', () => {
  const TOKEN = '3045';
  const EXCHANGE = 'NSE';
  const SYMBOL = 'SBIN';

  function buildService() {
    const refreshFromBroker = jest.fn().mockResolvedValue(null);
    // lazyLoad returns null → analyze short-circuits to a no-setup result
    // right after the gate, so we isolate the gate behaviour.
    const lazyLoad = jest.fn().mockResolvedValue(null);

    const levelBookService = { refreshFromBroker, lazyLoad } as any;
    const setupTracker = { getActive: jest.fn().mockReturnValue(null) } as any;

    // The remaining constructor deps are never reached on the null-book path.
    const service = new SignalGeneratorService(
      {} as any, // strategyRegistry
      {} as any, // signalScoring
      {} as any, // signalRepository
      {} as any, // marketFeedService
      {} as any, // marketDataRepository
      {} as any, // angelOneAdapter
      {} as any, // settingsService
      {} as any, // signalGateway
      levelBookService,
      setupTracker,
      {} as any, // zoneRepository
    );

    return { service, refreshFromBroker, lazyLoad };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('refreshes the broker on the first analyze for a token', async () => {
    const { service, refreshFromBroker } = buildService();

    await service.analyze(TOKEN, EXCHANGE, SYMBOL, '15m');

    expect(refreshFromBroker).toHaveBeenCalledTimes(1);
    // The trailing `undefined` is the optional per-request CandleSource: this
    // caller supplies none, which is the contract that keeps every background
    // caller on the shared adapter exactly as before.
    expect(refreshFromBroker).toHaveBeenCalledWith(TOKEN, EXCHANGE, SYMBOL, undefined);
  });

  it('does NOT re-hit the broker on a second poll within the freshness window', async () => {
    const { service, refreshFromBroker } = buildService();

    await service.analyze(TOKEN, EXCHANGE, SYMBOL, '15m');
    // Simulate the ~60s poll cadence — well inside the 5-min window.
    await service.analyze(TOKEN, EXCHANGE, SYMBOL, '15m');
    await service.analyze(TOKEN, EXCHANGE, SYMBOL, '15m');

    expect(refreshFromBroker).toHaveBeenCalledTimes(1);
  });

  it('refreshes again once the freshness window has elapsed', async () => {
    jest.useFakeTimers();
    const { service, refreshFromBroker } = buildService();

    await service.analyze(TOKEN, EXCHANGE, SYMBOL, '15m');
    expect(refreshFromBroker).toHaveBeenCalledTimes(1);

    // Advance past the 5-min freshness window.
    jest.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    await service.analyze(TOKEN, EXCHANGE, SYMBOL, '15m');

    expect(refreshFromBroker).toHaveBeenCalledTimes(2);
  });

  it('tracks freshness per token independently', async () => {
    const { service, refreshFromBroker } = buildService();

    await service.analyze(TOKEN, EXCHANGE, SYMBOL, '15m');
    await service.analyze('500325', EXCHANGE, 'RELIANCE', '15m');

    expect(refreshFromBroker).toHaveBeenCalledTimes(2);
    expect(refreshFromBroker).toHaveBeenCalledWith(TOKEN, EXCHANGE, SYMBOL, undefined);
    expect(refreshFromBroker).toHaveBeenCalledWith('500325', EXCHANGE, 'RELIANCE', undefined);
  });
});
