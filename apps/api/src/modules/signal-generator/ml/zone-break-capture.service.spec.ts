import {
  ZoneBreakCaptureService,
  ZONE_BREAK_HORIZON_BARS,
  isOffHoursIst,
} from './zone-break-capture.service';
import type { ZoneBreakCaptureInput } from './zone-break-observation.repository';
import type { OhlcvCandle } from './pattern-observation.types';

/**
 * Rising fixture: every bar's true range is exactly 3, close = 100 + i, high =
 * 102 + i, low = 99 + i. Deterministic enough to reason about any (k, m, n).
 */
function rising(n: number): OhlcvCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i * 1000, open: 100 + i, high: 102 + i, low: 99 + i, close: 100 + i, volume: 10,
  }));
}

function asHistorical(candles: OhlcvCandle[]) {
  return candles.map((c) => ({
    timestamp: new Date(c.time),
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  }));
}

const captureInput: ZoneBreakCaptureInput = {
  token: '2885', exchange: 'NSE', timeframe: '15m', side: 'UP', barTime: new Date(20 * 1000),
  zoneClassification: 'STRONG', touchCount: 3, volumeBucket: 'HIGH', htfAgreed: true,
  atrAtDetection: 2, targetDistAtr: 1.5, stopDistAtr: 1, targetSource: 'ZONE',
};

/**
 * Anchor bar 20 of `rising`, entry = 120, stored ATR 2. With the row's OWN
 * k = 1.5 and m = 1: favorable = 123, adverse = 118. Bar 21's high is exactly
 * 123 → WIN.
 */
const upPending = {
  id: 'z1', token: '2885', exchange: 'NSE', timeframe: '15m', side: 'UP',
  barTime: new Date(20 * 1000), atrAtDetection: 2, targetDistAtr: 1.5, stopDistAtr: 1,
};

function repoWith(over: Record<string, any> = {}) {
  return {
    saveMany: jest.fn().mockResolvedValue(1),
    findPending: jest.fn().mockResolvedValue([]),
    updateOutcome: jest.fn().mockResolvedValue(undefined),
    statsForSymbol: jest.fn().mockResolvedValue({ wins: 0, sample: 0 }),
    statsForCohort: jest.fn().mockResolvedValue({ wins: 0, sample: 0 }),
    ...over,
  } as any;
}

function adapterWith(candles: OhlcvCandle[]) {
  return { getHistoricalData: jest.fn().mockResolvedValue(asHistorical(candles)) } as any;
}

const SUNDAY_IST = new Date('2026-08-09T06:00:00Z'); // Sun 11:30 IST
const MONDAY_SESSION = new Date('2026-08-10T05:00:00Z'); // Mon 10:30 IST

describe('ZONE_BREAK_HORIZON_BARS', () => {
  it('matches the spec §3.4 horizons', () => {
    expect(ZONE_BREAK_HORIZON_BARS).toEqual({ '1m': 30, '5m': 24, '15m': 16, '1h': 12, '1d': 10 });
  });
});

describe('isOffHoursIst', () => {
  it('is off-hours at the weekend', () => {
    expect(isOffHoursIst(SUNDAY_IST)).toBe(true);
  });

  it('is NOT off-hours inside the weekday cash session', () => {
    expect(isOffHoursIst(MONDAY_SESSION)).toBe(false);
  });

  it('brackets the session edges', () => {
    // 09:14 IST → 03:44 UTC; 09:15 IST → 03:45 UTC; 15:31 IST → 10:01 UTC.
    expect(isOffHoursIst(new Date('2026-08-10T03:44:00Z'))).toBe(true);
    expect(isOffHoursIst(new Date('2026-08-10T03:45:00Z'))).toBe(false);
    expect(isOffHoursIst(new Date('2026-08-10T10:00:00Z'))).toBe(false);
    expect(isOffHoursIst(new Date('2026-08-10T10:01:00Z'))).toBe(true);
  });
});

describe('ZoneBreakCaptureService.capture', () => {
  it('persists the observed breaks and returns the count', async () => {
    const repo = repoWith({ saveMany: jest.fn().mockResolvedValue(2) });
    const svc = new ZoneBreakCaptureService({} as any, repo);
    await expect(svc.capture([captureInput, captureInput])).resolves.toBe(2);
    expect(repo.saveMany).toHaveBeenCalledWith([captureInput, captureInput]);
  });

  it('makes no broker call — capture is composed from what the caller already has', async () => {
    const adapter = { getHistoricalData: jest.fn() } as any;
    const svc = new ZoneBreakCaptureService(adapter, repoWith());
    await svc.capture([captureInput]);
    expect(adapter.getHistoricalData).not.toHaveBeenCalled();
  });

  it('never throws — returns 0 if the repo fails (fail-open on the chart path)', async () => {
    const repo = repoWith({ saveMany: jest.fn().mockRejectedValue(new Error('db down')) });
    const svc = new ZoneBreakCaptureService({} as any, repo);
    await expect(svc.capture([captureInput])).resolves.toBe(0);
  });

  it('nothing to capture does not hit the repo', async () => {
    const repo = repoWith();
    const svc = new ZoneBreakCaptureService({} as any, repo);
    await expect(svc.capture([])).resolves.toBe(0);
    await expect(svc.capture(null as any)).resolves.toBe(0);
    expect(repo.saveMany).not.toHaveBeenCalled();
  });
});

