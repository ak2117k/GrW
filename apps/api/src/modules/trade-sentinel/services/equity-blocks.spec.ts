import {
  CASH_OI_WALLS_REASON,
  PRICE_BAND_UNSEEN,
  RELATIVE_VOLUME_UNSEEN,
  SQUARE_OFF_DEFAULT_MIN_IST,
  equityBlockEnabled,
  equityBlocks,
  isCashSegment,
  parseSquareOffIst,
  type EquityBlockInput,
  type EquityTickInputs,
} from './equity-blocks';
import { eventsBlocks } from './news-events-blocks';

// Thursday 2026-10-29, 11:00 IST.
const NOW = new Date('2026-10-29T05:30:00Z');
const istIso = (hhmm: string, ymd = '2026-10-29') => new Date(Date.parse(`${ymd}T${hhmm}:00.000Z`) - 19_800_000);
const weekdayClock = {
  isTradingDay: (_ex: string, at: Date = new Date()) => {
    const d = new Date(at.getTime() + 19_800_000).getUTCDay();
    return d !== 0 && d !== 6;
  },
  tradingWindow: () => ({ openMin: 9 * 60 + 15, closeMin: 15 * 60 + 30 }),
};
const book = (over: Record<string, unknown> = {}) => ({
  available: true as const,
  value: { pdh: 110, pdl: 95, orh: 104, orl: 100, prevOrh: null, prevOrl: null, vwap: 102, todayHigh: 106, todayLow: 100, atr14: 5, interval: '15m', ...over },
  source: 'signal-generator.analyze (15m level book)',
  at: '2026-10-29T05:29:30.000Z',
});
const inputs = (over: Partial<EquityTickInputs> = {}): EquityTickInputs => ({
  day: { ok: true, open: 101, prevClose: 100, at: '2026-10-29T05:29:59.000Z', source: 'market-hub day bar (broker-reported)' },
  nifty: { ok: true, ltp: 24_240, prevClose: 24_000, at: '2026-10-29T05:29:59.000Z', source: 'live level book (NIFTY live feed tick)' },
  niftyAtEntry: { ok: true, close: 24_000, at: '2026-10-29T04:00:00.000Z', source: 'hub candles_1m NIFTY bar at entry' },
  ...over,
});
const base = (over: Partial<EquityBlockInput> = {}): EquityBlockInput => ({
  segment: 'EQ_INTRADAY',
  side: 'LONG',
  exchange: 'NSE',
  symbol: 'KEI-EQ',
  ltp: 104,
  entryPrice: 100,
  peak: 105,
  levelBook: book(),
  noise: { n: 0.25, method: 'atr14-1m', bars: 40, at: '2026-10-29T05:29:00.000Z' },
  inputs: inputs(),
  events: null,
  stockMove: null,
  stockMoveShown: false,
  now: NOW,
  clock: weekdayClock,
  squareOffMin: SQUARE_OFF_DEFAULT_MIN_IST,
  ...over,
});

