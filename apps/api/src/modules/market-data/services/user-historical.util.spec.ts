import {
  TIMEFRAME_MAP,
  TIMEFRAME_MAX_RANGE_DAYS,
  formatAngelDateTime,
  mapCandleRows,
  mapFullQuote,
  buildChunkWindows,
} from './user-historical.util';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('user-historical.util', () => {
  describe('const maps (kept in sync with angel-one-adapter)', () => {
    it('maps timeframes to Angel intervals', () => {
      expect(TIMEFRAME_MAP['1m']).toBe('ONE_MINUTE');
      expect(TIMEFRAME_MAP['1d']).toBe('ONE_DAY');
      expect(TIMEFRAME_MAP['1h']).toBe('ONE_HOUR');
    });

    it('caps sub-hour intervals to 1 day and widens hour/day', () => {
      expect(TIMEFRAME_MAX_RANGE_DAYS.ONE_MINUTE).toBe(1);
      expect(TIMEFRAME_MAX_RANGE_DAYS.FIFTEEN_MINUTE).toBe(1);
      expect(TIMEFRAME_MAX_RANGE_DAYS.ONE_HOUR).toBe(365);
      expect(TIMEFRAME_MAX_RANGE_DAYS.ONE_DAY).toBe(1800);
    });
  });

  describe('formatAngelDateTime', () => {
    it('formats a UTC instant as IST (+5:30) wall-clock', () => {
      // 04:00 UTC + 5:30 = 09:30 IST on the same day.
      const utc = new Date('2026-05-15T04:00:00.000Z');
      expect(formatAngelDateTime(utc)).toBe('2026-05-15 09:30');
    });

    it('rolls the date forward when IST offset crosses midnight', () => {
      // 20:00 UTC + 5:30 = 01:30 IST next day.
      const utc = new Date('2026-05-15T20:00:00.000Z');
      expect(formatAngelDateTime(utc)).toBe('2026-05-16 01:30');
    });
  });

  describe('mapCandleRows', () => {
    it('maps [ts,o,h,l,c,v] rows to Candle objects', () => {
      const rows = [
        ['2026-05-15T09:15:00+05:30', '100', '110', '90', '105', '1000'],
        ['2026-05-15T09:16:00+05:30', 105, 108, 104, 106, 500],
      ];
      const candles = mapCandleRows(rows);
      expect(candles).toHaveLength(2);
      expect(candles[0].open).toBe(100);
      expect(candles[0].high).toBe(110);
      expect(candles[0].low).toBe(90);
      expect(candles[0].close).toBe(105);
      expect(candles[0].volume).toBe(1000);
      expect(candles[0].timestamp).toBeInstanceOf(Date);
      expect(candles[1].close).toBe(106);
    });

    it('returns [] for null / non-array input', () => {
      expect(mapCandleRows(null as any)).toEqual([]);
      expect(mapCandleRows(undefined as any)).toEqual([]);
      expect(mapCandleRows([])).toEqual([]);
    });
  });

  describe('buildChunkWindows', () => {
    it('returns a single window when the range fits within maxRange', () => {
      const from = 0;
      const to = 8 * 60 * 60 * 1000; // 8h
      const windows = buildChunkWindows(from, to, DAY_MS);
      expect(windows).toHaveLength(1);
      expect(windows[0]).toEqual({ start: from, end: to });
    });

    it('slices a 5-day range into 5 one-day windows (oldest→newest, contiguous)', () => {
      const from = 0;
      const to = 5 * DAY_MS;
      const windows = buildChunkWindows(from, to, DAY_MS);
      expect(windows).toHaveLength(5);
      expect(windows[0].start).toBe(0);
      expect(windows[4].end).toBe(to);
      // contiguous, ascending
      for (let i = 1; i < windows.length; i++) {
        expect(windows[i].start).toBe(windows[i - 1].end);
      }
    });
  });

  describe('mapFullQuote', () => {
    it('maps the first fetched entry to a Quote', () => {
      const fetched = [
        {
          symbolToken: '2885',
          tradingSymbol: 'RELIANCE-EQ',
          ltp: 1500.5,
          open: 1490,
          high: 1510,
          low: 1485,
          close: 1495,
          tradeVolume: 123456,
          opnInterest: 789,
        },
      ];
      const q = mapFullQuote(fetched, '2885');
      expect(q).not.toBeNull();
      expect(q!.token).toBe('2885');
      expect(q!.symbol).toBe('RELIANCE-EQ');
      expect(q!.ltp).toBe(1500.5);
      expect(q!.open).toBe(1490);
      expect(q!.high).toBe(1510);
      expect(q!.low).toBe(1485);
      expect(q!.close).toBe(1495);
      expect(q!.volume).toBe(123456);
      expect(q!.oi).toBe(789);
      expect(q!.timestamp).toBeInstanceOf(Date);
    });

    it('falls back to the passed token and omits oi when absent', () => {
      const fetched = [{ ltp: 10, tradingsymbol: 'X', volume: 5 }];
      const q = mapFullQuote(fetched, '999');
      expect(q!.token).toBe('999');
      expect(q!.symbol).toBe('X');
      expect(q!.volume).toBe(5);
      expect(q!.oi).toBeUndefined();
    });

    it('returns null for empty / missing fetched', () => {
      expect(mapFullQuote([], '1')).toBeNull();
      expect(mapFullQuote(null, '1')).toBeNull();
      expect(mapFullQuote(undefined, '1')).toBeNull();
    });
  });
});