describe('ZoneBreakCaptureService.lookupHitRate', () => {
  const cohort = {
    timeframe: '15m', zoneClassification: 'STRONG', volumeBucket: 'HIGH', htfAgreed: true,
  };

  it('returns null when nothing has been measured — never a default', async () => {
    const svc = new ZoneBreakCaptureService({} as any, repoWith());
    await expect(svc.lookupHitRate('2885', 'NSE', '15m', cohort)).resolves.toBeNull();
  });

  it('uses the symbol scope at n >= 30 and does not read the cohort at all', async () => {
    const repo = repoWith({ statsForSymbol: jest.fn().mockResolvedValue({ wins: 18, sample: 30 }) });
    const svc = new ZoneBreakCaptureService({} as any, repo);
    await expect(svc.lookupHitRate('2885', 'NSE', '15m', cohort)).resolves.toEqual({
      pct: 60, sample: 30, scope: 'symbol',
    });
    // The well-measured case is ONE indexed read, as spec §5 requires.
    expect(repo.statsForCohort).not.toHaveBeenCalled();
  });

  it('falls back to the cohort below the threshold', async () => {
    const repo = repoWith({
      statsForSymbol: jest.fn().mockResolvedValue({ wins: 8, sample: 10 }),
      statsForCohort: jest.fn().mockResolvedValue({ wins: 90, sample: 400 }),
    });
    const svc = new ZoneBreakCaptureService({} as any, repo);
    await expect(svc.lookupHitRate('2885', 'NSE', '15m', cohort)).resolves.toEqual({
      pct: 22.5, sample: 400, scope: 'cohort',
    });
    expect(repo.statsForCohort).toHaveBeenCalledWith(cohort);
  });

  // "We could not read it" and "we have not measured it" are the same claim to a
  // trader: no number. A DB failure must not become an invented percentage.
  it('returns null when the tally cannot be read (fail-open to unknown)', async () => {
    const repo = repoWith({ statsForSymbol: jest.fn().mockRejectedValue(new Error('db down')) });
    const svc = new ZoneBreakCaptureService({} as any, repo);
    await expect(svc.lookupHitRate('2885', 'NSE', '15m', cohort)).resolves.toBeNull();
  });
});