describe('equity-blocks', () => {
  describe('switch and parsing', () => {
    it('SENTINEL_EQUITY_BLOCK: on unless exactly false; off without a config', () => {
      const cfg = (v?: string) => ({ get: () => v });
      expect(equityBlockEnabled(undefined)).toBe(false);
      expect(equityBlockEnabled(cfg(undefined))).toBe(true);
      expect(equityBlockEnabled(cfg('true'))).toBe(true);
      expect(equityBlockEnabled(cfg(' FALSE '))).toBe(false);
    });
    it('square-off time: HH:MM inside the session, else 15:15', () => {
      expect(parseSquareOffIst(undefined)).toBe(15 * 60 + 15);
      expect(parseSquareOffIst('15:20')).toBe(15 * 60 + 20);
      expect(parseSquareOffIst('16:00')).toBe(15 * 60 + 15);
      expect(parseSquareOffIst('nonsense')).toBe(15 * 60 + 15);
    });
    it('cash segments only', () => {
      expect(isCashSegment('EQ_INTRADAY')).toBe(true);
      expect(isCashSegment('EQ_DELIVERY')).toBe(true);
      expect(isCashSegment('OPT')).toBe(false);
      expect(isCashSegment('FUT')).toBe(false);
    });
  });

  describe('F1 squareOff', () => {
    it('minutes to 15:15 IST, not the 15:30 close, with the MIS assumption stated', () => {
      const b = equityBlocks(base()).squareOff;
      expect(b).toMatchObject({ available: true, value: 255 });
      expect(b.available && b.source).toMatch(/assumed MIS/i);
    });
    it('before the open, past the square-off, a delivery holding and a holiday are each a stated absence', () => {
      expect(equityBlocks(base({ now: istIso('09:00') })).squareOff).toEqual({ available: false, reason: expect.stringMatching(/before the open/) });
      expect(equityBlocks(base({ now: istIso('15:16') })).squareOff).toEqual({ available: false, reason: expect.stringMatching(/past 15:15/) });
      expect(equityBlocks(base({ segment: 'EQ_DELIVERY' })).squareOff).toEqual({ available: false, reason: expect.stringMatching(/CNC/) });
      expect(equityBlocks(base({ clock: { ...weekdayClock, isTradingDay: () => false } })).squareOff).toEqual({
        available: false,
        reason: expect.stringMatching(/not a trading day/),
      });
    });
  });

  describe('F3 vwap', () => {
    it('distance in N, positive on the position side', () => {
      expect(equityBlocks(base()).vwap).toMatchObject({ available: true, value: { vwap: 102, gapRupees: 2, gapN: 8 } });
      expect(equityBlocks(base({ side: 'SHORT' })).vwap).toMatchObject({ value: { gapRupees: -2, gapN: -8 } });
    });
    it('no noise unit and no daily ATR ⇒ absent, naming the raw rupee gap', () => {
      const b = equityBlocks(base({ noise: null, levelBook: book({ atr14: 0 }) })).vwap;
      expect(b).toEqual({ available: false, reason: expect.stringContaining('₹2') });
    });
    it('no noise unit ⇒ falls back to the daily ATR / √375 and says so', () => {
      const b = equityBlocks(base({ noise: null })).vwap;
      expect(b).toMatchObject({ available: true, value: { gapN: Math.round((2 / (5 / Math.sqrt(375))) * 10) / 10 } });
      expect(b.available && b.source).toMatch(/√375/);
    });
    it('no level book ⇒ absent, never 0', () => {
      expect(equityBlocks(base({ levelBook: { available: false, reason: 'x' } })).vwap.available).toBe(false);
    });
  });

  describe('F4 dayRange', () => {
    it('range used in ATRd with the regime, the gap, the move from entry and the pullback in N', () => {
      expect(equityBlocks(base()).dayRange).toMatchObject({
        available: true,
        value: { atrDaily: 5, rangeUsedAtr: 1.2, regime: 'EXPANDED', gapAtr: 0.2, fromEntryAtr: 0.8, pullbackFromPeakN: 4 },
      });
    });
    it('regime cut-offs', () => {
      const regime = (lo: number, hi: number) => {
        const b = equityBlocks(base({ levelBook: book({ todayLow: lo, todayHigh: hi }) })).dayRange;
        return b.available ? b.value.regime : null;
      };
      expect(regime(100, 102)).toBe('QUIET');
      expect(regime(100, 105)).toBe('NORMAL');
      expect(regime(100, 108)).toBe('EXPANDED');
      expect(regime(100, 110)).toBe('BIG-MOVE DAY');
    });
    it('a missing day bar leaves gapAtr null WITH its reason', () => {
      const b = equityBlocks(base({ inputs: inputs({ day: { ok: false, reason: 'no day bar for KEI-EQ' } }) })).dayRange;
      expect(b).toMatchObject({ available: true, value: { gapAtr: null, unseen: ['gapAtr: no day bar for KEI-EQ'] } });
    });
    it('a short reads the move from entry and the pullback from its own side', () => {
      const b = equityBlocks(base({ side: 'SHORT', ltp: 97, peak: 96 })).dayRange;
      expect(b).toMatchObject({ value: { fromEntryAtr: 0.6, pullbackFromPeakN: 4 } });
    });
    it('no daily ATR ⇒ absent', () => {
      expect(equityBlocks(base({ levelBook: book({ atr14: null }) })).dayRange).toEqual({ available: false, reason: expect.stringMatching(/ATR14/) });
    });
  });

  describe('F5 relativeStrength', () => {
    it('stock vs NIFTY today and since entry, beta-unadjusted, in ATRd', () => {
      // Stock +4 % since entry and today, NIFTY +1 %: 3 % gap / 5 % ATR = 0.6 ATRd ⇒ STOCK-SPECIFIC.
      const b = equityBlocks(base()).relativeStrength;
      expect(b).toMatchObject({
        available: true,
        value: {
          today: { stockPct: 4, niftyPct: 1, rsAtr: 0.6 },
          sinceEntry: { stockPct: 4, niftyPct: 1, rsAtr: 0.6, label: 'STOCK-SPECIFIC' },
        },
      });
      expect(b.available && b.source).toMatch(/beta-unadjusted/);
    });
    it('NIFTY explaining the move ⇒ MARKET-DRIVEN; the since-entry gap is position-relative', () => {
      const b = equityBlocks(base({ side: 'SHORT', ltp: 99.1, inputs: inputs({ nifty: { ok: true, ltp: 23_784, prevClose: 24_000, at: 'x', source: 's' } }) })).relativeStrength;
      expect(b).toMatchObject({ value: { sinceEntry: { stockPct: -0.9, niftyPct: -0.9, label: 'MARKET-DRIVEN' } } });
    });
    it('no fresh NIFTY ⇒ absent with the reason', () => {
      const b = equityBlocks(base({ inputs: inputs({ nifty: { ok: false, reason: 'hub NIFTY is 40 s old' } }) })).relativeStrength;
      expect(b).toEqual({ available: false, reason: expect.stringContaining('hub NIFTY is 40 s old') });
    });
    it('no NIFTY bar at entry ⇒ the day leg only, the since-entry leg null with its reason', () => {
      const b = equityBlocks(base({ inputs: inputs({ niftyAtEntry: { ok: false, reason: 'no NIFTY 1-minute bar at entry' } }) })).relativeStrength;
      expect(b).toMatchObject({ available: true, value: { sinceEntry: null, today: { rsAtr: 0.6 } } });
      expect(b.available && b.value.unseen).toContain('sinceEntry: no NIFTY 1-minute bar at entry');
    });
  });

  describe('F7 eventRisk', () => {
    const peek = (events: Array<Record<string, unknown>>) =>
      eventsBlocks({ status: 'ok', events: events as never, minutesToNextHighImpact: null, noHighImpactReason: null, notes: [], fetchedAt: null }, NOW.toISOString(), 3);

    it('both sources off ⇒ UNSEEN, not none', () => {
      expect(equityBlocks(base()).eventRisk).toEqual({ available: false, reason: expect.stringMatching(/UNSEEN, not none/) });
    });
    it('calendar read and empty ⇒ a real finding: NONE', () => {
      expect(equityBlocks(base({ events: peek([]) })).eventRisk).toMatchObject({ available: true, value: { when: 'NONE', event: null } });
    });
    it('an all-day board meeting today ⇒ time not announced', () => {
      const ev = { kind: 'results', scope: 'company', title: 'KEI financial results: Q2', atIst: '2026-10-29 (time not announced)', minutesAway: 0, impact: 'high', source: 'NSE', id: 'a', allDay: true };
      expect(equityBlocks(base({ events: peek([ev]) })).eventRisk).toMatchObject({ value: { when: 'TODAY-TIME-NOT-ANNOUNCED', event: 'KEI financial results: Q2' } });
    });
    it('a timed event after the close today, and one tomorrow', () => {
      const late = { kind: 'results', scope: 'company', title: 'late', atIst: '2026-10-29 16:00 IST', minutesAway: 300, impact: 'high', source: 'x', id: 'b', allDay: false };
      expect(equityBlocks(base({ events: peek([late]) })).eventRisk).toMatchObject({ value: { when: 'TODAY-AFTER-CLOSE' } });
      const tomorrow = { kind: 'ex_dividend', scope: 'company', title: 'KEI ex-date', atIst: '2026-10-30 (time not announced)', minutesAway: 1335, impact: 'medium', source: 'x', id: 'c', allDay: true };
      expect(equityBlocks(base({ events: peek([tomorrow]) })).eventRisk).toMatchObject({ value: { when: 'NEXT-SESSION' } });
    });
    it('market-scope events are not company risk', () => {
      const rbi = { kind: 'rbi', scope: 'market', title: 'RBI policy', atIst: '2026-10-29 10:00 IST', minutesAway: 60, impact: 'high', source: 'x', id: 'd', allDay: false };
      expect(equityBlocks(base({ events: peek([rbi]) })).eventRisk).toMatchObject({ value: { when: 'NONE' } });
    });
    it('the stock-move book alone: its results date (Monday after a Friday is the next session)', () => {
      const fri = new Date('2026-10-30T05:30:00Z');
      const sm = { s: 'KEI', h: '5d', p: 0.7, b: 'TOP20', results: '2026-11-02', inWindow: true, asOf: '2026-10-29' };
      expect(equityBlocks(base({ now: fri, stockMove: sm, stockMoveShown: true })).eventRisk).toMatchObject({
        available: true,
        value: { when: 'NEXT-SESSION', event: 'KEI results (stock-move book)' },
      });
    });
  });

  it('priceBand and relativeVolume are always stated unseen, and the OI reason is the cash one', () => {
    const b = equityBlocks(base());
    expect(b.priceBand).toEqual({ available: false, reason: PRICE_BAND_UNSEEN });
    expect(b.relativeVolume).toEqual({ available: false, reason: RELATIVE_VOLUME_UNSEEN });
    expect(CASH_OI_WALLS_REASON).toMatch(/not captured for cash positions/);
  });

  it('the block stays JSON (no undefined, no NaN)', () => {
    const b = equityBlocks(base({ noise: null, peak: null, inputs: null }));
    const json = JSON.stringify(b);
    expect(json).not.toMatch(/NaN|Infinity/);
    expect(JSON.parse(json)).toEqual(b);
  });
});
