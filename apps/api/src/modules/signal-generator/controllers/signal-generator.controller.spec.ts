import { SignalGeneratorController } from './signal-generator.controller';

/**
 * Focused unit tests for the interval-aware /zones and /sr-evidence wiring.
 *
 * The controller is constructed directly with mock deps (constructor
 * positional order). The non-15m chart path MUST NOT touch the shared zone
 * DB — these tests assert findActiveByToken / upsertMany are never called for
 * non-15m, and that the 15m path (and no-interval default) behave exactly as
 * before (DB read + persist) — the frozen-trading-path regression guard.
 */
describe('SignalGeneratorController — interval-aware S/R endpoints', () => {
  const book = { spot: 100, atr14: 5 };
  // Enough synthetic candles to clear the < 10 guard.
  const candles = Array.from({ length: 30 }, (_, i) => ({
    timestamp: new Date(2026, 0, 1, 9, 15 + i),
    open: 100,
    high: 101 + (i % 3),
    low: 99 - (i % 3),
    close: 100,
    volume: 1000,
  }));

  function build(overrides: Partial<any> = {}) {
    const zoneRepository = {
      findActiveByToken: jest.fn().mockResolvedValue([]),
      upsertMany: jest.fn().mockResolvedValue(0),
    };
    const strongZoneDetector = { detectZones: jest.fn().mockReturnValue([{ id: 'z1' }]) };
    const levelBookService = { lazyLoad: jest.fn().mockResolvedValue(book) };
    const marketDataRepository = {
      getInstrumentByToken: jest.fn().mockResolvedValue({ id: 'i1', symbol: 'CUPID', exchange: 'NSE' }),
      getCandles: jest.fn().mockResolvedValue([]),
    };
    const angelOneAdapter = { getHistoricalData: jest.fn().mockResolvedValue(candles) };
    const srEvidenceService = { levelsFor: jest.fn().mockResolvedValue([]) };

    const deps = {
      zoneRepository,
      strongZoneDetector,
      levelBookService,
      marketDataRepository,
      angelOneAdapter,
      srEvidenceService,
      ...overrides,
    };

    const ctrl = new SignalGeneratorController(
      {} as never, // signalGeneratorService
      {} as never, // strategyRegistry
      {} as never, // signalRepository
      {} as never, // universeScannerWorker
      {} as never, // setupTracker
      {} as never, // signalScanQueue
      undefined as never, // chartinkRepo
      deps.zoneRepository as never,
      deps.strongZoneDetector as never,
      deps.levelBookService as never,
      deps.marketDataRepository as never,
      deps.angelOneAdapter as never,
      deps.srEvidenceService as never,
    );
    return { ctrl, deps };
  }

  // The chart-display reads are subscription-gated; an ADMIN user bypasses the
  // check (so these unit tests don't need a wired SubscriptionService).
  const ADMIN = { userId: 'u1', role: 'ADMIN' } as never;

  describe('getZones', () => {
    it("non-15m (interval='5m'): never reads or writes the shared zone DB; detects with interval", async () => {
      const { ctrl, deps } = build();
      const zones = await ctrl.getZones(ADMIN, '18520', 'NSE', 'CUPID', '5m');
      expect(deps.zoneRepository.findActiveByToken).not.toHaveBeenCalled();
      expect(deps.zoneRepository.upsertMany).not.toHaveBeenCalled();
      expect(deps.strongZoneDetector.detectZones).toHaveBeenCalledWith(
        expect.objectContaining({ interval: '5m' }),
      );
      expect(zones).toEqual([{ id: 'z1' }]);
    });

    it('regression: no interval ⇒ reads DB cache then persists (frozen 15m path)', async () => {
      const { ctrl, deps } = build();
      await ctrl.getZones(ADMIN, '18520', 'NSE', 'CUPID');
      expect(deps.zoneRepository.findActiveByToken).toHaveBeenCalledWith('18520');
      // Cache miss → compute + persist (upsertMany) as today.
      expect(deps.zoneRepository.upsertMany).toHaveBeenCalledWith('18520', [{ id: 'z1' }]);
      expect(deps.strongZoneDetector.detectZones).toHaveBeenCalledWith(
        expect.objectContaining({ interval: '15m', atr14: book.atr14 }),
      );
    });

    it("regression: explicit interval='15m' behaves like no interval (DB read + persist)", async () => {
      const { ctrl, deps } = build();
      await ctrl.getZones(ADMIN, '18520', 'NSE', 'CUPID', '15m');
      expect(deps.zoneRepository.findActiveByToken).toHaveBeenCalledWith('18520');
      expect(deps.zoneRepository.upsertMany).toHaveBeenCalled();
    });

    it("invalid interval='foo' ⇒ treated as 15m (DB read + persist)", async () => {
      const { ctrl, deps } = build();
      await ctrl.getZones(ADMIN, '18520', 'NSE', 'CUPID', 'foo');
      expect(deps.zoneRepository.findActiveByToken).toHaveBeenCalledWith('18520');
      expect(deps.strongZoneDetector.detectZones).toHaveBeenCalledWith(
        expect.objectContaining({ interval: '15m' }),
      );
    });

    it('15m cache hit returns persisted zones without computing', async () => {
      const { ctrl, deps } = build({
        zoneRepository: {
          findActiveByToken: jest.fn().mockResolvedValue([{ id: 'cached' }]),
          upsertMany: jest.fn(),
        },
      });
      const zones = await ctrl.getZones(ADMIN, '18520', 'NSE', 'CUPID');
      expect(zones).toEqual([{ id: 'cached' }]);
      expect(deps.strongZoneDetector.detectZones).not.toHaveBeenCalled();
    });

    it("non-15m fetches candles at the selected interval with per-TF lookback", async () => {
      const { ctrl, deps } = build();
      await ctrl.getZones(ADMIN, '18520', 'NSE', 'CUPID', '1m');
      const call = deps.angelOneAdapter.getHistoricalData.mock.calls[0];
      expect(call[2]).toBe('1m');
      const days = (call[4].getTime() - call[3].getTime()) / (24 * 60 * 60 * 1000);
      expect(days).toBeCloseTo(1, 1);
    });
  });

  describe('getSrEvidence', () => {
    it("passes the validated interval through to levelsFor (interval='5m')", async () => {
      const { ctrl, deps } = build();
      await ctrl.getSrEvidence(ADMIN, '18520', 'NSE', 'CUPID', '5m');
      expect(deps.srEvidenceService.levelsFor).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '5m');
    });

    it('regression: no interval ⇒ levelsFor called with 15m', async () => {
      const { ctrl, deps } = build();
      await ctrl.getSrEvidence(ADMIN, '18520', 'NSE', 'CUPID');
      expect(deps.srEvidenceService.levelsFor).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '15m');
    });

    it("invalid interval ⇒ levelsFor called with 15m", async () => {
      const { ctrl, deps } = build();
      await ctrl.getSrEvidence(ADMIN, '18520', 'NSE', 'CUPID', 'bogus');
      expect(deps.srEvidenceService.levelsFor).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '15m');
    });

    it.each(['1d', '1w', '1mo'])(
      "positional interval='%s' is accepted as its own timeframe (not collapsed to 15m)",
      async (tf) => {
        const { ctrl, deps } = build();
        await ctrl.getSrEvidence(ADMIN, '18520', 'NSE', 'CUPID', tf);
        expect(deps.srEvidenceService.levelsFor).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', tf);
      },
    );

    it("normalizes Yahoo-style '1M' to '1mo'", async () => {
      const { ctrl, deps } = build();
      await ctrl.getSrEvidence(ADMIN, '18520', 'NSE', 'CUPID', '1M');
      expect(deps.srEvidenceService.levelsFor).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '1mo');
    });
  });
});