describe('ZoneBreakCaptureService.resolvePending', () => {
  it("labels a row with its OWN k/m against the row's stored ATR", async () => {
    const repo = repoWith({ findPending: jest.fn().mockResolvedValue([upPending]) });
    const svc = new ZoneBreakCaptureService(adapterWith(rising(30)), repo);
    await expect(svc.resolvePending(10)).resolves.toBe(1);
    expect(repo.updateOutcome).toHaveBeenCalledWith('z1', 'WIN', 1);
  });

  // The reason this table is separate from pattern_observations: k is per row.
  // A fixed k = 1.5 would call this same fixture a WIN at bar 21.
  it('a wide per-row target is NOT resolved by a move that a fixed k would have won', async () => {
    const repo = repoWith({
      findPending: jest.fn().mockResolvedValue([
        { ...upPending, targetDistAtr: 10, stopDistAtr: 10 },
      ]),
    });
    const svc = new ZoneBreakCaptureService(adapterWith(rising(30)), repo);
    await expect(svc.resolvePending(10)).resolves.toBe(0);
    expect(repo.updateOutcome).not.toHaveBeenCalled();
  });

  it('reads the direction from the stored side', async () => {
    const repo = repoWith({
      findPending: jest.fn().mockResolvedValue([{ ...upPending, side: 'DOWN' }]),
    });
    const svc = new ZoneBreakCaptureService(adapterWith(rising(30)), repo);
    await svc.resolvePending(10);
    // Short from 120: adverse = 120 + 1*2 = 122, hit by bar 21's high (123),
    // long before the favorable 117 could print in a rising market.
    expect(repo.updateOutcome).toHaveBeenCalledWith('z1', 'LOSS', 0);
  });

  /**
   * Same row, same candles, same k/m — only the timeframe differs, and with it
   * the horizon. Anchor 15 (entry 115) with both levels 10 ATR away is untouched
   * either way, so the answer is decided purely by whether the horizon fits
   * inside the fetched history: 1d's 10 bars end at 25 (TIMEOUT), 15m's 16 bars
   * end at 31, past the fixture's last bar 29 (still PENDING).
   */
  describe('per-timeframe horizon', () => {
    const wide = {
      ...upPending, barTime: new Date(15 * 1000), targetDistAtr: 10, stopDistAtr: 10,
    };

    it("1d's 10-bar horizon completes inside the window → TIMEOUT", async () => {
      const repo = repoWith({
        findPending: jest.fn().mockResolvedValue([{ ...wide, timeframe: '1d' }]),
      });
      const svc = new ZoneBreakCaptureService(adapterWith(rising(30)), repo);
      await expect(svc.resolvePending(10)).resolves.toBe(1);
      expect(repo.updateOutcome).toHaveBeenCalledWith('z1', 'TIMEOUT', null);
    });

    it("15m's 16-bar horizon does not → the row stays PENDING", async () => {
      const repo = repoWith({ findPending: jest.fn().mockResolvedValue([wide]) });
      const svc = new ZoneBreakCaptureService(adapterWith(rising(30)), repo);
      await expect(svc.resolvePending(10)).resolves.toBe(0);
      expect(repo.updateOutcome).not.toHaveBeenCalled();
    });

    // Borrowing another timeframe's horizon would redefine WIN for these rows
    // against the rest of the table. Leaving them PENDING is the honest answer.
    it('refuses to label a timeframe with no spec\'d horizon', async () => {
      const repo = repoWith({
        findPending: jest.fn().mockResolvedValue([{ ...upPending, timeframe: '3m' }]),
      });
      const adapter = adapterWith(rising(30));
      const svc = new ZoneBreakCaptureService(adapter, repo);
      await expect(svc.resolvePending(10)).resolves.toBe(0);
      expect(repo.updateOutcome).not.toHaveBeenCalled();
      // And it costs nothing: the refusal happens before the broker call.
      expect(adapter.getHistoricalData).not.toHaveBeenCalled();
    });
  });

  // The adapter's cache key ignores [from,to]. A 'background' read would be
  // served whatever short window a live scan last cached (losing the break bar);
  // a 'background' write would publish this window to live consumers.
  it('fetches history on the bulk priority lane (cache-bypassing)', async () => {
    const repo = repoWith({ findPending: jest.fn().mockResolvedValue([upPending]) });
    const adapter = adapterWith(rising(30));
    const svc = new ZoneBreakCaptureService(adapter, repo);
    await svc.resolvePending(10);
    expect(adapter.getHistoricalData).toHaveBeenCalledWith(
      '2885', 'NSE', '15m', expect.any(Date), expect.any(Date), 'bulk',
    );
  });

  it('skips a row whose break bar is missing from the fetched history', async () => {
    const repo = repoWith({
      findPending: jest.fn().mockResolvedValue([{ ...upPending, barTime: new Date(999 * 1000) }]),
    });
    const svc = new ZoneBreakCaptureService(adapterWith(rising(30)), repo);
    await expect(svc.resolvePending(10)).resolves.toBe(0);
    expect(repo.updateOutcome).not.toHaveBeenCalled();
  });

  it('one failing row does not abort the rest', async () => {
    const repo = repoWith({
      findPending: jest.fn().mockResolvedValue([
        { ...upPending, id: 'bad' },
        { ...upPending, id: 'good' },
      ]),
    });
    const adapter = {
      getHistoricalData: jest
        .fn()
        .mockRejectedValueOnce(new Error('angel timeout'))
        .mockResolvedValue(asHistorical(rising(30))),
    } as any;
    const svc = new ZoneBreakCaptureService(adapter, repo);
    await expect(svc.resolvePending(10)).resolves.toBe(1);
    expect(repo.updateOutcome).toHaveBeenCalledWith('good', 'WIN', 1);
  });

  it('returns 0 when findPending itself fails', async () => {
    const repo = repoWith({ findPending: jest.fn().mockRejectedValue(new Error('db down')) });
    const svc = new ZoneBreakCaptureService({} as any, repo);
    await expect(svc.resolvePending(10)).resolves.toBe(0);
  });
});

