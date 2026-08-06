import { SignalGeneratorController } from './signal-generator.controller';
import { ChartContextService } from '../services/chart-context.service';

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
  // Anchored level snapshot as analyze() returns it.
  const LEVELS = { pdh: 110, pdl: 90, vwap: 100, atr14: 5 };
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
    const patternCapture = { capture: jest.fn().mockResolvedValue(2) };
    // /chart-context takes its anchored levels from analyze()'s `levels`.
    const signalGeneratorService = {
      analyze: jest.fn().mockResolvedValue({ kind: 'no-setup', levels: LEVELS }),
    };
    const chartContextService = new ChartContextService();

    const deps = {
      signalGeneratorService,
      chartContextService,
      zoneRepository,
      strongZoneDetector,
      levelBookService,
      marketDataRepository,
      angelOneAdapter,
      srEvidenceService,
      patternCapture,
      ...overrides,
    };

    const ctrl = new SignalGeneratorController(
      deps.signalGeneratorService as never,
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
      undefined as never, // subs
      deps.patternCapture as never,
      deps.chartContextService as never,
    );
    return { ctrl, deps };
  }

  // The chart-display reads are subscription-gated; an ADMIN user bypasses the
  // check (so these unit tests don't need a wired SubscriptionService).
  const ADMIN = { userId: 'u1', role: 'ADMIN' } as never;

  /**
   * The Phase 1 finish task: `/patterns` is the ONLY place live detections can be
   * recorded from, so if `capture(...)` isn't called here it isn't called at all —
   * `PatternCaptureService` becomes elaborate dead code and the training set is
   * backfill-only, silently.
   *
   * Nothing about that failure is visible from the service's own unit tests: they
   * prove `capture` WORKS, never that it is REACHED. These tests are the ones that
   * pin reachability, so they assert on the call itself rather than on any output.
   */
  describe('getPatterns — live ML capture', () => {
    const ADMIN_USER = { userId: 'u1', role: 'ADMIN' } as never;

    it('captures the detected patterns for the ML training set', async () => {
      const { ctrl, deps } = build();

      await ctrl.getPatterns(ADMIN_USER, '18520', 'NSE', '15m');

      expect(deps.patternCapture.capture).toHaveBeenCalledTimes(1);
      const [capturedCandles, markers, meta] = deps.patternCapture.capture.mock.calls[0];
      // Tagged with the resolved instrument + the requested timeframe: these three
      // are the row's identity, and a row mis-tagged here is unusable forever.
      expect(meta).toEqual({ token: '18520', exchange: 'NSE', timeframe: '15m' });
      expect(Array.isArray(markers)).toBe(true);
      // The assembler needs volume; the detector's Candle type doesn't carry it.
      // A window of volume-less candles would poison every row it writes.
      expect(capturedCandles).toHaveLength(candles.length);
      expect(capturedCandles[0]).toEqual(
        expect.objectContaining({ time: expect.any(Number), volume: 1000 }),
      );
    });

    it('defaults the timeframe tag to 15m, matching what was detected', async () => {
      const { ctrl, deps } = build();

      await ctrl.getPatterns(ADMIN_USER, '18520', 'NSE');

      expect(deps.patternCapture.capture.mock.calls[0][2]).toEqual(
        expect.objectContaining({ timeframe: '15m' }),
      );
    });

    // Capture is a training-data side effect on a user-facing chart read. It must
    // never be able to break the overlay, and must not add latency to it.
    it('still returns the patterns when capture rejects (fail-open)', async () => {
      const { ctrl } = build({
        patternCapture: { capture: jest.fn().mockRejectedValue(new Error('db down')) },
      });

      const res = await ctrl.getPatterns(ADMIN_USER, '18520', 'NSE', '15m');

      expect(res).toEqual(expect.objectContaining({ symbol: 'CUPID', timeframe: '15m' }));
      // Let the rejected detached promise settle — an unhandled rejection can take
      // the Node process down.
      await new Promise((r) => setImmediate(r));
    });

    it('does not await the capture write', async () => {
      let finished = false;
      const { ctrl } = build({
        patternCapture: {
          capture: jest.fn().mockImplementation(
            () => new Promise((resolve) => setTimeout(() => { finished = true; resolve(1); }, 50)),
          ),
        },
      });

      await ctrl.getPatterns(ADMIN_USER, '18520', 'NSE', '15m');

      // The overlay is on the <500ms market-data path; a DB write must not sit in
      // front of it.
      expect(finished).toBe(false);
    });

    it('constructs cleanly and still serves patterns when capture is unwired', async () => {
      // @Optional() — non-ML test wirings and any container without the ML
      // providers must keep working.
      const { ctrl } = build({ patternCapture: undefined });

      await expect(ctrl.getPatterns(ADMIN_USER, '18520', 'NSE', '15m')).resolves.toEqual(
        expect.objectContaining({ symbol: 'CUPID' }),
      );
    });

    it('captures nothing when there are too few candles to detect', async () => {
      // The <25-candle guard returns early with an empty list — there is nothing
      // to record, and a capture call here would write rows off a stub window.
      const { ctrl, deps } = build({
        angelOneAdapter: { getHistoricalData: jest.fn().mockResolvedValue(candles.slice(0, 10)) },
      });

      const res = await ctrl.getPatterns(ADMIN_USER, '18520', 'NSE', '15m');

      expect(res.count).toBe(0);
      expect(deps.patternCapture.capture).not.toHaveBeenCalled();
    });
  });

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

  /**
   * /chart-context is the charts page's single S/R read. The behaviour that
   * matters is degradation: the page must be able to tell "loading" from
   * "broken" from "genuinely no levels", so a partial outage must return the
   * surviving data with an honest per-source state, and a total outage must
   * still be a 200 the chart can render.
   */
  describe('getChartContext', () => {
    it('composes levels + zones + evidence into one ready response', async () => {
      const { ctrl, deps } = build({
        srEvidenceService: { levelsFor: jest.fn().mockResolvedValue([{ price: 105 }]) },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      expect(dto).toEqual({
        interval: '5m',
        analysis: { kind: 'no-setup', levels: LEVELS },
        zones: [{ id: 'z1' }],
        evidence: [{ price: 105 }],
        trend: null,
        status: 'ready',
        sources: { analysis: 'ok', zones: 'ok', evidence: 'ok', trend: 'empty' },
      });
      // Composed from the SAME services the three routes use, at the SAME
      // interval — no re-implemented or retuned scoring.
      expect(deps.signalGeneratorService.analyze).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '5m');
      expect(deps.srEvidenceService.levelsFor).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '5m');
      expect(deps.strongZoneDetector.detectZones).toHaveBeenCalledWith(
        expect.objectContaining({ interval: '5m' }),
      );
    });

    it('one failing source yields partial with the other sources intact', async () => {
      const { ctrl } = build({
        levelBookService: { lazyLoad: jest.fn().mockRejectedValue(new Error('book down')) },
        srEvidenceService: { levelsFor: jest.fn().mockResolvedValue([{ price: 105 }]) },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      expect(dto.status).toBe('partial');
      expect(dto.sources.zones).toBe('failed');
      expect(dto.sources.evidence).toBe('ok');
      expect(dto.evidence).toEqual([{ price: 105 }]);
      expect(dto.analysis).toEqual({ kind: 'no-setup', levels: LEVELS });
    });

    it('all sources failing is status unavailable, NOT a thrown error', async () => {
      const boom = new Error('down');
      const { ctrl } = build({
        signalGeneratorService: { analyze: jest.fn().mockRejectedValue(boom) },
        levelBookService: { lazyLoad: jest.fn().mockRejectedValue(boom) },
        srEvidenceService: { levelsFor: jest.fn().mockRejectedValue(boom) },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      expect(dto.status).toBe('unavailable');
      expect(dto.sources).toEqual({
        analysis: 'failed',
        zones: 'failed',
        evidence: 'failed',
        trend: 'empty',
      });
      expect(dto.analysis).toBeNull();
      expect(dto.zones).toEqual([]);
      expect(dto.evidence).toEqual([]);
    });

    it('empty-but-successful sources are ready with empty states', async () => {
      const { ctrl } = build({
        signalGeneratorService: {
          analyze: jest.fn().mockResolvedValue({ kind: 'no-setup', levels: null }),
        },
        strongZoneDetector: { detectZones: jest.fn().mockReturnValue([]) },
        srEvidenceService: { levelsFor: jest.fn().mockResolvedValue([]) },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      // "This symbol genuinely has no levels right now" — a fact the chip is
      // allowed to state, unlike the other two states.
      expect(dto.status).toBe('ready');
      expect(dto.sources).toEqual({
        analysis: 'empty',
        zones: 'empty',
        evidence: 'empty',
        trend: 'empty',
      });
    });

    it.each(['1d', '1w', '1mo'])('accepts positional interval %s', async (tf) => {
      const { ctrl } = build();
      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', tf, 'CUPID');
      expect(dto.interval).toBe(tf);
    });

    it("normalizes Yahoo-style '1M' to '1mo'", async () => {
      const { ctrl } = build();
      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '1M', 'CUPID');
      expect(dto.interval).toBe('1mo');
    });

    it('rejects an unsupported interval with 400', async () => {
      const { ctrl } = build();
      // `4h` is the exact drift that caused the bug — it must be refused loudly
      // rather than silently analysed on the 15m window.
      await expect(ctrl.getChartContext(ADMIN, '18520', 'NSE', '4h', 'CUPID')).rejects.toThrow(
        /unsupported interval/,
      );
    });

    it('defaults an omitted interval to 15m', async () => {
      const { ctrl } = build();
      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE');
      expect(dto.interval).toBe('15m');
    });

    it('requires a token', async () => {
      const { ctrl } = build();
      await expect(ctrl.getChartContext(ADMIN, '' as never, 'NSE', '5m')).rejects.toThrow(
        /token is required/,
      );
    });

    it('resolves the symbol from the token when the caller omits it', async () => {
      const { ctrl, deps } = build();
      await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m');
      expect(deps.signalGeneratorService.analyze).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '5m');
    });
  });
});
