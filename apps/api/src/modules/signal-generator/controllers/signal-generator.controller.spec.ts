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

  /**
   * Candle series /chart-context's trend source reads (SrEvidenceService
   * .candlesFor). A clean staircase uptrend — rising baseline with a deep dip
   * every 8 bars — so the fit has four rising swing lows and yields a line.
   */
  const TREND_T0 = 1_700_000_000;
  const trendCandles = Array.from({ length: 40 }, (_, i) => {
    const base = 100 + 0.5 * i;
    const isDip = i % 8 === 0 && i >= 8 && i <= 32;
    return {
      time: TREND_T0 + i * 900,
      high: base + 1,
      low: isDip ? base - 5 : base,
      close: base,
      volume: 1000,
    };
  });
  /** Flat bars — the fit runs and legitimately finds nothing. */
  const flatCandles = Array.from({ length: 40 }, (_, i) => ({
    time: TREND_T0 + i * 900,
    high: 105,
    low: 95,
    close: 100,
    volume: 1000,
  }));

  function build(overrides: Partial<any> = {}) {
    const zoneRepository = {
      findActiveByToken: jest.fn().mockResolvedValue([]),
      upsertMany: jest.fn().mockResolvedValue(0),
    };
    const strongZoneDetector = { detectZones: jest.fn().mockReturnValue([{ id: 'z1' }]) };
    // getLevels is the in-memory read the trade plan takes spot from. The
    // default book is a LIVE one (spot 100); the overnight case — spot 0
    // because no tick has ever landed — is exercised explicitly below.
    const levelBookService = {
      lazyLoad: jest.fn().mockResolvedValue(book),
      getLevels: jest.fn().mockReturnValue(book),
    };
    const marketDataRepository = {
      getInstrumentByToken: jest.fn().mockResolvedValue({ id: 'i1', symbol: 'CUPID', exchange: 'NSE' }),
      getCandles: jest.fn().mockResolvedValue([]),
    };
    const angelOneAdapter = { getHistoricalData: jest.fn().mockResolvedValue(candles) };
    const srEvidenceService = {
      levelsFor: jest.fn().mockResolvedValue([]),
      candlesFor: jest.fn().mockResolvedValue(trendCandles),
    };
    const patternCapture = { capture: jest.fn().mockResolvedValue(2) };
    // /chart-context takes its anchored levels from analyze()'s `levels`.
    const signalGeneratorService = {
      analyze: jest.fn().mockResolvedValue({ kind: 'no-setup', levels: LEVELS }),
    };
    const chartContextService = new ChartContextService();
    // The per-user feed. /chart-context must read candles through the SIGNED-IN
    // USER's own Angel session — the shared adapter has no feed account to log
    // in with on this platform, which is why the S/R engine returned [] for
    // every symbol and timeframe until this was wired.
    const userFeedManager = { fetchCandles: jest.fn().mockResolvedValue(candles) };

    const deps = {
      signalGeneratorService,
      chartContextService,
      userFeedManager,
      zoneRepository,
      strongZoneDetector,
      levelBookService,
      marketDataRepository,
      angelOneAdapter,
      patternCapture,
      ...overrides,
      // The trend source pulls its candles from this same service. Tests
      // override `srEvidenceService` to steer the LEVELS, so merge rather than
      // replace — otherwise a levels-focused override silently breaks the
      // trend source and the assertion under test drifts.
      srEvidenceService: overrides.srEvidenceService
        ? { ...srEvidenceService, ...overrides.srEvidenceService }
        : srEvidenceService,
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
      deps.userFeedManager as never,
    );
    return { ctrl, deps };
  }

  // The chart-display reads are subscription-gated; an ADMIN user bypasses the
  // check (so these unit tests don't need a wired SubscriptionService).
  const ADMIN = { userId: 'u1', role: 'ADMIN' } as never;

  /** The per-request CandleSource the user-scoped path threads into its loaders. */
  const CANDLE_SOURCE = expect.objectContaining({ getCandles: expect.any(Function) });

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
    /**
     * The clock is PINNED because the projection's session budget reads it: the
     * travel still available depends on how much of the session is left, so
     * outside market hours the budget is zero and every box is correctly
     * suppressed. Left on the wall clock these tests would pass during the
     * session and fail after it — green when written, red overnight, with
     * nothing changed. Mid-session so the budget is generous and the assertions
     * are about composition rather than about the cap.
     */
    beforeEach(() => {
      // 2026-08-10T05:00:00Z == 10:30 IST, a bit over an hour into the session.
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date('2026-08-10T05:00:00Z'));
    });
    afterEach(() => jest.useRealTimers());

    it('composes levels + zones + evidence + trend + plan into one ready response', async () => {
      const { ctrl, deps } = build({
        srEvidenceService: { levelsFor: jest.fn().mockResolvedValue([{ price: 105 }]) },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      expect(dto).toEqual({
        interval: '5m',
        analysis: { kind: 'no-setup', levels: LEVELS },
        zones: [{ id: 'z1' }],
        evidence: [{ price: 105 }],
        trend: expect.objectContaining({ kind: 'uptrend', touches: 4 }),
        // Spot 100 sits between PDL 90 and PDH 110, so the plan arms a long
        // above and a short below — the two lines the chart draws.
        tradePlan: {
          active: null,
          above: expect.objectContaining({ side: 'BUY', levelSource: 'PDH', triggerPrice: 110 }),
          below: expect.objectContaining({ side: 'SELL', levelSource: 'PDL', triggerPrice: 90 }),
        },
        // The zone mock is a bare {id}, not a real StrongZone — but the level
        // book still carries PDH 110 / PDL 90 around spot 100, and levels are
        // the fallback anchor. This is the index case: a chart with visible
        // levels and no detected zones must still project. Spec §0.4.
        projections: expect.objectContaining({
          up: expect.objectContaining({ side: 'UP', state: 'armed' }),
        }),
        status: 'ready',
        sources: {
          analysis: 'ok',
          zones: 'ok',
          evidence: 'ok',
          trend: 'ok',
          tradePlan: 'ok',
          projections: 'ok',
        },
      });
      expect(dto.trend!.slope).toBeGreaterThan(0);
      expect(dto.trend!.r2).toBeGreaterThanOrEqual(0.75);
      // Composed from the SAME services the four routes use, at the SAME
      // interval — no re-implemented or retuned scoring. The trend candles
      // come from the evidence service's own per-timeframe series, so the
      // line and the levels can't be derived from different data.
      expect(deps.signalGeneratorService.analyze).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '5m', CANDLE_SOURCE);
      expect(deps.srEvidenceService.levelsFor).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '5m', CANDLE_SOURCE);
      expect(deps.srEvidenceService.candlesFor).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '5m', CANDLE_SOURCE);
      expect(deps.strongZoneDetector.detectZones).toHaveBeenCalledWith(
        expect.objectContaining({ interval: '5m' }),
      );
    });

    /**
     * The overnight/weekend bug this test exists to prevent.
     *
     * `book.spot` is written in exactly ONE place — updateFromTick — and seeded
     * to 0. lazyLoad's 5m replay would fill it, but lazyLoad windows that fetch
     * as [today 09:15 IST, now], which before the open (or on a weekend) is an
     * inverted range returning zero bars. So the book comes back with spot 0,
     * the plan refuses to place triggers around a non-price, and the chart
     * silently drew nothing while the S/R chip — which uses the CLIENT's ltp —
     * happily showed levels.
     *
     * The plan must anchor on a price that exists whenever the chart has bars.
     */
    it('still builds a plan when the book has no tick-fed spot (overnight)', async () => {
      const { ctrl } = build({
        levelBookService: {
          lazyLoad: jest.fn().mockResolvedValue({ spot: 0, atr14: 5 }),
          getLevels: jest.fn().mockReturnValue({ spot: 0, atr14: 5 }),
        },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      // Last close of the trend series is 119.5, which sits above every
      // anchored level — so the short below is the trigger that qualifies.
      expect(dto.sources.tradePlan).toBe('ok');
      expect(dto.tradePlan.below).not.toBeNull();
      expect(dto.tradePlan.below!.side).toBe('SELL');
    });

    it('leaves the plan empty — not fabricated — when there is no price anywhere', async () => {
      const { ctrl } = build({
        levelBookService: {
          lazyLoad: jest.fn().mockResolvedValue({ spot: 0, atr14: 5 }),
          getLevels: jest.fn().mockReturnValue({ spot: 0, atr14: 5 }),
        },
        srEvidenceService: {
          levelsFor: jest.fn().mockResolvedValue([]),
          candlesFor: jest.fn().mockResolvedValue([]),
        },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      expect(dto.tradePlan).toEqual({ active: null, above: null, below: null });
      expect(dto.sources.tradePlan).toBe('empty');
    });

    /**
     * Reachability, not geometry — zone-projection.spec.ts owns the maths.
     * What this pins is that a real broken zone actually travels through the
     * controller's composition into the response. Without it the builder could
     * be perfect and still never be called, exactly as the trade plan was
     * silently empty for a different reason.
     */
    it('composes a projection box from a genuinely broken zone', async () => {
      const brokenResistance = {
        id: 'z-res',
        token: '18520',
        symbol: 'CUPID',
        exchange: 'NSE',
        type: 'resistance',
        // Just under spot 100. A zone far below would put the stop so wide that
        // the next barrier cannot pay for it, and the box would correctly
        // vanish — which tests nothing about composition.
        upper: 99,
        lower: 98,
        isLine: false,
        strength: 80,
        classification: 'STRONG',
        touchCount: 4,
        lastTouchTimestamp: Date.now(),
        computedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      const { ctrl } = build({
        strongZoneDetector: { detectZones: jest.fn().mockReturnValue([brokenResistance]) },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      // Spot 100 is above the zone's upper edge, so the resistance is broken
      // and the up-side box is the one that arms.
      expect(dto.sources.projections).toBe('ok');
      expect(dto.projections.up).not.toBeNull();
      expect(dto.projections.up!.side).toBe('UP');
      expect(dto.projections.up!.breakLevel).toBe(99);
      // Reward:risk at the far edge is the floor, by construction.
      expect(dto.projections.up!.rr).toBeGreaterThanOrEqual(2);
      // Slice B fills this in; until then "no measured history" is the honest
      // answer and must never be a fabricated percentage.
      expect(dto.projections.up!.hitRate).toBeNull();
    });

    it('reports "no clear trend" as empty, not failed — the chart may state it', async () => {
      const { ctrl } = build({
        srEvidenceService: { candlesFor: jest.fn().mockResolvedValue(flatCandles) },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      expect(dto.trend).toBeNull();
      expect(dto.sources.trend).toBe('empty');
      expect(dto.status).toBe('ready');
    });

    it('degrades only the trend source when its candle fetch throws', async () => {
      const { ctrl } = build({
        srEvidenceService: {
          candlesFor: jest.fn().mockRejectedValue(new Error('broker down')),
        },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      expect(dto.sources.trend).toBe('failed');
      expect(dto.status).toBe('partial');
      expect(dto.trend).toBeNull();
      expect(dto.analysis).toEqual({ kind: 'no-setup', levels: LEVELS });
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
        srEvidenceService: {
          levelsFor: jest.fn().mockRejectedValue(boom),
          candlesFor: jest.fn().mockRejectedValue(boom),
        },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      expect(dto.status).toBe('unavailable');
      expect(dto.sources).toEqual({
        analysis: 'failed',
        zones: 'failed',
        evidence: 'failed',
        trend: 'failed',
        // A failed analysis takes the plan with it by design: with no levels
        // and no spot, "we don't know" is honest and "no trades set up" is not.
        tradePlan: 'failed',
        projections: 'failed',
      });
      expect(dto.analysis).toBeNull();
      expect(dto.zones).toEqual([]);
      expect(dto.evidence).toEqual([]);
      expect(dto.tradePlan).toEqual({ active: null, above: null, below: null });
    });

    it('empty-but-successful sources are ready with empty states', async () => {
      const { ctrl } = build({
        signalGeneratorService: {
          analyze: jest.fn().mockResolvedValue({ kind: 'no-setup', levels: null }),
        },
        strongZoneDetector: { detectZones: jest.fn().mockReturnValue([]) },
        srEvidenceService: {
          levelsFor: jest.fn().mockResolvedValue([]),
          candlesFor: jest.fn().mockResolvedValue(flatCandles),
        },
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
        tradePlan: 'empty',
        projections: 'empty',
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
      expect(deps.signalGeneratorService.analyze).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '5m', CANDLE_SOURCE);
    });
  });

  /**
   * The root cause this endpoint was fixed for: every one of its four sources
   * fetched candles through the SHARED Angel adapter, and this platform has no
   * shared feed account — `getSmartApi()` throws `Not authenticated`, the DB
   * fallback misses for indices, and the engine returned [] for every symbol on
   * every timeframe. Silently, because the throw was logged at debug.
   *
   * These tests pin the fix at the seam: candles come from the REQUESTING
   * USER's own session, and absent that manager nothing about the old path
   * changes.
   */
  describe('getChartContext — per-user candle source', () => {
    it('fetches candles through the requesting user\'s own session, not the shared adapter', async () => {
      const { ctrl, deps } = build();

      await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      // Bound to THIS user — the whole point; a source bound to anyone else
      // would be back to a shared session by another name.
      expect(deps.userFeedManager.fetchCandles).toHaveBeenCalledWith(
        'u1', '18520', 'NSE', '5m', expect.any(Date), expect.any(Date),
      );
      // The shared adapter is the thing that cannot authenticate. It must not
      // even be reached while the per-user source is serving.
      expect(deps.angelOneAdapter.getHistoricalData).not.toHaveBeenCalled();
    });

    it('hands the same source to all four loaders', async () => {
      const { ctrl, deps } = build({
        srEvidenceService: { levelsFor: jest.fn().mockResolvedValue([{ price: 105 }]) },
      });

      await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      // analysis (the anchored PDH/PDL/ORH/ORL/VWAP book), evidence and trend
      // take it as an argument; zones is the loader that fetches inline, and
      // its per-user fetch above is its evidence.
      expect(deps.signalGeneratorService.analyze).toHaveBeenCalledWith(
        '18520', 'NSE', 'CUPID', '5m', CANDLE_SOURCE,
      );
      expect(deps.srEvidenceService.levelsFor).toHaveBeenCalledWith(
        '18520', 'NSE', 'CUPID', '5m', CANDLE_SOURCE,
      );
      expect(deps.srEvidenceService.candlesFor).toHaveBeenCalledWith(
        '18520', 'NSE', 'CUPID', '5m', CANDLE_SOURCE,
      );
      expect(deps.userFeedManager.fetchCandles).toHaveBeenCalled();
    });

    // The no-regression contract: an unwired per-user feed (test containers,
    // feed-disabled deployments) must behave EXACTLY as before — shared
    // adapter, no source argument anywhere.
    it('without a per-user feed, falls back to the shared adapter and passes no source', async () => {
      const { ctrl, deps } = build({ userFeedManager: undefined });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      expect(deps.angelOneAdapter.getHistoricalData).toHaveBeenCalled();
      expect(deps.signalGeneratorService.analyze).toHaveBeenCalledWith(
        '18520', 'NSE', 'CUPID', '5m', undefined,
      );
      // levelsFor keeps its ORIGINAL 4-argument shape — the /sr-evidence route
      // shares this call site and must not see a new trailing argument.
      expect(deps.srEvidenceService.levelsFor).toHaveBeenCalledWith('18520', 'NSE', 'CUPID', '5m');
      expect(deps.srEvidenceService.candlesFor).toHaveBeenCalledWith(
        '18520', 'NSE', 'CUPID', '5m', undefined,
      );
      expect(dto.zones).toEqual([{ id: 'z1' }]);
    });

    it('degrades to the shared adapter when the per-user fetch throws', async () => {
      const { ctrl, deps } = build({
        userFeedManager: { fetchCandles: jest.fn().mockRejectedValue(new Error('no session')) },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      // Documented fallback, not an explosion: zones still compute off the
      // adapter's candles and the source stays 'ok'.
      expect(deps.angelOneAdapter.getHistoricalData).toHaveBeenCalled();
      expect(dto.zones).toEqual([{ id: 'z1' }]);
      expect(dto.sources.zones).toBe('ok');
    });

    it('degrades to the shared adapter when the per-user fetch returns nothing', async () => {
      const { ctrl, deps } = build({
        userFeedManager: { fetchCandles: jest.fn().mockResolvedValue([]) },
      });

      const dto = await ctrl.getChartContext(ADMIN, '18520', 'NSE', '5m', 'CUPID');

      expect(deps.angelOneAdapter.getHistoricalData).toHaveBeenCalled();
      expect(dto.zones).toEqual([{ id: 'z1' }]);
    });

    // Scope guard: the standalone routes are NOT part of the /chart-context
    // request path and keep their existing behaviour byte-for-byte.
    it('the standalone /zones route does not use the per-user source', async () => {
      const { ctrl, deps } = build();

      await ctrl.getZones(ADMIN, '18520', 'NSE', 'CUPID', '5m');

      expect(deps.userFeedManager.fetchCandles).not.toHaveBeenCalled();
      expect(deps.angelOneAdapter.getHistoricalData).toHaveBeenCalled();
    });
  });
});