describe('ZoneBreakCaptureService.runBackfill', () => {
  const targets = [{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }];
  const build = jest.fn(() => [captureInput]);

  beforeEach(() => build.mockClear());

  it('replays history and persists the built rows', async () => {
    const repo = repoWith({ saveMany: jest.fn().mockResolvedValue(3) });
    const adapter = adapterWith(rising(30));
    const svc = new ZoneBreakCaptureService(adapter, repo);

    const results = await svc.runBackfill(targets, build, {
      timeframes: ['15m'], now: SUNDAY_IST,
    });

    expect(results).toEqual([{ target: 'RELIANCE', timeframe: '15m', observations: 3 }]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(repo.saveMany).toHaveBeenCalledWith([captureInput]);
  });

  /**
   * The §5 constraint, and the 49d1fc1 regression it encodes: a multi-day
   * sub-hour broker window costs one chunked, rate-limited call PER DAY on the
   * queue the chart shares. During the session this pass must not exist.
   */
  it('REFUSES to run while the cash session is open — no broker call at all', async () => {
    const repo = repoWith();
    const adapter = adapterWith(rising(30));
    const svc = new ZoneBreakCaptureService(adapter, repo);

    const results = await svc.runBackfill(targets, build, {
      timeframes: ['15m'], now: MONDAY_SESSION,
    });

    expect(results).toEqual([]);
    expect(adapter.getHistoricalData).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(repo.saveMany).not.toHaveBeenCalled();
  });

  it('defaults to the real clock, so an unspecified caller is still gated', async () => {
    const repo = repoWith();
    const adapter = adapterWith(rising(30));
    const svc = new ZoneBreakCaptureService(adapter, repo);
    jest.useFakeTimers().setSystemTime(MONDAY_SESSION);
    try {
      await expect(svc.runBackfill(targets, build, { timeframes: ['15m'] })).resolves.toEqual([]);
      expect(adapter.getHistoricalData).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses the bulk lane, never the shared background cache', async () => {
    const adapter = adapterWith(rising(30));
    const svc = new ZoneBreakCaptureService(adapter, repoWith());
    await svc.runBackfill(targets, build, { timeframes: ['15m'], now: SUNDAY_IST });
    expect(adapter.getHistoricalData).toHaveBeenCalledWith(
      '2885', 'NSE', '15m', expect.any(Date), expect.any(Date), 'bulk',
    );
  });

  /**
   * Overlapping triggers must be REFUSED, not queued — queueing is what let
   * repeated heartbeats stack passes onto the historical queue in the first
   * place. Same guard, same reason as PatternBackfillService.
   */
  it('refuses a second pass while one is in flight, and does not queue it', async () => {
    let release!: (v: any) => void;
    const gate = new Promise((res) => { release = res; });
    const adapter = { getHistoricalData: jest.fn().mockReturnValue(gate) } as any;
    const repo = repoWith();
    const svc = new ZoneBreakCaptureService(adapter, repo);

    const first = svc.runBackfill(targets, build, { timeframes: ['15m'], now: SUNDAY_IST });
    expect(svc.isBackfillRunning).toBe(true);

    const second = await svc.runBackfill(targets, build, { timeframes: ['15m'], now: SUNDAY_IST });
    expect(second).toEqual([]);
    expect(adapter.getHistoricalData).toHaveBeenCalledTimes(1);

    release(asHistorical(rising(30)));
    await first;
    expect(svc.isBackfillRunning).toBe(false);
  });

  it('releases the guard even when a pass throws', async () => {
    const repo = repoWith();
    const adapter = { getHistoricalData: jest.fn().mockRejectedValue(new Error('boom')) } as any;
    const svc = new ZoneBreakCaptureService(adapter, repo);
    await svc.runBackfill(targets, build, { timeframes: ['15m'], now: SUNDAY_IST });
    expect(svc.isBackfillRunning).toBe(false);
    // A per-timeframe failure is reported as zero, not thrown.
    await expect(
      svc.runBackfill(targets, build, { timeframes: ['15m'], now: SUNDAY_IST }),
    ).resolves.toEqual([{ target: 'RELIANCE', timeframe: '15m', observations: 0 }]);
  });

  it('skips a series too short to classify a zone', async () => {
    const repo = repoWith();
    const svc = new ZoneBreakCaptureService(adapterWith(rising(10)), repo);
    const results = await svc.runBackfill(targets, build, {
      timeframes: ['15m'], now: SUNDAY_IST,
    });
    expect(results).toEqual([{ target: 'RELIANCE', timeframe: '15m', observations: 0 }]);
    expect(build).not.toHaveBeenCalled();
    expect(repo.saveMany).not.toHaveBeenCalled();
  });

  it('defaults to exactly the timeframes that have a horizon', async () => {
    const adapter = adapterWith(rising(30));
    const svc = new ZoneBreakCaptureService(adapter, repoWith());
    const results = await svc.runBackfill(targets, build, { now: SUNDAY_IST });
    expect(results.map((r) => r.timeframe)).toEqual(Object.keys(ZONE_BREAK_HORIZON_BARS));
  });
});
