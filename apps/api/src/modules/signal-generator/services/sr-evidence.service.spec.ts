import { SrEvidenceService } from './sr-evidence.service';

describe('SrEvidenceService', () => {
  const book = { spot: 140, atr14: 4, pdh: 138, pdl: 130 };
  // A realistic profile: light background across several price buckets below
  // spot, and a heavy volume SHELF at 150 (above spot 140). The shelf is many
  // times the average bucket volume → full ~40 volume score, which combined
  // with the round-number score at 150 clears the real floor (35). A flat
  // single-price fixture would collapse into one bucket and never score.
  const candles = [
    ...Array.from({ length: 16 }, (_, i) => {
      const p = 130 + (i % 3);
      return { high: p, low: p, close: p, volume: 10 };
    }),
    ...Array.from({ length: 8 }, () => ({ high: 150, low: 150, close: 150, volume: 300 })),
  ];

  function build(overrides: Partial<any> = {}) {
    const deps = {
      levelBookService: { lazyLoad: jest.fn().mockResolvedValue(book) },
      angelOneAdapter: { getHistoricalData: jest.fn().mockResolvedValue(candles) },
      marketDataRepository: {
        getInstrumentByToken: jest.fn().mockResolvedValue({ id: 'i1', symbol: 'CUPID', exchange: 'NSE' }),
        getCandles: jest.fn().mockResolvedValue([]),
      },
      zoneRepository: { findActiveByToken: jest.fn().mockResolvedValue([]) },
      oiWallService: { wallsExtended: jest.fn().mockResolvedValue([]) },
      ...overrides,
    };
    return new SrEvidenceService(
      deps.levelBookService as never,
      deps.angelOneAdapter as never,
      deps.marketDataRepository as never,
      deps.zoneRepository as never,
      deps.oiWallService as never,
    );
  }

  it('returns [] when no level book (insufficient data)', async () => {
    const s = build({ levelBookService: { lazyLoad: jest.fn().mockResolvedValue(null) } });
    expect(await s.levelsFor('18520', 'NSE', 'CUPID')).toEqual([]);
  });

  it('produces a scored resistance from a volume node above spot', async () => {
    const s = build();
    const levels = await s.levelsFor('18520', 'NSE', 'CUPID');
    const res = levels.find((l) => l.side === 'resistance' && !l.soft);
    expect(res).toBeTruthy();
    expect(res!.kinds).toContain('VOLUME');
  });

  it('includes OI walls when the symbol is F&O', async () => {
    const s = build({
      oiWallService: { wallsExtended: jest.fn().mockResolvedValue([{ price: 145, kind: 'OI_CALL', score: 30 }]) },
    });
    const levels = await s.levelsFor('99926000', 'NSE', 'NIFTY');
    expect(levels.some((l) => l.kinds.includes('OI_CALL'))).toBe(true);
  });

  // ── Regression guard: 15m path is FROZEN ────────────────────────

  it('regression: no interval ⇒ fetches 5m candles, uses book.atr14, uses DB pivots', async () => {
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(candles) };
    const zoneRepo = { findActiveByToken: jest.fn().mockResolvedValue([]) };
    const s = build({ angelOneAdapter: adapter, zoneRepository: zoneRepo });
    await s.levelsFor('18520', 'NSE', 'CUPID');
    // Candle fetch is at 5m over the proven 10-day window.
    expect(adapter.getHistoricalData).toHaveBeenCalledWith('18520', 'NSE', '5m', expect.any(Date), expect.any(Date));
    // HISTORY comes from the DB-stored zones (frozen path).
    expect(zoneRepo.findActiveByToken).toHaveBeenCalledWith('18520');
  });

  it("regression: explicit interval='15m' behaves identically to no interval", async () => {
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(candles) };
    const zoneRepo = { findActiveByToken: jest.fn().mockResolvedValue([]) };
    const s = build({ angelOneAdapter: adapter, zoneRepository: zoneRepo });
    await s.levelsFor('18520', 'NSE', 'CUPID', '15m');
    expect(adapter.getHistoricalData).toHaveBeenCalledWith('18520', 'NSE', '5m', expect.any(Date), expect.any(Date));
    expect(zoneRepo.findActiveByToken).toHaveBeenCalledWith('18520');
  });

  // ── Native non-15m path ─────────────────────────────────────────

  it("interval='5m' ⇒ fetches 5m candles natively and does NOT read the zone DB", async () => {
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(candles) };
    const zoneRepo = { findActiveByToken: jest.fn().mockResolvedValue([]) };
    const s = build({ angelOneAdapter: adapter, zoneRepository: zoneRepo });
    await s.levelsFor('18520', 'NSE', 'CUPID', '5m');
    expect(adapter.getHistoricalData).toHaveBeenCalledWith('18520', 'NSE', '5m', expect.any(Date), expect.any(Date));
    // Native path derives HISTORY from swing pivots, never the shared DB.
    expect(zoneRepo.findActiveByToken).not.toHaveBeenCalled();
  });

  it("interval='1m' ⇒ fetches 1m candles with the 1-day lookback window", async () => {
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(candles) };
    const s = build({ angelOneAdapter: adapter });
    await s.levelsFor('18520', 'NSE', 'CUPID', '1m');
    const call = adapter.getHistoricalData.mock.calls[0];
    expect(call[2]).toBe('1m');
    const from = call[3] as Date;
    const to = call[4] as Date;
    const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(1, 1); // 1-day lookback for 1m
  });

  it('caches per interval — no cross-timeframe collision', async () => {
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(candles) };
    const s = build({ angelOneAdapter: adapter });
    await s.levelsFor('18520', 'NSE', 'CUPID', '5m');
    await s.levelsFor('18520', 'NSE', 'CUPID', '1m');
    // Different interval keys ⇒ both recompute ⇒ two fetches with distinct intervals.
    const intervals = adapter.getHistoricalData.mock.calls.map((c) => c[2]);
    expect(intervals).toContain('5m');
    expect(intervals).toContain('1m');
    // A repeat of the same interval hits the cache (no extra fetch).
    adapter.getHistoricalData.mockClear();
    await s.levelsFor('18520', 'NSE', 'CUPID', '5m');
    expect(adapter.getHistoricalData).not.toHaveBeenCalled();
  });
});
