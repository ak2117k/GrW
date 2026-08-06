import {
  AGGREGATED_MIN_LOOKBACK_DAYS,
  AGGREGATED_TIMEFRAMES,
  TIMEFRAME_MAP,
  TIMEFRAME_MAX_RANGE_DAYS,
  aggregateCandles,
  formatAngelDateTime,
  istBucketStart,
  mapCandleRows,
  mapFullQuote,
  buildChunkWindows,
  type Candle,
} from './user-historical.util';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a daily bar from an ISO instant. Values are distinct per bar so a
 * mis-ordered or mis-bucketed roll-up shows up as a wrong number, not a tie.
 */
function bar(iso: string, o: number, h: number, l: number, c: number, v: number): Candle {
  return { timestamp: new Date(iso), open: o, high: h, low: l, close: c, volume: v };
}

/** IST midnight of the given IST calendar date, as an absolute instant. */
function istMidnight(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000+05:30`);
}

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

  describe('istBucketStart', () => {
    it('anchors a week to IST Monday midnight, not UTC', () => {
      // 04:00 UTC = 09:30 IST on Mon 3 Aug — market open on the first day of
      // the week; the bucket is that same Monday.
      expect(istBucketStart(new Date('2026-08-03T04:00:00.000Z'), 'week')).toBe(
        istMidnight('2026-08-03'),
      );
    });

    it('keeps an IST-midnight bar out of the previous UTC week', () => {
      // Angel stamps daily bars at 00:00 IST = 18:30 UTC the PREVIOUS day. Read
      // as UTC this is Sun 2 Aug and lands a week early.
      expect(istBucketStart(new Date('2026-08-02T18:30:00.000Z'), 'week')).toBe(
        istMidnight('2026-08-03'),
      );
    });

    it('walks back into the previous month for a mid-month-start week', () => {
      // Wed 2 Sep belongs to the week starting Mon 31 Aug.
      expect(istBucketStart(new Date('2026-09-02T04:00:00.000Z'), 'week')).toBe(
        istMidnight('2026-08-31'),
      );
    });

    it('anchors a month to the IST 1st', () => {
      expect(istBucketStart(new Date('2026-08-31T18:30:00.000Z'), 'month')).toBe(
        istMidnight('2026-09-01'),
      );
    });
  });

  describe('aggregateCandles', () => {
    it('returns [] for empty / non-array input', () => {
      expect(aggregateCandles([], 'week')).toEqual([]);
      expect(aggregateCandles([], 'month')).toEqual([]);
      expect(aggregateCandles(null as any, 'week')).toEqual([]);
    });

    it('rolls OHLCV up correctly within one week', () => {
      const weekly = aggregateCandles(
        [
          bar('2026-08-03T00:00:00+05:30', 100, 112, 98, 105, 1000),
          bar('2026-08-04T00:00:00+05:30', 105, 120, 103, 118, 2000),
          bar('2026-08-05T00:00:00+05:30', 118, 119, 90, 95, 3000),
        ],
        'week',
      );
      expect(weekly).toHaveLength(1);
      expect(weekly[0].open).toBe(100); // first bar's open
      expect(weekly[0].high).toBe(120); // max
      expect(weekly[0].low).toBe(90); // min
      expect(weekly[0].close).toBe(95); // last bar's close
      expect(weekly[0].volume).toBe(6000); // sum
      expect(weekly[0].timestamp.getTime()).toBe(istMidnight('2026-08-03'));
    });

    it('splits weeks across a month boundary on the IST Monday', () => {
      const weekly = aggregateCandles(
        [
          bar('2026-08-27T00:00:00+05:30', 10, 11, 9, 10.5, 100), // Thu, wk 24 Aug
          bar('2026-08-31T00:00:00+05:30', 11, 15, 11, 14, 200), // Mon, new week
          bar('2026-09-01T00:00:00+05:30', 14, 16, 13, 13.5, 300), // still that week
          bar('2026-09-04T00:00:00+05:30', 13.5, 14, 12, 12.5, 400), // Fri, same week
          bar('2026-09-07T00:00:00+05:30', 12.5, 13, 12, 12.8, 500), // Mon, next week
        ],
        'week',
      );
      expect(weekly.map((c) => c.timestamp.getTime())).toEqual([
        istMidnight('2026-08-24'),
        istMidnight('2026-08-31'),
        istMidnight('2026-09-07'),
      ]);
      // The 31 Aug week spans the month boundary: open from Aug, close from Sep.
      expect(weekly[1].open).toBe(11);
      expect(weekly[1].close).toBe(12.5);
      expect(weekly[1].high).toBe(16);
      expect(weekly[1].low).toBe(11);
      expect(weekly[1].volume).toBe(900);
    });

    it('buckets months on the IST calendar', () => {
      const monthly = aggregateCandles(
        [
          bar('2026-08-03T00:00:00+05:30', 100, 110, 95, 108, 10),
          bar('2026-08-31T00:00:00+05:30', 108, 130, 107, 125, 20),
          bar('2026-09-01T00:00:00+05:30', 125, 126, 120, 121, 30),
          bar('2026-09-30T00:00:00+05:30', 121, 122, 100, 101, 40),
        ],
        'month',
      );
      expect(monthly).toHaveLength(2);
      expect(monthly[0].timestamp.getTime()).toBe(istMidnight('2026-08-01'));
      expect(monthly[0].open).toBe(100);
      expect(monthly[0].close).toBe(125);
      expect(monthly[0].high).toBe(130);
      expect(monthly[0].low).toBe(95);
      expect(monthly[0].volume).toBe(30);
      expect(monthly[1].timestamp.getTime()).toBe(istMidnight('2026-09-01'));
      expect(monthly[1].close).toBe(101);
      expect(monthly[1].low).toBe(100);
    });

    it('emits the partial trailing bucket (the forming bar)', () => {
      // Mon+Tue only: the week is still running, and the chart must show it.
      const weekly = aggregateCandles(
        [
          bar('2026-07-27T00:00:00+05:30', 5, 6, 4, 5.5, 10),
          bar('2026-07-31T00:00:00+05:30', 5.5, 7, 5, 6.5, 10),
          bar('2026-08-03T00:00:00+05:30', 6.5, 8, 6, 7, 10),
          bar('2026-08-04T00:00:00+05:30', 7, 9, 6.8, 8.5, 10),
        ],
        'week',
      );
      expect(weekly).toHaveLength(2);
      expect(weekly[1].timestamp.getTime()).toBe(istMidnight('2026-08-03'));
      expect(weekly[1].close).toBe(8.5);
      expect(weekly[1].volume).toBe(20);
    });

    it('sorts unsorted input before bucketing', () => {
      const shuffled = [
        bar('2026-08-05T00:00:00+05:30', 118, 119, 90, 95, 3000),
        bar('2026-08-03T00:00:00+05:30', 100, 112, 98, 105, 1000),
        bar('2026-08-11T00:00:00+05:30', 95, 96, 80, 82, 500),
        bar('2026-08-04T00:00:00+05:30', 105, 120, 103, 118, 2000),
      ];
      const weekly = aggregateCandles(shuffled, 'week');
      expect(weekly).toHaveLength(2);
      expect(weekly[0].open).toBe(100);
      expect(weekly[0].close).toBe(95);
      expect(weekly[1].timestamp.getTime()).toBe(istMidnight('2026-08-10'));
      expect(weekly[1].close).toBe(82);
      // Input array is not mutated.
      expect(shuffled[0].timestamp.getTime()).toBe(Date.parse('2026-08-05T00:00:00+05:30'));
    });

    it('omits buckets with no trading days rather than zero-filling', () => {
      const weekly = aggregateCandles(
        [
          bar('2026-08-03T00:00:00+05:30', 1, 2, 1, 2, 10),
          // No bars at all in the week of 10 Aug (suspended / holiday week).
          bar('2026-08-17T00:00:00+05:30', 2, 3, 2, 3, 10),
        ],
        'week',
      );
      expect(weekly.map((c) => c.timestamp.getTime())).toEqual([
        istMidnight('2026-08-03'),
        istMidnight('2026-08-17'),
      ]);
    });
  });

  describe('aggregated-timeframe maps', () => {
    it('routes 1w/1mo to local roll-up with a widened daily lookback', () => {
      expect(AGGREGATED_TIMEFRAMES['1w']).toBe('week');
      expect(AGGREGATED_TIMEFRAMES['1mo']).toBe('month');
      // Not Angel intervals — they must NOT leak into TIMEFRAME_MAP.
      expect(TIMEFRAME_MAP['1w']).toBeUndefined();
      expect(TIMEFRAME_MAP['1mo']).toBeUndefined();
      expect(AGGREGATED_MIN_LOOKBACK_DAYS['1w']).toBe(5 * 365);
      expect(AGGREGATED_MIN_LOOKBACK_DAYS['1mo']).toBe(15 * 365);
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