/**
 * The ML data-capture ops triggers. These are what actually cause Phase 1 to
 * produce a training set — nothing else calls the backfill or the resolver.
 * Both are ADMIN-only via the class-level @AdminOnly(); they are driven by an
 * external heartbeat because the free tier idles the in-process scheduler out.
 */
describe('SignalGeneratorController — ML capture triggers', () => {
  const TARGET = { token: '2885', exchange: 'NSE', symbol: 'RELIANCE' };

  function build(overrides: Partial<any> = {}) {
    const deps = {
      patternBackfill: {
        run: jest.fn().mockResolvedValue([
          { target: 'RELIANCE', timeframe: '15m', observations: 4 },
          { target: 'RELIANCE', timeframe: '1h', observations: 3 },
        ]),
      },
      patternCapture: { resolvePending: jest.fn().mockResolvedValue(7) },
      ...overrides,
    };
    const ctrl = new SignalGeneratorController(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      undefined as never, undefined as never, undefined as never, undefined as never,
      undefined as never, undefined as never, undefined as never, undefined as never,
      deps.patternBackfill as never,
      deps.patternCapture as never,
    );
    return { ctrl, deps };
  }

  describe('triggerPatternBackfill', () => {
    it('runs the backfill for the posted targets and totals the rows written', async () => {
      const { ctrl, deps } = build();
      const res = await ctrl.triggerPatternBackfill({ targets: [TARGET] });
      expect(deps.patternBackfill.run).toHaveBeenCalledWith([TARGET], {
        timeframes: undefined,
        lookbackDays: undefined,
      });
      // 4 + 3 — a handler that returned results.length would say 2.
      expect(res).toEqual(
        expect.objectContaining({ ok: true, targets: 1, observations: 7 }),
      );
      expect(res.results).toHaveLength(2);
    });

    it('passes timeframes and lookbackDays through', async () => {
      const { ctrl, deps } = build();
      await ctrl.triggerPatternBackfill({
        targets: [TARGET], timeframes: ['15m'], lookbackDays: 30,
      });
      expect(deps.patternBackfill.run).toHaveBeenCalledWith([TARGET], {
        timeframes: ['15m'], lookbackDays: 30,
      });
    });

    it.each([
      ['missing body', {}],
      ['empty targets', { targets: [] }],
    ])('rejects %s with 400 and never calls the service', async (_label, body) => {
      const { ctrl, deps } = build();
      await expect(ctrl.triggerPatternBackfill(body)).rejects.toMatchObject({ status: 400 });
      expect(deps.patternBackfill.run).not.toHaveBeenCalled();
    });

    it('rejects a target missing token/exchange/symbol with 400', async () => {
      const { ctrl, deps } = build();
      await expect(
        ctrl.triggerPatternBackfill({ targets: [{ token: '2885' } as never] }),
      ).rejects.toMatchObject({ status: 400 });
      expect(deps.patternBackfill.run).not.toHaveBeenCalled();
    });

    it('503s when the backfill service is not wired', async () => {
      const { ctrl } = build({ patternBackfill: undefined });
      await expect(
        ctrl.triggerPatternBackfill({ targets: [TARGET] }),
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('triggerResolvePending', () => {
    it('resolves pending rows and returns the count', async () => {
      const { ctrl, deps } = build();
      const res = await ctrl.triggerResolvePending({});
      expect(deps.patternCapture.resolvePending).toHaveBeenCalledWith(undefined);
      expect(res).toEqual({ ok: true, resolved: 7 });
    });

    it('passes an explicit limit through', async () => {
      const { ctrl, deps } = build();
      await ctrl.triggerResolvePending({ limit: 25 });
      expect(deps.patternCapture.resolvePending).toHaveBeenCalledWith(25);
    });

    it('503s when the capture service is not wired', async () => {
      const { ctrl } = build({ patternCapture: undefined });
      await expect(ctrl.triggerResolvePending({})).rejects.toMatchObject({ status: 503 });
    });
  });
});
